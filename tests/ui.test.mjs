import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surveyFingerprint } from '../runtime/client.mjs';

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
  await page.locator('#survey-templates summary').click();
  await page.locator('#survey-preset').selectOption('team');
  assert.equal(await page.locator('#question-editor .question').count(), 1);
  await page.locator('#survey-template-apply').click();
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

test('questionnaire templates preview before replacement and export matching plans and participation instructions', async () => {
  await page.reload();
  await page.locator('#survey-title').fill('尚未导出的草稿');
  await page.locator('#survey-templates summary').click();
  await page.locator('#survey-preset').selectOption('course');
  assert.match(await page.locator('#survey-template-questions').innerText(), /课程节奏/);
  assert.equal(await page.locator('#survey-title').inputValue(), '尚未导出的草稿');
  await page.locator('#survey-template-dismiss').click();
  assert.equal(await page.locator('#survey-title').inputValue(), '尚未导出的草稿');
  await page.locator('#survey-preset').selectOption('course');
  await page.locator('#survey-template-apply').click();
  await page.locator('#survey-collections').fill('3');
  await page.locator('#question-editor [data-field=epsilon]').nth(0).fill('0.25');
  await page.locator('#question-editor [data-field=epsilon]').nth(1).fill('0.5');
  assert.match(await page.locator('#create-meta').innerText(), /单次 ε ≈ 0.75.*3 次累计 ε ≈ 2.25/);
  await page.locator('#survey-template-save summary').click();
  const savedTemplate = await saveDownload(() => page.locator('#survey-template-export').click(), 'course-template.json');
  const value = JSON.parse(readFileSync(savedTemplate));
  assert.equal(value.settings.plannedCollections, 3);
  assert.equal(value.settings.questions[0].id, 'pace');
  assert.equal(value.settings.id, undefined);
  const a = await saveDownload(() => page.getByRole('button', { name: '导出问卷配置', exact: true }).click(), 'course-a.json');
  const guide = await saveDownload(() => page.locator('#survey-guide-export').click(), 'course-guide.txt');
  assert.ok(readFileSync(guide, 'utf8').includes(JSON.parse(readFileSync(a)).id));
  assert.match(readFileSync(guide, 'utf8'), /ε 约为 2.25/);
  await page.locator('#survey-templates summary').click();
  await page.locator('#survey-template-file').setInputFiles(savedTemplate);
  await page.locator('#survey-template-preview').waitFor({ state: 'visible' });
  await page.locator('#survey-template-apply').click();
  assert.equal(await page.locator('#survey-collections').inputValue(), '3');
  const b = await saveDownload(() => page.getByRole('button', { name: '导出问卷配置', exact: true }).click(), 'course-b.json');
  const surveyA = JSON.parse(readFileSync(a)), surveyB = JSON.parse(readFileSync(b));
  assert.notEqual(surveyA.id, surveyB.id);
  assert.deepEqual(surveyA.questions, surveyB.questions);
  await page.screenshot({ path: join(artifacts, 'survey-templates-desktop.png'), fullPage: true });
});

test('invalid imports and replacement cancellation preserve current choices and the exact protected response', async () => {
  await page.getByRole('button', { name: '填写问卷', exact: true }).click();
  const survey = join(scratch, 'course-a.json');
  await page.locator('#fill-file').setInputFiles(survey);
  await page.getByRole('radio', { name: '合适', exact: true }).check();
  await page.getByRole('radio', { name: '练习讲解', exact: true }).check();
  assert.match(await page.locator('#fill-privacy-note').innerText(), /0.75.*1.5/);
  await page.locator('#fill-file').setInputFiles(join(scratch, 'survey.json'));
  await page.locator('#fill-replacement').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#protect-button').isEnabled(), false);
  await page.locator('#fill-cancel').click();
  assert.equal(await page.getByRole('radio', { name: '合适', exact: true }).isChecked(), true);
  await page.locator('#protect-button').click();
  const response = await saveDownload(() => page.locator('#download-response').click(), 'course-response.json');
  assert.ok(readFileSync(join(scratch, 'course-guide.txt'), 'utf8').includes(JSON.parse(readFileSync(response)).survey_fingerprint));
  await page.locator('#fill-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from([0xff]) });
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /UTF-8/);
  assert.equal(await page.locator('#response-ready').isVisible(), true);
  await page.locator('#fill-file').setInputFiles(survey);
  await page.locator('#fill-replacement').waitFor({ state: 'visible' });
  const pending = await saveDownload(() => page.locator('#download-response').click(), 'course-response-pending.json');
  assert.equal(readFileSync(pending, 'utf8'), readFileSync(response, 'utf8'));
  await page.locator('#fill-cancel').click();
  const retry = await saveDownload(() => page.locator('#download-response').click(), 'course-response-retry.json');
  assert.equal(readFileSync(retry, 'utf8'), readFileSync(response, 'utf8'));
  await page.locator('#fill-file').setInputFiles(join(scratch, 'survey.json'));
  await page.locator('#fill-replacement').waitFor({ state: 'visible' });
  await page.locator('#fill-replace').click();
  assert.equal(await page.locator('#response-ready').isVisible(), false);
  assert.equal(await page.locator('#answer-fields input:checked').count(), 0);
  assert.equal(await page.locator('#fill-title').innerText(), '团队反馈问卷');
});

test('template imports fail safely and long labels remain text on mobile with keyboard confirmation', async () => {
  await page.getByRole('button', { name: '创建问卷', exact: true }).click();
  await page.locator('#survey-templates summary').click();
  const previous = await page.locator('#survey-title').inputValue();
  const source = JSON.parse(readFileSync(join(scratch, 'course-template.json')));
  const hostile = '<img src=x onerror=alert(1)>' + '长标题'.repeat(60);
  source.settings.title = hostile;
  source.settings.questions[0].title = hostile;
  await page.locator('#survey-template-file').setInputFiles({ name: 'labels.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
  await page.locator('#survey-template-preview').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#survey-template-preview img').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#survey-template-questions').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'survey-template-apply');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#survey-title').inputValue(), previous);
  for (const buffer of [Buffer.from([0xff]), Buffer.from(JSON.stringify({ ...source, answers: ['private-value'] })), Buffer.from(JSON.stringify(source).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":2'))]) {
    await page.locator('#survey-template-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer });
    await page.getByRole('alert').waitFor();
    assert.ok(!(await page.getByRole('alert').innerText()).includes('private-value'));
    assert.equal(await page.locator('#survey-template-preview').isVisible(), false);
    assert.equal(await page.locator('#survey-title').inputValue(), previous);
  }
  await page.locator('#survey-preset').selectOption('service');
  assert.equal(await page.locator('#notice').isVisible(), false);
  // An earlier slow file must not overwrite a newer choice or its status.
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    window.restoreSurveyFileReader = () => { File.prototype.arrayBuffer = original; };
    File.prototype.arrayBuffer = function () {
      if (this.name !== 'slow.json') return original.call(this);
      return new Promise(resolve => { window.finishSurveyFileRead = async () => { resolve(await original.call(this)); }; });
    };
  });
  try {
    await page.locator('#survey-template-file').setInputFiles({ name: 'slow.json', mimeType: 'application/json', buffer: Buffer.from([0xff]) });
    await page.waitForFunction(() => typeof window.finishSurveyFileRead === 'function');
    await page.locator('#survey-preset').selectOption('service');
    await page.evaluate(async () => { await window.finishSurveyFileRead(); });
    assert.equal(await page.locator('#survey-template-title').innerText(), '服务体验');
    assert.equal(await page.locator('#notice').isVisible(), false);
  } finally { await page.evaluate(() => { window.restoreSurveyFileReader(); delete window.restoreSurveyFileReader; delete window.finishSurveyFileRead; }); }
  await page.screenshot({ path: join(artifacts, 'survey-template-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#survey-template-dismiss').click();
  await page.locator('#survey-templates summary').click();
  await page.setViewportSize({ width: 1365, height: 1000 });
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
  assert.equal(JSON.parse(readFileSync(audit)).removed_values, 3);
  await page.screenshot({ path: join(artifacts, 'redaction-desktop.png'), fullPage: true });
  await page.locator('#field-policy-1').selectOption('keep');
  assert.equal(await page.locator('#redact-result').isVisible(), false);
  await page.locator('#field-policy-2').selectOption('keep');
  await page.getByRole('button', { name: '处理并预览' }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /至少.*一列/);
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
  assert.equal(await page.evaluate(() => document.activeElement.parentElement.id), 'stats-template-save');
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

let exportedTemplatePath;
test('built-in and exported templates reuse CSV settings on JSON without publishing or changing the budget', async () => {
  await page.reload();
  await page.setViewportSize({ width: 1365, height: 1000 });
  await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await statsIdle();
  await statsProject('模板测试');
  await page.locator('#stats-templates > summary').click();
  await page.locator('#stats-template-preset').selectOption('histogram'); await statsIdle();
  await page.locator('#stats-template-category-summary').click();
  assert.equal(await page.locator('#stats-template-category-values').innerText(), '满意\n一般\n不满意');
  assert.equal(await page.locator('#stats-template-apply').isEnabled(), false);
  assert.match(await page.locator('#stats-template-check').innerText(), /先选择统计源文件/);
  await page.locator('#stats-file').setInputFiles(join(root, 'examples/table.csv')); await statsIdle();
  assert.equal(await page.locator('#stats-template-apply').isEnabled(), true);
  assert.equal(await page.locator('#stats-unit').inputValue(), '');
  assert.equal(await page.locator('#stats-query').inputValue(), 'count');
  await page.locator('#stats-template-apply').click(); await statsIdle();
  assert.equal(await page.locator('#stats-unit').inputValue(), 'person_id');
  assert.equal(await page.locator('#stats-category').inputValue(), 'answer');
  assert.equal(await page.locator('#stats-query').inputValue(), 'histogram');
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['1', '0', '1', '0']);
  await page.locator('#stats-template-save summary').click();
  await page.locator('#stats-template-name').fill('季度满意度配置');
  await page.locator('#stats-template-name').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'stats-template-export');
  exportedTemplatePath = await saveDownload(() => page.locator('#stats-template-export').click(), 'portable-template.json');
  await statsIdle();
  const template = JSON.parse(readFileSync(exportedTemplatePath));
  assert.equal(template.name, '季度满意度配置');
  assert.deepEqual(Object.keys(template).sort(), ['kind', 'name', 'schemaVersion', 'settings']);
  assert.deepEqual(Object.keys(template.settings).sort(), ['categories', 'categoryField', 'epsilon', 'maxContributions', 'query', 'unitField']);
  assert.ok(!readFileSync(exportedTemplatePath, 'utf8').includes('unit-001'));
  await page.screenshot({ path: join(artifacts, 'templates-desktop.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await statsIdle();
  await page.locator('#stats-file').setInputFiles(join(root, 'examples/table.json')); await statsIdle();
  await page.locator('#stats-templates > summary').click();
  await page.locator('#stats-template-file').setInputFiles(exportedTemplatePath); await statsIdle();
  assert.equal(await page.locator('#stats-query').inputValue(), 'count');
  await page.locator('#stats-template-apply').click(); await statsIdle();
  assert.equal(await page.locator('#stats-query').inputValue(), 'histogram');
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['1', '0', '1', '0']);
  await page.locator('#stats-publish').click();
  await page.locator('#stats-complete').waitFor({ state: 'visible' }); await statsIdle();
  const saved = await saveDownload(() => page.locator('#stats-template-complete').click(), 'completed-template.json');
  await statsIdle();
  assert.deepEqual(JSON.parse(readFileSync(saved)), template);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.7', '0.3', '1', '1']);
});

test('incompatible and malformed templates preserve active settings and never auto-publish', async () => {
  await page.locator('#stats-next').click();
  const prior = await page.locator('#stats-epsilon').inputValue();
  const base = JSON.parse(readFileSync(exportedTemplatePath));
  const upload = async value => {
    await page.locator('#stats-template-file').setInputFiles({ name: 'template.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
    await statsIdle();
  };
  await upload({ ...base, settings: { ...base.settings, unitField: 'renamed_person', epsilon: '0.1' } });
  assert.match(await page.locator('#stats-template-check').innerText(), /缺少模板所需字段：renamed_person/);
  assert.equal(await page.locator('#stats-template-apply').isEnabled(), false);
  assert.equal(await page.locator('#stats-epsilon').inputValue(), prior);
  for (const value of [
    { ...base, schemaVersion: 2 }, { ...base, requestId: 'hidden-request' },
    JSON.stringify(base).replace('"epsilon":"0.3"', '"epsilon":"0.3","epsilon":"0.1"'),
  ]) {
    await upload(value);
    assert.equal(await page.locator('#stats-template-preview').isVisible(), false);
    assert.match(await page.locator('#stats-notice').innerText(), /模板无法读取/);
    assert.equal(await page.locator('#stats-epsilon').inputValue(), prior);
  }
  await page.locator('#stats-template-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from([0xff]) }); await statsIdle();
  assert.match(await page.locator('#stats-notice').innerText(), /UTF-8/);
  await upload(base);
  await page.locator('#stats-file').setInputFiles({ name: 'private.csv', mimeType: 'text/csv', buffer: Buffer.from('person_id,answer\nprivate-person,private-unlisted') }); await statsIdle();
  assert.equal(await page.locator('#stats-template-apply').isEnabled(), false);
  assert.match(await page.locator('#stats-template-check').innerText(), /表格记录与模板不兼容/);
  assert.ok(!(await page.locator('#stats-template-check').innerText()).includes('private-unlisted'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'templates-mobile-incompatible.png'), fullPage: true });
  await page.locator('#stats-template-dismiss').click();
  assert.equal(await page.locator('#stats-template-preview').isVisible(), false);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.7', '0.3', '1', '1']);
});

test('template reuse during interrupted recovery retains the original request ID and renders hostile labels safely', async () => {
  await page.locator('#stats-file').setInputFiles(join(root, 'examples/table.csv')); await statsIdle();
  await page.locator('#stats-template-preset').selectOption('count'); await statsIdle();
  await page.locator('#stats-template-apply').click(); await statsIdle();
  assert.equal(await page.locator('#stats-query').inputValue(), 'count');
  const templatePath = await saveDownload(() => page.locator('#stats-template-save summary').click().then(() => page.locator('#stats-template-export').click()), 'pending-template.json');
  await statsIdle();
  let requestId;
  await page.route('**/publish', async route => { requestId = route.request().postDataJSON().plan.requestId; await route.abort('failed'); }, { times: 1 });
  await page.locator('#stats-publish').click(); await statsIdle();
  assert.equal(await page.locator('#stats-template-file').isEnabled(), false);
  await page.reload();
  await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await statsIdle();
  await page.locator('#stats-file').setInputFiles(join(root, 'examples/table.csv')); await statsIdle();
  await page.locator('#stats-templates > summary').click();
  const template = JSON.parse(readFileSync(templatePath));
  const hostile = { ...template, name: '<img src=x onerror=alert(1)>' + '模板名称'.repeat(12) };
  await page.locator('#stats-template-file').setInputFiles({ name: 'template.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(hostile)) }); await statsIdle();
  assert.equal(await page.locator('#stats-template-preview img').count(), 0);
  await page.locator('#stats-template-apply').click(); await statsIdle();
  assert.equal(JSON.parse(await page.evaluate(() => sessionStorage.getItem('mpk.statistics.pending.v1'))).requestId, requestId);
  assert.equal(await page.locator('#stats-project').isEnabled(), false);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'templates-mobile-recovery.png'), fullPage: true });
  let retried;
  await page.route('**/publish', async route => { retried = route.request().postDataJSON().plan.requestId; await route.continue(); }, { times: 1 });
  await page.locator('#stats-publish').click();
  await page.locator('#stats-complete').waitFor({ state: 'visible' }); await statsIdle();
  assert.equal(retried, requestId);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.4', '0.6', '1', '2']);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

async function redactIdle() {
  await page.waitForFunction(() => !document.getElementById('redact-template-file').disabled);
}
const redactionRows = [{ person_id: 'private-p1', answer: '满意', contact: 'secret-contact' }, { person_id: 'private-p1', answer: '一般', contact: 'secret-contact' }, { person_id: 'private-p2', answer: '不满意', contact: 'secret-contact' }];
const redactionCsv = 'person_id,answer,contact\nprivate-p1,满意,secret-contact\nprivate-p1,一般,secret-contact\nprivate-p2,不满意,secret-contact';
const fieldControl = name => page.locator(`#field-policies select[data-key="${name}"]`);
async function redactSource(text = redactionCsv) {
  await page.getByRole('button', { name: '文件脱敏', exact: true }).click();
  await page.locator('#redact-file').setInputFiles({ name: 'source.csv', mimeType: 'text/csv', buffer: Buffer.from(text) }); await redactIdle();
  await fieldControl('contact').selectOption('remove');
}
async function processRedaction() {
  await page.getByRole('button', { name: '处理并预览', exact: true }).click(); await redactIdle();
  await page.locator('#redact-result').waitFor({ state: 'visible' });
}
let exportedRedactionPath;

test('field rules export and import across CSV JSON with explicit preview and keyboard access', async () => {
  await page.reload(); await page.setViewportSize({ width: 1365, height: 1000 });
  await redactSource();
  await page.locator('#redact-template-save > summary').click();
  await page.locator('#redact-template-name').fill('联系信息处理配置');
  await page.locator('#redact-template-name').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'redact-template-export');
  exportedRedactionPath = await saveDownload(() => page.locator('#redact-template-export').click(), 'redaction-template.json'); await redactIdle();
  const config = JSON.parse(readFileSync(exportedRedactionPath));
  assert.deepEqual(config.settings.fields.map(f => f.action), ['keep', 'keep', 'remove']);
  assert.ok(!readFileSync(exportedRedactionPath, 'utf8').includes('secret-contact'));
  await page.reload();
  await page.getByRole('button', { name: '文件脱敏', exact: true }).click();
  await page.locator('#redact-templates > summary').click();
  await page.locator('#redact-template-file').setInputFiles(exportedRedactionPath); await redactIdle();
  assert.equal(await page.locator('#redact-template-apply').isEnabled(), false);
  await page.locator('#redact-file').setInputFiles({ name: 'equivalent.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(redactionRows)) }); await redactIdle();
  assert.equal(await page.locator('#redact-template-apply').isEnabled(), true);
  assert.equal(await fieldControl('contact').inputValue(), 'keep');
  await page.locator('#redact-template-apply').click(); await redactIdle();
  assert.equal(await fieldControl('contact').inputValue(), 'remove');
  assert.equal(await page.locator('#redact-result').isVisible(), false);
  await processRedaction();
  const output = await saveDownload(() => page.locator('#download-redacted').click(), 'field-reuse.json');
  assert.deepEqual(JSON.parse(readFileSync(output)), redactionRows.map(({ person_id, answer }) => ({ person_id, answer })));
  assert.equal(await page.locator('#redact-to-statistics').isEnabled(), true);
  await page.screenshot({ path: join(artifacts, 'redaction-templates-desktop.png'), fullPage: true });
});

test('new fields and malformed templates require review while preserving current field decisions', async () => {
  await redactSource('person_id,answer,contact,phone\np,满意,secret-contact,secret-phone');
  await fieldControl('contact').selectOption('mask');
  assert.equal(await page.locator('#redact-template-apply').isEnabled(), false);
  assert.match(await page.locator('#redact-template-check').innerText(), /新增字段尚未配置：phone/);
  const config = JSON.parse(readFileSync(exportedRedactionPath));
  for (const contents of [JSON.stringify({ ...config, schemaVersion: 99 }), JSON.stringify(config).replace('"action":"keep"', '"action":"keep","action":"remove"'), Buffer.from([0xff])]) {
    await page.locator('#redact-template-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(contents) }); await redactIdle();
    assert.equal(await fieldControl('contact').inputValue(), 'mask');
    assert.equal(await page.locator('#redact-template-preview').isVisible(), false);
    assert.equal(await page.locator('#redact-template-apply').isEnabled(), false);
  }
  const hostile = { ...config, name: '<img src=x onerror=alert(1)>' + '较长配置名称'.repeat(7) };
  await page.locator('#redact-template-file').setInputFiles({ name: 'template.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(hostile)) }); await redactIdle();
  assert.equal(await page.locator('#redact-template-preview img').count(), 0);
  assert.equal(await page.locator('#redact-template-title').innerText(), hostile.name);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'redaction-templates-mobile-review.png'), fullPage: true });
  await page.locator('#redact-template-dismiss').click();
  await page.locator('#redact-file').setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from([0xff]) }); await redactIdle();
  assert.match(await page.locator('#notice').innerText(), /UTF-8/);
  assert.equal(await page.locator('#redact-form').isVisible(), false);
});

test('processed data transfers to statistics without upload or budget reset and stays an independent snapshot', async () => {
  await page.setViewportSize({ width: 1365, height: 1000 });
  await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await statsIdle();
  await statsProject('字段衔接测试');
  const publications = [];
  const onRequest = request => { if (request.url().endsWith('/publish')) publications.push(request.postDataJSON()); };
  page.on('request', onRequest);
  await redactSource(); await processRedaction();
  await page.locator('#redact-to-statistics').click(); await redactIdle(); await statsIdle();
  assert.equal(await page.locator('#stats-source').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.view), 'statistics');
  assert.deepEqual(await page.locator('#stats-unit option').allTextContents(), ['请选择列', 'person_id', 'answer']);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['1', '0', '1', '0']);
  assert.equal(publications.length, 0);
  await page.locator('#stats-templates > summary').click();
  await page.locator('#stats-template-preset').selectOption('histogram'); await statsIdle();
  await page.locator('#stats-template-apply').click(); await statsIdle();
  // Editing the source tool must not silently mutate an already accepted table.
  await page.getByRole('button', { name: '文件脱敏', exact: true }).click();
  await fieldControl('person_id').selectOption('mask');
  assert.equal(await page.locator('#redact-result').isVisible(), false);
  await processRedaction();
  await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await statsIdle();
  assert.equal(await page.locator('#stats-unit').inputValue(), 'person_id');
  await page.locator('#stats-source summary').click();
  await page.screenshot({ path: join(artifacts, 'redaction-handoff-desktop.png'), fullPage: true });
  await page.locator('#stats-publish').click();
  await page.locator('#stats-complete').waitFor({ state: 'visible' }); await statsIdle();
  assert.equal(publications.length, 1);
  assert.ok(!publications[0].input.includes('secret-contact') && !publications[0].input.includes('[REDACTED]'));
  assert.match(publications[0].input, /private-p1/);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.7', '0.3', '1', '1']);
  await page.getByRole('button', { name: '文件脱敏', exact: true }).click();
  await page.locator('#redact-to-statistics').click(); await redactIdle();
  assert.match(await page.locator('#notice').innerText(), /准备下一次发布/);
  page.off('request', onRequest);
});

test('changed fields cannot reenter statistics through templates and interrupted handoffs reuse the same request', async () => {
  await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await statsIdle();
  await page.locator('#stats-next').click();
  // Both masking and formula escaping must exclude an identifier, even if it remains a valid string.
  for (const escaped of [false, true]) {
    await redactSource(escaped ? redactionCsv.replace('private-p2', '=private-p2') : redactionCsv);
    if (!escaped) await fieldControl('person_id').selectOption('mask');
    await processRedaction();
    await page.locator('#redact-to-statistics').click(); await redactIdle(); await statsIdle();
    assert.deepEqual(await page.locator('#stats-unit option').allTextContents(), ['请选择列', 'answer']);
    assert.equal(await page.locator('#stats-template-apply').isEnabled(), false);
    assert.match(await page.locator('#stats-template-check').innerText(), /已删除或改写的列：person_id/);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'redaction-handoff-mobile-blocked.png'), fullPage: true });
  await redactSource(); await fieldControl('person_id').selectOption('mask'); await fieldControl('answer').selectOption('remove');
  await processRedaction();
  assert.equal(await page.locator('#redact-to-statistics').isEnabled(), false);
  await redactSource(); await processRedaction();
  await page.locator('#redact-to-statistics').click(); await redactIdle(); await statsIdle();
  await page.locator('#stats-template-apply').click(); await statsIdle();
  let requestId;
  await page.route('**/publish', async route => { requestId = route.request().postDataJSON().plan.requestId; await route.abort('failed'); }, { times: 1 });
  await page.locator('#stats-publish').click(); await statsIdle();
  await page.getByRole('button', { name: '文件脱敏', exact: true }).click();
  await page.locator('#redact-to-statistics').click(); await redactIdle();
  assert.match(await page.locator('#notice').innerText(), /等待确认/);
  assert.equal(JSON.parse(await page.evaluate(() => sessionStorage.getItem('mpk.statistics.pending.v1'))).requestId, requestId);
  await page.reload();
  await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await statsIdle();
  assert.equal(await page.locator('#stats-source').isVisible(), false);
  await redactSource(); await processRedaction();
  await page.locator('#redact-to-statistics').click(); await redactIdle(); await statsIdle();
  await page.locator('#stats-templates > summary').click();
  await page.locator('#stats-template-preset').selectOption('histogram'); await statsIdle();
  await page.locator('#stats-template-apply').click(); await statsIdle();
  let retry;
  await page.route('**/publish', async route => { retry = route.request().postDataJSON().plan.requestId; await route.continue(); }, { times: 1 });
  await page.locator('#stats-publish').click();
  await page.locator('#stats-complete').waitFor({ state: 'visible' }); await statsIdle();
  assert.equal(retry, requestId);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.4', '0.6', '1', '2']);
  assert.ok(!(await page.evaluate(() => JSON.stringify(sessionStorage))).includes('private-p1'));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

const ageControl = () => fieldControl('age').locator('..').locator('[data-boundaries]');
const dateControl = () => fieldControl('visit_date').locator('..').locator('[data-precision]');
const generalizationRows = [
  { person_id: 'private-p1', age: 23, visit_date: '2024-02-29', contact: 'secret-contact' },
  { person_id: 'private-p2', age: 46, visit_date: '2026-02-18', contact: 'secret-contact' },
];
let generalizedConfig;
async function generalizationExample() {
  await page.getByRole('button', { name: '文件脱敏', exact: true }).click();
  await page.locator('#redact-generalize-example').click(); await redactIdle();
}

test('age and date rules expose only active parameters and reuse exported version two across CSV and JSON', async () => {
  await page.reload(); await page.setViewportSize({ width: 1365, height: 1000 });
  await generalizationExample();
  assert.equal(await ageControl().isVisible(), true);
  assert.equal(await dateControl().isVisible(), true);
  assert.equal(await fieldControl('person_id').locator('..').locator('[data-boundaries]').isEnabled(), false);
  await fieldControl('age').focus(); await page.keyboard.press('Tab');
  assert.equal(await ageControl().evaluate(el => el === document.activeElement), true);
  await ageControl().fill('18，30，45，60');
  await dateControl().selectOption('year');
  await processRedaction();
  assert.match(await page.locator('#redact-preview').innerText(), /18-29/);
  assert.ok(!(await page.locator('#redact-preview').innerText()).includes('2026-01'));
  assert.match(await page.locator('#redact-summary').innerText(), /泛化 6 处/);
  await page.locator('#redact-template-save > summary').click();
  await page.locator('#redact-template-name').fill('年龄与年份');
  generalizedConfig = await saveDownload(() => page.locator('#redact-template-export').click(), 'generalized-template.json');
  const config = JSON.parse(readFileSync(generalizedConfig));
  assert.equal(config.schemaVersion, 2);
  assert.deepEqual(config.settings.fields[1].boundaries, [18, 30, 45, 60]);
  assert.equal(config.settings.fields[2].precision, 'year');
  assert.ok(!readFileSync(generalizedConfig, 'utf8').includes('unit-001'));
  await page.screenshot({ path: join(artifacts, 'generalization-desktop.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '文件脱敏', exact: true }).click();
  await page.locator('#redact-templates > summary').click();
  await page.locator('#redact-template-file').setInputFiles(generalizedConfig); await redactIdle();
  await page.locator('#redact-file').setInputFiles({ name: 'table.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(generalizationRows)) }); await redactIdle();
  assert.equal(await ageControl().isVisible(), false);
  assert.equal(await page.locator('#redact-template-apply').isEnabled(), true);
  await page.locator('#redact-template-apply').click(); await redactIdle();
  assert.equal(await ageControl().inputValue(), '18,30,45,60');
  assert.equal(await dateControl().inputValue(), 'year');
  await processRedaction();
  const output = await saveDownload(() => page.locator('#download-redacted').click(), 'generalized-data.json');
  assert.deepEqual(JSON.parse(readFileSync(output)), [
    { person_id: 'private-p1', age: '18-29', visit_date: '2024' },
    { person_id: 'private-p2', age: '45-59', visit_date: '2026' },
  ]);
});

test('invalid generalized data and edited parameters discard stale previews with actionable mobile errors', async () => {
  const invalidRows = [generalizationRows[0], { ...generalizationRows[1], visit_date: '2026-02-30' }];
  await page.locator('#redact-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidRows)) }); await redactIdle();
  assert.equal(await page.locator('#redact-result').isVisible(), false);
  assert.equal(await page.locator('#redact-template-apply').isEnabled(), false);
  assert.match(await page.locator('#redact-template-check').innerText(), /年龄或日期不符合规则/);
  await fieldControl('age').selectOption('age'); await fieldControl('visit_date').selectOption('date');
  await fieldControl('contact').selectOption('remove');
  await page.getByRole('button', { name: '处理并预览' }).click(); await redactIdle();
  assert.match(await page.locator('#notice').innerText(), /未跳过任何记录/);
  assert.ok(!(await page.locator('#notice').innerText()).includes('secret-contact'));
  assert.equal(await page.locator('#redact-result').isVisible(), false);
  await generalizationExample(); await processRedaction();
  await ageControl().fill('30,18');
  assert.equal(await page.locator('#redact-result').isVisible(), false);
  await page.getByRole('button', { name: '处理并预览' }).click(); await redactIdle();
  assert.match(await page.locator('#notice').innerText(), /递增整数/);
  await ageControl().fill('18,30,45,60'); await processRedaction();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'generalization-mobile.png'), fullPage: true });
  await fieldControl('age').selectOption('keep');
  assert.equal(await ageControl().isVisible(), false);
  assert.equal(await ageControl().isEnabled(), false);
  assert.equal(await page.locator('#redact-result').isVisible(), false);
});

test('generalized categories feed protected statistics without becoming identities or changing release recovery', async () => {
  await page.reload(); await page.setViewportSize({ width: 1365, height: 1000 });
  await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await statsIdle();
  await statsProject('年龄分布与恢复');
  await generalizationExample(); await processRedaction();
  await page.locator('#redact-to-statistics').click(); await redactIdle(); await statsIdle();
  assert.deepEqual(await page.locator('#stats-unit option').allTextContents(), ['请选择列', 'person_id']);
  assert.deepEqual(await page.locator('#stats-category option').allTextContents(), ['请选择列', 'person_id', 'age（已泛化）', 'visit_date（已泛化）']);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['1', '0', '1', '0']);
  await page.locator('#stats-query').selectOption('histogram');
  await page.locator('#stats-unit').selectOption('person_id');
  await page.locator('#stats-categories').fill('待复核类别');
  await page.locator('#stats-category').selectOption('age');
  assert.equal(await page.locator('#stats-categories').inputValue(), '待复核类别');
  await page.locator('#stats-use-age-categories').click();
  assert.equal(await page.locator('#stats-categories').inputValue(), '0-17\n18-29\n30-44\n45-59\n60+');
  await page.locator('#stats-category').selectOption('visit_date');
  assert.equal(await page.locator('#stats-use-age-categories').isVisible(), false);
  assert.equal(await page.locator('#stats-categories').inputValue(), '0-17\n18-29\n30-44\n45-59\n60+');
  const config = { schemaVersion: 1, kind: 'moonprivacykit/statistics-template', name: '年龄分布', settings: {
    query: 'histogram', unitField: 'age', categoryField: 'age', categories: ['0-17', '18-29', '30-44', '45-59', '60+'], epsilon: '0.3', maxContributions: 1,
  } };
  await page.locator('#stats-templates > summary').click();
  await page.locator('#stats-template-file').setInputFiles({ name: 'bad-unit.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) }); await statsIdle();
  assert.equal(await page.locator('#stats-template-apply').isEnabled(), false);
  assert.match(await page.locator('#stats-template-check').innerText(), /泛化列只能作为类别/);
  config.settings.unitField = 'person_id';
  await page.locator('#stats-template-file').setInputFiles({ name: 'age-statistics.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) }); await statsIdle();
  await page.locator('#stats-template-apply').click(); await statsIdle();
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['1', '0', '1', '0']);
  await page.locator('#stats-source summary').click();
  await page.screenshot({ path: join(artifacts, 'generalization-statistics-desktop.png'), fullPage: true });
  let first, saved;
  await page.route('**/publish', async route => {
    first = route.request().postDataJSON();
    const response = await route.fetch(); saved = await response.json();
    await route.abort('failed');
  }, { times: 1 });
  await page.locator('#stats-publish').click(); await statsIdle();
  assert.equal(saved.ok, true);
  assert.equal(await page.locator('#stats-pending').isVisible(), true);
  assert.ok(!first.input.includes('example.test') && !first.input.includes('2026-01-08'));
  assert.match(first.input, /18-29/);
  await page.getByRole('button', { name: '文件脱敏', exact: true }).click();
  await page.locator('#redact-to-statistics').click(); await redactIdle();
  assert.match(await page.locator('#notice').innerText(), /等待确认/);
  await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await statsIdle();
  let retried;
  await page.route('**/publish', async route => { retried = route.request().postDataJSON(); await route.continue(); }, { times: 1 });
  await page.locator('#stats-publish').click();
  await page.locator('#stats-complete').waitFor({ state: 'visible' }); await statsIdle();
  assert.deepEqual(retried, first);
  const output = await saveDownload(() => page.getByRole('button', { name: '下载这份报告', exact: true }).click(), 'generalized-report.json');
  assert.deepEqual(JSON.parse(readFileSync(output)), saved.data);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), ['0.7', '0.3', '1', '1']);
  assert.ok(!(await page.evaluate(() => JSON.stringify(sessionStorage))).includes('unit-001'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, 'generalization-statistics-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('current questionnaire transfers mixed parameters to precise per-question assessment without publishing', async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload(); await statsIdle();
  await page.locator('#survey-templates summary').click();
  await page.locator('#survey-preset').selectOption('team');
  await page.locator('#survey-template-apply').click();
  await page.locator('#question-editor [data-field=epsilon]').nth(0).fill('0.5');
  await page.locator('#question-editor [data-field=epsilon]').nth(1).fill('1.5');
  await page.locator('#survey-collections').fill('3');
  const surveyFile = await saveDownload(() => page.getByRole('button', { name: '导出问卷配置', exact: true }).click(), 'assessed-survey.json');
  const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
  const mutations = [];
  const monitor = request => { if (request.method() !== 'GET') mutations.push(request.url()); };
  page.on('request', monitor);
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(artifacts, 'workbench-survey-desktop.png'), fullPage: true });
    await page.locator('#survey-evaluate').click();
    assert.equal(await page.locator('#plan-mode-survey').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#plan-uniform-fields [name=categories]').isDisabled(), true);
    assert.equal(await page.locator('#plan-form [name=collections]').inputValue(), '3');
    await page.locator('#plan-run').click();
    await page.getByRole('button', { name: '导出逐题评估' }).waitFor();
    assert.equal(await page.locator('.precision-list>li').count(), 2);
    const path = await saveDownload(() => page.getByRole('button', { name: '导出逐题评估' }).click(), 'question-assessment.json');
    const report = JSON.parse(readFileSync(path));
    assert.equal(report.surveyFingerprint, await surveyFingerprint(JSON.parse(readFileSync(surveyFile))));
    assert.deepEqual(report.assessment.questions.map(q => q.categories), [2, 3]);
    assert.deepEqual(report.assessment.questions.map(q => q.epsilon), [0.5, 1.5]);
    assert.equal(report.assessment.total_epsilon, 6);
    assert.equal(report.assessment.target_met, false);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(artifacts, 'question-assessment-desktop.png'), fullPage: true });
    await page.locator('#plan-form [name=samples]').fill(String(report.assessment.required_samples));
    assert.equal(await page.getByRole('button', { name: '导出逐题评估' }).count(), 0);
    await page.locator('#plan-run').click();
    await page.getByRole('heading', { name: '当前人数达到设定的精度目标' }).waitFor();
    const a = await saveDownload(() => page.getByRole('button', { name: '导出逐题评估' }).click(), 'precision-met.json');
    const b = await saveDownload(() => page.getByRole('button', { name: '导出逐题评估' }).click(), 'precision-met-retry.json');
    assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
    assert.equal(await page.evaluate(() => JSON.stringify({ ...sessionStorage })), storage);
    assert.deepEqual(mutations, []);
  } finally { page.off('request', monitor); }
});

test('editing a transferred questionnaire invalidates its report and zero-signal questions remain explainable', async () => {
  await page.locator('#plan-edit').click();
  await page.locator('#question-editor [data-field=epsilon]').nth(0).fill('0');
  await page.getByRole('button', { name: '效果评估', exact: true }).click();
  assert.match(await page.locator('#plan-survey-state').innerText(), /问卷已修改/);
  assert.equal(await page.locator('#plan-run').isEnabled(), false);
  assert.equal(await page.getByRole('button', { name: '导出逐题评估' }).count(), 0);
  await page.locator('#plan-reload').click();
  await page.locator('#plan-run').click();
  await page.getByRole('heading', { name: '有题目无法估计真实比例' }).waitFor();
  assert.match(await page.locator('.precision-list>li').nth(0).innerText(), /无统计信号/);
  assert.equal(await page.locator('.precision-bar').count(), 1);
  const file = await saveDownload(() => page.getByRole('button', { name: '导出逐题评估' }).click(), 'no-signal.json');
  assert.equal(JSON.parse(readFileSync(file)).assessment.questions[0].radius, null);
  await page.locator('#plan-mode-custom').click();
  assert.equal(await page.locator('#plan-uniform-fields [name=categories]').isEnabled(), true);
  await page.locator('#plan-form [name=categories]').fill('256');
  await page.locator('#plan-form [name=epsilon]').fill('0.01');
  await page.locator('#plan-form [name=radius]').fill('0.01');
  await page.locator('#plan-run').click();
  assert.match(await page.locator('#plan-result').innerText(), /超过 1,000 万人/);
  await page.locator('#plan-mode-survey').click();
  assert.match(await page.locator('#plan-survey-description').innerText(), /单次 ε ≈ 1.5/);
});

test('questionnaire precision labels render safely with accessible bars across desktop tablet and mobile', async () => {
  await page.locator('#plan-edit').click();
  await page.locator('#question-editor [data-field=epsilon]').nth(0).fill('0.5');
  const label = '<img src=x onerror=alert(1)>' + '待评估问题'.repeat(25);
  await page.locator('#question-editor [data-field=title]').nth(0).fill(label);
  await page.locator('#survey-evaluate').click();
  await page.locator('#plan-form [name=radius]').fill('5');
  await page.locator('#plan-form [name=samples]').fill('1000');
  await page.locator('#plan-run').click();
  await page.getByRole('button', { name: '导出逐题评估' }).waitFor();
  assert.equal(await page.locator('#plan-result img').count(), 0);
  assert.equal(await page.locator('.precision-bar[role=img][aria-label]').count(), 2);
  for (const width of [900, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(artifacts, 'question-assessment-mobile.png'), fullPage: true });
  await page.locator('#plan-form [name=radius]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-run');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(await page.locator('#plan-run').evaluate(node => getComputedStyle(node).transitionDuration === '0s'));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

test('changing assessment inputs while a fingerprint is pending discards the old result', async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    const original = crypto.subtle.digest;
    window.restoreAssessmentDigest = () => { crypto.subtle.digest = original; };
    crypto.subtle.digest = function (...args) {
      return new Promise((resolve, reject) => { window.finishAssessmentDigest = () => original.apply(this, args).then(resolve, reject); });
    };
  });
  try {
    await page.locator('#plan-run').click();
    await page.waitForFunction(() => typeof window.finishAssessmentDigest === 'function');
    await page.locator('#plan-form [name=samples]').fill('2000');
    await page.evaluate(async () => { await window.finishAssessmentDigest(); });
    await page.waitForFunction(() => !document.getElementById('plan-run').disabled);
    assert.equal(await page.getByRole('button', { name: '导出逐题评估' }).count(), 0);
    assert.match(await page.locator('#plan-result').innerText(), /方案已修改/);
  } finally { await page.evaluate(() => { window.restoreAssessmentDigest(); delete window.restoreAssessmentDigest; delete window.finishAssessmentDigest; }); }
  await page.locator('#plan-run').click();
  await page.getByRole('button', { name: '导出逐题评估' }).waitFor();
  const file = await saveDownload(() => page.getByRole('button', { name: '导出逐题评估' }).click(), 'updated-assessment.json');
  assert.equal(JSON.parse(readFileSync(file)).assessment.samples, 2000);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
