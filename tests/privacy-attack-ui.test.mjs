import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbenchServer } from '../runtime/workbench-server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url)), scratch = mkdtempSync(join(tmpdir(), 'mpk-attack-ui-'));
const artifacts = resolve(process.env.UI_ARTIFACTS_DIR || join(root, 'reports/ui'));
const demo = JSON.parse(readFileSync(join(root, 'examples/privacy-attack-demo.json')));
let server, browser, page, origin;
const errors = [], external = [], posts = [];
before(async () => {
  mkdirSync(artifacts, { recursive: true });
  server = createWorkbenchServer({ root, dataDir: join(scratch, 'projects') });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
});
after(async () => { await browser?.close(); await new Promise(r => server?.close(r)); });
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1365, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (!req.url().startsWith(origin)) external.push(req.url()); if (req.method() === 'POST') posts.push(req.url()); });
  await page.goto(origin); await click('发布检查'); await click('泄露实测');
});
afterEach(async () => { await page.close(); });
const click = label => page.getByRole('button', { name: label, exact: true }).click();
const checkbox = () => page.getByRole('checkbox', { name: /^确认成员确实参与/ });
const upload = (name, value) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
const done = () => page.getByRole('heading', { name: '实测结果 · 仅供内部复核' }).waitFor();
async function save() { const waiting = page.waitForEvent('download'); await click('下载内部实测报告'); return readFileSync(await (await waiting).path(), 'utf8'); }

test('example, multiple candidates, uncertainty and invalidation work without posting private tables', async () => {
  const before = posts.length;
  await click('载入虚构泄露示例');
  await page.locator('#attack-tool .notice').filter({ hasText: '虚构示例已载入' }).waitFor();
  await click('开始泄露实测'); await page.locator('#attack-tool .notice.error').waitFor();
  await checkbox().check();
  await page.getByLabel('待测合成表或完整生成记录（最多 3 份）').setInputFiles([upload('copied.json', demo.released), upload('generic.json', [{ group: 'unrelated', choice: 'yes' }])]);
  await page.screenshot({ path: join(artifacts, 'privacy-attack-editor-desktop.png'), fullPage: true });
  await click('开始泄露实测'); await done();
  const report = JSON.parse(await save()); assert.equal(report.reports.length, 2);
  assert.equal(report.reports[0].membership.advantage.estimate, 1);
  assert.ok(report.reports[1].membership.advantage.lower95 < 0 && report.reports[1].membership.advantage.upper95 > 0);
  assert.deepEqual(report.reports[0].split, report.reports[1].split);
  assert.match(await page.locator('#attack-results').innerText(), /本次成员推断证据不足/);
  assert.ok(!JSON.stringify(report).includes('member-0'));
  await page.locator('#attack-results').screenshot({ path: join(artifacts, 'privacy-attack-results-desktop.png') });
  assert.equal(posts.length, before);
  const storage = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }));
  assert.ok(!storage.includes('pattern-') && !storage.includes('member-'));
  await page.getByLabel('尝试推断的敏感字段').fill('other');
  assert.equal(await page.locator('#attack-results').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '下载内部实测报告' }).count(), 0);
});

test('saved synthetic result hands off without another publication; malformed people get a useful error', async () => {
  await click('合成数据'); await page.locator('#view-synthetic .notice').filter({ hasText: '合成工具已就绪。' }).waitFor();
  await page.getByText('新建合成项目', { exact: true }).click();
  await page.getByLabel('合成项目名称', { exact: true }).fill('实测衔接'); await click('创建合成项目');
  await page.locator('#synthetic-budget').filter({ hasText: '剩余预算 ε 3' }).waitFor();
  const members = Array.from({ length: 40 }, (_, i) => ({ person: 'm' + i, group: i % 2 ? 'student' : 'staff', choice: i % 2 ? 'yes' : 'no' }));
  await page.getByLabel('原始分类表（CSV 或 JSON）').setInputFiles(upload('members.json', members));
  await click('生成并保存合成数据'); await page.getByRole('heading', { name: '合成数据已保存' }).waitFor();
  await page.locator('#synthetic-budget').filter({ hasText: '剩余预算 ε 2' }).waitFor();
  const before = posts.length;
  await click('评估这份数据的泄露风险');
  await page.locator('#attack-tool .notice').filter({ hasText: '已带入合成数据' }).waitFor();
  assert.equal(await page.locator('#attack-tool').isVisible(), true);
  await page.getByLabel('参与生成的原始成员表').setInputFiles(upload('members.json', members));
  await page.getByLabel('未参与生成的独立对照表').setInputFiles(upload('overlap.json', members));
  await checkbox().check(); await click('开始泄露实测');
  await page.locator('#attack-tool .notice.error').filter({ hasText: '重复人员' }).waitFor();
  assert.equal(await page.locator('#attack-results').isVisible(), false);
  await page.getByLabel('未参与生成的独立对照表').setInputFiles(upload('controls.json', members.map(r => ({ ...r, person: 'non-' + r.person }))));
  await click('开始泄露实测'); await done(); assert.equal(JSON.parse(await save()).reports.length, 1);
  assert.equal(posts.length, before);
  await click('合成数据'); assert.match(await page.locator('#synthetic-budget').innerText(), /剩余预算 ε 2/);
});

test('mobile primary action is keyboard accessible, result fits, and failures clear prior results', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await click('载入虚构泄露示例'); await page.locator('#attack-tool .notice').filter({ hasText: '虚构示例已载入' }).waitFor();
  await checkbox().check(); await page.screenshot({ path: join(artifacts, 'privacy-attack-editor-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.getByRole('button', { name: '开始泄露实测', exact: true }).focus(); await page.keyboard.press('Enter'); await done();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(artifacts, 'privacy-attack-results-mobile.png'), fullPage: true });
  await page.getByLabel('待测合成表或完整生成记录（最多 3 份）').setInputFiles(upload('bad.json', [{ group: 'private-value', choice: 'unlisted-private-value' }]));
  await click('开始泄露实测'); await page.locator('#attack-tool .notice.error').waitFor();
  assert.ok(!(await page.locator('#attack-tool .notice.error').innerText()).includes('unlisted-private-value'));
  assert.equal(await page.locator('#attack-results').isVisible(), false);
});

test('attack workflows cause no page errors or external requests', () => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
