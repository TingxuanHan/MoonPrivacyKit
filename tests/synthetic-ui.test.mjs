import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbenchServer } from '../runtime/workbench-server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url)), scratch = mkdtempSync(join(tmpdir(), 'mpk-synthetic-ui-'));
const artifacts = resolve(process.env.UI_ARTIFACTS_DIR || join(root, 'reports/ui'));
let server, origin, browser, page, session;
const errors = [], external = [], writes = [];
before(async () => {
  mkdirSync(artifacts, { recursive: true });
  server = createWorkbenchServer({ root, dataDir: join(scratch, 'projects') });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${server.address().port}`;
  session = (await (await fetch(origin + '/api/session')).json()).data.token;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
});
after(async () => { await browser?.close(); await new Promise(r => server?.close(r)); });
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1365, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); if (request.method() === 'POST') writes.push(request.url()); });
  await open();
});
afterEach(async () => { await page.close(); });
const click = name => page.getByRole('button', { name, exact: true }).click();
const source = (data = 'person,group,choice,secret\nsecret-a,student,yes,salary-a\nsecret-b,staff,no,salary-b\n') => ({ name: 'source.csv', mimeType: 'text/csv', buffer: Buffer.from(data) });
async function open() { await page.goto(origin); await click('合成数据'); await page.locator('#view-synthetic .notice').filter({ hasText: '合成工具已就绪。' }).waitFor(); }
async function api(path, body) {
  const response = await fetch(origin + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { origin, 'x-moonprivacykit-token': session, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); assert.equal(data.ok, true, JSON.stringify(data)); return data.data;
}
async function select(project) { await click('刷新合成项目'); await page.getByLabel('合成数据所属项目').selectOption(project.id); await page.locator('#synthetic-budget').filter({ hasText: '剩余预算' }).waitFor(); }
async function save(label) { const promise = page.waitForEvent('download'); await click(label); return readFileSync(await (await promise).path(), 'utf8'); }

test('guided synthesis, persisted exports and shared report history work without resampling', async () => {
  await page.getByText('新建合成项目', { exact: true }).click();
  await page.getByLabel('合成项目名称', { exact: true }).fill('演示合成'); await click('创建合成项目');
  await page.locator('#synthetic-budget').filter({ hasText: '剩余预算 ε 3' }).waitFor();
  await page.getByLabel('生成行数（事先指定）').fill('80');
  await page.getByLabel('原始分类表（CSV 或 JSON）').setInputFiles(source());
  await page.screenshot({ path: join(artifacts, 'synthetic-editor-desktop.png'), fullPage: true });
  await click('生成并保存合成数据'); await page.getByRole('heading', { name: '合成数据已保存' }).waitFor();
  await page.locator('#synthetic-budget').filter({ hasText: '剩余预算 ε 2' }).waitFor();
  const before = writes.length, csv = await save('下载合成 CSV'), record = await save('下载完整生成记录');
  assert.equal(await save('下载合成 CSV'), csv); assert.equal(await save('下载完整生成记录'), record);
  assert.equal(JSON.parse(record).synthetic.rows.length, 80); assert.ok(!record.includes('secret-a') && !record.includes('salary-'));
  assert.equal(csv, JSON.parse(record).synthetic.csv); assert.equal(writes.length, before);
  await page.locator('#synthetic-result').screenshot({ path: join(artifacts, 'synthetic-result-desktop.png') });
  const projectId = await page.getByLabel('合成数据所属项目').inputValue(), state = await api(`projects/${projectId}/status`);
  await open(); await select({ id: projectId }); await click('打开这份合成数据');
  assert.equal(await save('下载完整生成记录'), record);
  await click('隐私统计'); await page.locator('#stats-refresh').click(); await page.locator('#stats-project').selectOption(projectId);
  await click('历史报告'); await page.locator('#stats-history').getByRole('button').first().click();
  assert.equal(await save('下载合成 CSV'), csv);
  assert.deepEqual(await api(`projects/${projectId}/status`), state);
});

test('a lost successful response recovers after reload without retaining the source or spending again', async () => {
  const project = await api('projects', { name: '恢复合成', totalEpsilon: '1' }); await select(project);
  await page.getByLabel('原始分类表（CSV 或 JSON）').setInputFiles(source());
  await page.route('**/publish-synthetic', async route => { await route.fetch(); await route.abort(); });
  await click('生成并保存合成数据'); await page.locator('#view-synthetic .notice.error').waitFor();
  const before = await api(`projects/${project.id}/status`); assert.equal(before.release_count, 1);
  const pending = await page.evaluate(() => sessionStorage.getItem('moonprivacykit.synthetic.pending.v1'));
  assert.deepEqual(Object.keys(JSON.parse(pending)).sort(), ['projectId', 'requestId']); assert.ok(!pending.includes('secret-'));
  await page.unroute('**/publish-synthetic'); await open(); await click('恢复待确认合成数据');
  await page.getByRole('heading', { name: '合成数据已保存' }).waitFor();
  const result = await save('下载完整生成记录');
  assert.equal(JSON.stringify(await api(`projects/${project.id}/releases/${JSON.parse(pending).requestId}`)), JSON.stringify(JSON.parse(result)));
  assert.deepEqual(await api(`projects/${project.id}/status`), before);
});

test('invalid source and ambiguous public config fail before spending, and mobile controls remain usable', async () => {
  const project = await api('projects', { name: '校验合成', totalEpsilon: '1' }); await select(project);
  const before = writes.length;
  await page.getByLabel('原始分类表（CSV 或 JSON）').setInputFiles(source('person,group,choice\na,private-unknown,yes\n'));
  await click('生成并保存合成数据'); await page.locator('#view-synthetic .notice.error').waitFor();
  assert.ok(!(await page.locator('#view-synthetic .notice.error').innerText()).includes('private-unknown'));
  assert.equal(writes.length, before);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('moonprivacykit.synthetic.pending.v1')), null);
  await page.getByText('保存或导入公开配置', { exact: true }).click();
  const config = await save('保存公开合成配置');
  await page.getByLabel('导入公开合成配置').setInputFiles({ name: 'ambiguous.json', mimeType: 'application/json', buffer: Buffer.from(config.replace('"schema_version": 1', '"schema_version": 1,"schema_version": 2')) });
  await page.locator('#view-synthetic .notice.error').waitFor();
  assert.equal(await save('保存公开合成配置'), config);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('原始分类表（CSV 或 JSON）').setInputFiles(source());
  await page.screenshot({ path: join(artifacts, 'synthetic-editor-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const action = page.getByRole('button', { name: '生成并保存合成数据', exact: true });
  await action.focus(); await page.keyboard.press('Enter'); await page.getByRole('heading', { name: '合成数据已保存' }).waitFor();
  await page.screenshot({ path: join(artifacts, 'synthetic-result-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await click('准备下一次合成'); await click('生成并保存合成数据'); await page.locator('#view-synthetic .notice.error').waitFor();
  assert.match(await page.locator('#view-synthetic .notice.error').innerText(), /剩余预算不足/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('moonprivacykit.synthetic.pending.v1')), null);
  assert.equal((await api(`projects/${project.id}/status`)).release_count, 1);
});

test('synthetic browser workflows emit no console errors or external requests', () => {
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
