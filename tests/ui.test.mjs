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
  server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('local server rejects writes and access to repository or source files', async () => {
  assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
  assert.equal((await fetch(`${origin}/examples/sample.csv`)).status, 404);
  assert.equal((await fetch(origin, { method: 'POST', body: 'sensitive' })).status, 405);
  assert.match((await fetch(origin)).headers.get('content-security-policy'), /form-action 'none'/);
});

