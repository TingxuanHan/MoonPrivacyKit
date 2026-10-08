import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'moonprivacykit-ui-'));
const artifacts = resolve(process.env.UI_ARTIFACTS_DIR || join(root, 'reports/ui'));
const port = 4185;
const origin = `http://127.0.0.1:${port}`;
let server, browser, context, page;
const errors = [], external = [];

before(async () => {
  mkdirSync(artifacts, { recursive: true });
  server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), MPK_DATA_DIR: join(scratch, 'projects') }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveReady, reject) => {
    server.stdout.once('data', resolveReady);
    server.once('error', reject);
    server.once('exit', () => reject(new Error('Test server exited before startup.')));
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
  await page.goto(origin);
});
after(async () => { await browser?.close(); server?.kill(); });

async function saveDownload(click, file) {
  const event = page.waitForEvent('download');
  await click();
  const download = await event;
  const path = join(scratch, file);
  await download.saveAs(path);
  return path;
}

test('create, fill, retry download and aggregate a questionnaire through the visible UI', async () => {
  await page.getByRole('button', { name: '载入示例', exact: true }).click();
  const survey = await saveDownload(() => page.getByRole('button', { name: '导出问卷配置' }).click(), 'survey.json');
  assert.equal(JSON.parse(readFileSync(survey)).questions.length, 2);
  await page.screenshot({ path: join(artifacts, 'survey-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '填写问卷', exact: true }).click();
  await page.locator('#fill-file').setInputFiles(survey);
  await page.getByRole('radio', { name: '不满意', exact: true }).check();
  await page.getByRole('radio', { name: '工具', exact: true }).check();
  await page.getByRole('button', { name: '生成受保护回答' }).click();
  const response = await saveDownload(() => page.getByRole('button', { name: '下载受保护回答' }).click(), 'response.json');
  const retry = await saveDownload(() => page.getByRole('button', { name: '下载受保护回答' }).click(), 'retry.json');
  assert.equal(readFileSync(response, 'utf8'), readFileSync(retry, 'utf8'));
  assert.equal(await page.locator('#answer-fields input').count(), 0);
  const payload = JSON.parse(readFileSync(response));
  assert.deepEqual(Object.keys(payload).sort(), ['answers', 'mechanism', 'response_id', 'schema_version', 'survey_fingerprint']);
  await page.getByRole('button', { name: '汇总结果', exact: true }).click();
  await page.locator('#collect-survey').setInputFiles(survey);
  await page.locator('#collect-files').setInputFiles([response, retry]);
  await page.getByRole('button', { name: '计算群体结果' }).click();
  await page.getByRole('heading', { name: '1 份有效回答' }).waitFor();
  assert.match(await page.locator('#collect-result').innerText(), /已忽略 1 份重复文件/);
  assert.match(await page.locator('#collect-result').innerText(), /当前误差范围很宽/);
  const report = await saveDownload(() => page.getByRole('button', { name: '导出统计报告' }).click(), 'report.json');
  assert.equal(JSON.parse(readFileSync(report)).accepted, 1);
});

test('redaction preview, exports and stale-result invalidation work without uploading data', async () => {
  await page.getByRole('button', { name: '文件脱敏' }).click();
  await page.getByRole('button', { name: '使用虚构示例' }).click();
  await page.getByRole('button', { name: '处理并预览' }).click();
  await page.locator('#redact-result').waitFor({ state: 'visible' });
  assert.ok(!(await page.locator('#redact-preview').innerText()).includes('example.test'));
  const result = await saveDownload(() => page.getByRole('button', { name: '下载处理后文件' }).click(), 'redacted.csv');
  assert.ok(!readFileSync(result, 'utf8').includes('示例甲'));
  const audit = await saveDownload(() => page.getByRole('button', { name: '下载处理记录' }).click(), 'audit.json');
  assert.equal(JSON.parse(readFileSync(audit)).removed_values, 2);
  await page.screenshot({ path: join(artifacts, 'redaction-desktop.png'), fullPage: true });
  await page.locator('#field-policy-0').selectOption('keep');
  assert.equal(await page.locator('#redact-result').isVisible(), false);
  await page.locator('#field-policy-1').selectOption('keep');
  await page.getByRole('button', { name: '处理并预览' }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /至少选择一个/);
});

test('malformed imports and hostile labels recover with safe text rendering', async () => {
  await page.locator('#redact-file').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('a,a\nprivate,secret') });
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('#redact-form').isVisible(), false);
  assert.ok(!(await page.getByRole('alert').innerText()).includes('secret'));
  const json = JSON.stringify({ '<img src=x onerror=alert(1)>': 'secret', group: 'A' });
  await page.locator('#redact-file').setInputFiles({ name: 'hostile.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await page.locator('#redact-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#field-policies img').count(), 0);
  await page.locator('#field-policy-0').selectOption('remove');
  await page.getByRole('button', { name: '处理并预览' }).click();
  assert.equal(JSON.parse(await page.locator('#redact-preview').innerText()).group, 'A');
});

test('precision planning, mobile layout and keyboard access remain usable', async () => {
  await page.getByRole('button', { name: '效果评估' }).click();
  await page.getByRole('button', { name: '评估这个方案' }).click();
  await page.getByRole('heading', { name: '这份方案的预期表现' }).waitFor();
  const result = await saveDownload(() => page.getByRole('button', { name: '导出评估结果' }).click(), 'plan.json');
  assert.ok(JSON.parse(readFileSync(result)).required_samples > 1000);
  await page.screenshot({ path: join(artifacts, 'plan-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'plan-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '隐私问卷' }).click();
  await page.getByRole('button', { name: '创建问卷', exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'survey-mobile.png'), fullPage: true });
  await page.locator('#survey-title').focus();
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement.tagName === 'BUTTON'));
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

test('local server rejects arbitrary writes and access to repository or source files', async () => {
  assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
  assert.equal((await fetch(`${origin}/examples/sample.csv`)).status, 404);
  assert.equal((await fetch(origin, { method: 'POST', body: 'sensitive' })).status, 405);
  assert.match((await fetch(origin)).headers.get('content-security-policy'), /form-action 'none'/);
});

async function statsIdle() {
  await page.waitForFunction(() => !document.getElementById('stats-refresh').disabled);
}
async function statsProject(name, total = '1') {
  await page.locator('#stats-new summary').click();
  await page.locator('#stats-name').fill(name);
  await page.locator('#stats-total').fill(total);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await statsIdle();
}

test('statistics project, CSV histogram, repeated download, count and history form a complete workflow', async () => {
  await page.setViewportSize({ width: 1365, height: 1000 });
  await page.getByRole('button', { name: '隐私统计', exact: true }).click();
  await statsIdle();
  await page.screenshot({ path: join(artifacts, 'statistics-empty.png'), fullPage: true });
  // The empty state opens project creation for the first-time user.
  await page.locator('#stats-name').fill('统计测试');
  await page.locator('#stats-total').fill('0.6');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await statsIdle();
  await page.locator('#stats-example').click();
  await statsIdle();
  await page.locator('#stats-epsilon').fill('0.2');
  await page.screenshot({ path: join(artifacts, 'statistics-settings.png'), fullPage: true });
  assert.match(await page.locator('#stats-estimate').innerText(), /误差界/);
  let requests = 0;
  const monitor = request => { if (request.url().endsWith('/publish')) requests++; };
  page.on('request', monitor);
  await page.locator('#stats-publish').click({ clickCount: 2 });
  await page.locator('#stats-complete').waitFor({ state: 'visible' });
  await statsIdle();
  page.off('request', monitor);
  assert.equal(requests, 1);
  assert.equal(await page.locator('.stats-bars li').count(), 3);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.4', '0.2', '0.6', '1']);
  const a = await saveDownload(() => page.getByRole('button', { name: '下载这份报告' }).click(), 'statistics-a.json');
  const b = await saveDownload(() => page.getByRole('button', { name: '下载这份报告' }).click(), 'statistics-b.json');
  assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
  assert.ok(!readFileSync(a, 'utf8').includes('unit-001'));
  await page.screenshot({ path: join(artifacts, 'statistics-report.png'), fullPage: true });
  await page.locator('#stats-next').click();
  await page.locator('#stats-query').selectOption('count');
  assert.equal(await page.locator('#stats-category-settings').isVisible(), false);
  await page.locator('#stats-epsilon').fill('0.1');
  await page.locator('#stats-publish').click();
  await page.locator('#stats-complete').waitFor({ state: 'visible' });
  await statsIdle();
  assert.equal(await page.locator('.stats-count').count(), 1);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.3', '0.3', '0.6', '2']);
  await page.reload();
  await page.getByRole('button', { name: '隐私统计', exact: true }).click();
  await statsIdle();
  await page.locator('#stats-history-tab').click();
  await statsIdle();
  assert.equal(await page.locator('.history-row').count(), 2);
  await page.getByRole('button', { name: '查看第 1 次报告', exact: true }).click();
  await statsIdle();
  const recovered = await saveDownload(() => page.getByRole('button', { name: '下载这份报告' }).click(), 'statistics-history.json');
  assert.equal(readFileSync(recovered, 'utf8'), readFileSync(a, 'utf8'));
  await page.screenshot({ path: join(artifacts, 'statistics-history.png'), fullPage: true });
});

test('invalid encoding, malformed tables, unknown categories and over-budget requests recover without a charge', async () => {
  await page.locator('#stats-publish-tab').click();
  for (const buffer of [Buffer.from([0xff, 0xfe, 0x61]), Buffer.from('a,a\nprivate,secret')]) {
    await page.locator('#stats-file').setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer });
    await statsIdle();
    assert.equal(await page.locator('#stats-settings').isVisible(), false);
    assert.equal(await page.locator('#stats-notice').getAttribute('role'), 'alert');
    assert.ok(!(await page.locator('#stats-notice').innerText()).includes('secret'));
  }
  await page.locator('#stats-example').click();
  await statsIdle();
  await page.locator('#stats-categories').fill('其他');
  await page.locator('#stats-publish').click();
  await statsIdle();
  assert.match(await page.locator('#stats-notice').innerText(), /预设类别/);
  assert.equal(await page.locator('#stats-pending').isVisible(), false);
  await page.locator('#stats-categories').fill('满意\n一般\n不满意');
  await page.locator('#stats-epsilon').fill('0.4');
  await page.locator('#stats-publish').click();
  await statsIdle();
  assert.match(await page.locator('#stats-notice').innerText(), /剩余预算不足/);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.3', '0.3', '0.6', '2']);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'statistics-mobile-error.png'), fullPage: true });
  await page.locator('#stats-epsilon').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'stats-publish');
});

test('lost publication responses retry the same ID and recover after reload without duplicate spending', async () => {
  await page.setViewportSize({ width: 1365, height: 1000 });
  await statsProject('恢复测试');
  await page.locator('#stats-example').click();
  await statsIdle();
  await page.locator('#stats-epsilon').fill('0.3');
  const ids = [], saved = [];
  const loseResponse = async route => {
    ids.push(route.request().postDataJSON().plan.requestId);
    const response = await route.fetch();
    saved.push((await response.json()).data);
    await route.abort('failed');
  };
  await page.route('**/publish', loseResponse, { times: 1 });
  await page.locator('#stats-publish').click();
  await statsIdle();
  assert.equal(await page.locator('#stats-pending').isVisible(), true);
  assert.equal(await page.locator('#stats-unit').isEnabled(), false);
  const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
  assert.ok(!storage.includes('unit-001') && !storage.includes('满意'));
  await page.route('**/publish', async route => { ids.push(route.request().postDataJSON().plan.requestId); await route.continue(); }, { times: 1 });
  await page.getByRole('button', { name: '重试本次发布', exact: true }).click();
  await page.locator('#stats-complete').waitFor({ state: 'visible' });
  await statsIdle();
  assert.equal(ids[0], ids[1]);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.7', '0.3', '1', '1']);
  await page.locator('#stats-next').click();
  await page.locator('#stats-epsilon').fill('0.2');
  await page.route('**/publish', loseResponse, { times: 1 });
  await page.locator('#stats-publish').click();
  await statsIdle();
  await page.reload();
  await page.getByRole('button', { name: '隐私统计', exact: true }).click();
  await page.locator('#stats-complete').waitFor({ state: 'visible' });
  await statsIdle();
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.5', '0.5', '1', '2']);
  const restored = await saveDownload(() => page.getByRole('button', { name: '下载这份报告' }).click(), 'statistics-recovered.json');
  assert.deepEqual(JSON.parse(readFileSync(restored)), saved[1]);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('mpk.statistics.pending.v1')), null);
});

test('uncommitted interruption keeps its ID across reload and validation errors; JSON labels render as text', async () => {
  await page.locator('#stats-next').click();
  await page.locator('#stats-example').click();
  await statsIdle();
  let firstId;
  await page.route('**/publish', async route => { firstId = route.request().postDataJSON().plan.requestId; await route.abort('failed'); }, { times: 1 });
  await page.locator('#stats-publish').click();
  await statsIdle();
  await page.reload();
  await page.getByRole('button', { name: '隐私统计', exact: true }).click();
  await statsIdle();
  assert.match(await page.locator('#stats-notice').innerText(), /尚未找到/);
  await page.locator('#stats-recover').click();
  await statsIdle();
  await page.locator('#stats-example').click();
  await statsIdle();
  await page.locator('#stats-categories').fill('其他');
  await page.locator('#stats-publish').click();
  await statsIdle();
  assert.equal(await page.locator('#stats-pending').isVisible(), true);
  assert.equal(JSON.parse(await page.evaluate(() => sessionStorage.getItem('mpk.statistics.pending.v1'))).requestId, firstId);
  const label = '<img src=x onerror=alert(1)>' + '很长的公开类别'.repeat(10);
  await page.locator('#stats-file').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([{ person_id: 'synthetic-only', answer: label }])) });
  await statsIdle();
  await page.locator('#stats-categories').fill(label);
  await page.locator('#stats-epsilon').fill('0.1');
  await page.locator('#stats-publish').click();
  await page.locator('#stats-complete').waitFor({ state: 'visible' });
  await statsIdle();
  assert.equal(await page.locator('#stats-report img').count(), 0);
  assert.match(await page.locator('#stats-report').innerText(), /<img src=x/);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.4', '0.6', '1', '3']);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'statistics-mobile-report.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

test('history loads multiple pages and switching projects restores the correct budget', async () => {
  await statsProject('分页测试');
  const projectId = await page.locator('#stats-project').inputValue();
  // Seed only synthetic reports through the same local API to exercise the visible pager.
  const token = (await (await page.request.get(`${origin}/api/session`)).json()).data.token;
  for (let i = 0; i < 21; i++) {
    const response = await page.request.post(`${origin}/api/projects/${projectId}/publish`, {
      headers: { Origin: origin, 'X-MoonPrivacyKit-Token': token },
      data: { format: 'csv', input: 'person\nsynthetic-only', plan: { requestId: `page-${i}`, query: 'count', epsilon: '0.01', maxContributions: 1, unitField: 'person' } },
    });
    assert.equal(response.status(), 200);
  }
  await page.locator('#stats-refresh').click(); await statsIdle();
  await page.locator('#stats-history-tab').click(); await statsIdle();
  assert.equal(await page.locator('.history-row').count(), 20);
  await page.locator('#stats-more').click(); await statsIdle();
  assert.equal(await page.locator('.history-row').count(), 21);
  assert.equal(await page.locator('#stats-more').isVisible(), false);
  await page.getByRole('button', { name: '查看第 1 次报告', exact: true }).click(); await statsIdle();
  assert.equal(await page.locator('.stats-count').count(), 1);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.79', '0.21', '1', '21']);
  await page.locator('#stats-history-refresh').click(); await statsIdle();
  assert.equal(await page.locator('.history-row').count(), 20);
  await page.locator('#stats-project').selectOption({ label: '统计测试' }); await statsIdle();
  assert.equal(await page.locator('.history-row').count(), 2);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.3', '0.3', '0.6', '2']);
  assert.equal(await page.locator('#stats-report').isVisible(), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

