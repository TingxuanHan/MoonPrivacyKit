import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callCore, surveyFingerprint } from '../runtime/client.mjs';
import { renderReport } from '../runtime/report-export.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mpk-report-ui-'));
const artifacts = resolve(process.env.UI_ARTIFACTS_DIR || join(root, 'reports/ui'));
const origin = 'http://127.0.0.1:4186';
let server, browser, context, page;
const errors = [], external = [];
before(async () => {
  mkdirSync(artifacts, { recursive: true });
  server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, env: { ...process.env, PORT: '4186', MPK_DATA_DIR: join(scratch, 'projects') }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ready, reject) => { server.stdout.once('data', ready); server.once('error', reject); server.once('exit', () => reject(new Error('Test server failed to start.'))); });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
});
after(async () => { await browser?.close(); server?.kill(); });
const file = (name, value) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
async function download(name, label = '下载可读报告（HTML）') {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const output = await event, path = join(artifacts, name);
  await output.saveAs(path);
  return path;
}
async function idle() { await page.waitForFunction(() => !document.querySelector('#stats-refresh').disabled); }
async function inspectOffline(path, kind, check, long = false) {
  const isolated = await browser.newContext({ offline: true, viewport: { width: 1200, height: 950 } });
  try {
    const doc = await isolated.newPage(), requests = [], failures = [];
    doc.on('request', request => { if (!request.url().startsWith('file:')) requests.push(request.url()); });
    doc.on('pageerror', error => failures.push(error.message));
    await doc.goto(pathToFileURL(path).href);
    await check(doc);
    assert.equal(await doc.locator('script,img,iframe,object,embed,form').count(), 0);
    assert.equal(await doc.locator('html').getAttribute('lang'), 'zh-CN');
    assert.ok(await doc.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (!long) await doc.screenshot({ path: join(artifacts, `report-${kind}-desktop.png`), fullPage: true });
    for (const width of [390, 320]) {
      await doc.setViewportSize({ width, height: 844 });
      assert.ok(await doc.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await doc.screenshot({ path: join(artifacts, `report-${kind}-mobile.png`), fullPage: true });
    await doc.setViewportSize({ width: 794, height: 1123 });
    await doc.emulateMedia({ media: 'print' });
    assert.equal(await doc.locator('.hint').isVisible(), false);
    assert.ok(await doc.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await doc.locator('thead').first().evaluate(node => getComputedStyle(node).display), 'table-header-group');
    if (!long) await doc.screenshot({ path: join(artifacts, `report-${kind}-print.png`), fullPage: true });
    assert.deepEqual(requests, []); assert.deepEqual(failures, []);
  } finally { await isolated.close(); }
}

test('survey results export readable offline documents with matching parameters and no response identities', async () => {
  await page.goto(origin);
  const survey = { schema_version: 1, id: 'demo-report', title: '虚构团队意见调查', questions: [
    { id: 'q1', title: '你对目前的协作方式满意吗？', options: ['满意', '一般', '不满意'], epsilon: 2 },
    { id: 'q2', title: '你希望优先改进什么？', options: ['沟通', '工具', '安排'], epsilon: 1.5 },
  ] };
  const fingerprint = await surveyFingerprint(survey);
  // Synthetic responses exercise the actual aggregate file workflow.
  const responses = Array.from({ length: 300 }, (_, i) => callCore({ op: 'protect', survey, fingerprint, response_id: i.toString(16).padStart(32, '0'), answers: [i % 3, (i + 1) % 3], gates: [16777215, 16777215], fallbacks: [i % 3, Math.floor(i / 3) % 3] }));
  await page.getByRole('button', { name: '汇总结果', exact: true }).click();
  await page.locator('#collect-survey').setInputFiles(file('survey.json', survey));
  await page.locator('#collect-files').setInputFiles(responses.map((response, i) => file(`response-${i}.json`, response)));
  await page.getByRole('button', { name: '计算群体结果' }).click();
  await page.getByRole('heading', { name: '300 份有效回答' }).waitFor();
  const json = await download('readable-survey.json', '导出统计报告');
  const html = await download('readable-survey.html'), again = await download('readable-survey-again.html');
  const source = JSON.parse(readFileSync(json));
  assert.equal(readFileSync(html, 'utf8'), renderReport('survey', source));
  assert.equal(readFileSync(html, 'utf8'), readFileSync(again, 'utf8'));
  assert.ok(!readFileSync(html, 'utf8').includes(responses[0].response_id));
  await inspectOffline(html, 'survey', async doc => {
    assert.equal(await doc.locator('h1').textContent(), survey.title);
    assert.equal(await doc.locator('tbody tr').count(), 6);
    assert.match(await doc.locator('body').innerText(), /每人单次开销 ε\s+3.5/);
    assert.ok((await doc.locator('body').innerText()).includes(fingerprint));
  });
  await page.locator('#collect-files').setInputFiles(file('retry.json', responses[0]));
  assert.equal(await page.locator('#collect-result').isVisible(), false);
});

test('both assessment modes export safely and input changes remove stale downloads', async () => {
  await page.goto(origin);
  await page.locator('#survey-title').fill('精度报告示例');
  const hostile = '<img src="https://example.invalid/leak" onerror="alert(1)">' + '长问题'.repeat(35);
  await page.locator('#question-editor [data-field=title]').fill(hostile);
  await page.locator('#question-editor [data-field=epsilon]').fill('0');
  await page.locator('#survey-evaluate').click();
  await page.locator('#plan-run').click();
  await page.getByRole('button', { name: '导出逐题评估', exact: true }).waitFor();
  const html = await download('readable-assessment.html');
  await inspectOffline(html, 'assessment', async doc => {
    assert.match(await doc.locator('body').innerText(), /增加人数不能解决/);
    assert.ok((await doc.locator('body').innerText()).includes(hostile));
  }, true);
  await page.locator('#plan-form [name=samples]').fill('2000');
  assert.equal(await page.getByRole('button', { name: '下载可读报告（HTML）', exact: true }).count(), 0);
  await page.locator('#plan-mode-custom').click();
  await page.locator('#plan-form [name=radius]').fill('0.01');
  await page.locator('#plan-run').click();
  const plan = await download('readable-plan.html');
  assert.match(readFileSync(plan, 'utf8'), /超过 1,000 万人/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: '导出评估结果', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '下载可读报告（HTML）');
  await page.screenshot({ path: join(artifacts, 'report-actions-mobile.png'), fullPage: true });
});

test('interrupted publication and history export the same protected report without new requests or spending', async () => {
  await page.setViewportSize({ width: 1365, height: 1000 });
  await page.goto(origin);
  await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await idle();
  await page.locator('#stats-name').fill('仅限持有方的项目名');
  await page.locator('#stats-total').fill('1');
  await page.getByRole('button', { name: '创建项目', exact: true }).click(); await idle();
  await page.locator('#stats-file').setInputFiles({ name: 'private.csv', mimeType: 'text/csv', buffer: Buffer.from('person,name,choice\nprivate-person-a,private-name-a,满意\nprivate-person-b,private-name-b,一般') }); await idle();
  await page.locator('#stats-query').selectOption('histogram');
  await page.locator('#stats-unit').selectOption('person');
  await page.locator('#stats-category').selectOption('choice');
  await page.locator('#stats-categories').fill('满意\n一般');
  await page.locator('#stats-epsilon').fill('0.2');
  let saved, postCount = 0;
  page.on('request', request => { if (request.method() === 'POST') postCount++; });
  await page.route('**/publish', async route => { saved = (await (await route.fetch()).json()).data; await route.abort('failed'); }, { times: 1 });
  await page.locator('#stats-publish').click(); await idle();
  await page.locator('#stats-pending').waitFor({ state: 'visible' });
  await page.locator('#stats-recover').click(); await idle();
  await page.locator('#stats-report').waitFor({ state: 'visible' });
  const baselinePosts = postCount, beforeBudget = await page.locator('#stats-budget dd').allTextContents();
  assert.deepEqual(beforeBudget, ['0.8', '0.2', '1', '1']);
  const html = await download('readable-statistics.html');
  const json = await download('readable-statistics.json', '下载这份报告');
  assert.deepEqual(JSON.parse(readFileSync(json)), saved);
  assert.equal(readFileSync(html, 'utf8'), renderReport('statistics', saved));
  for (const secret of ['private-person', 'private-name', '仅限持有方的项目名']) assert.ok(!readFileSync(html, 'utf8').includes(secret));
  await inspectOffline(html, 'statistics', async doc => {
    assert.equal(await doc.locator('h1').textContent(), '受保护类别分布');
    assert.deepEqual(await doc.locator('tbody tr td:nth-child(2)').allTextContents(), saved.report.counts.map(String));
  });
  await page.reload(); await page.getByRole('button', { name: '隐私统计', exact: true }).click(); await idle();
  await page.locator('#stats-history-tab').click(); await idle();
  await page.getByRole('button', { name: '查看第 1 次报告', exact: true }).click(); await idle();
  const recovered = await download('readable-statistics-history.html');
  assert.equal(readFileSync(recovered, 'utf8'), readFileSync(html, 'utf8'));
  assert.equal(postCount, baselinePosts);
  assert.deepEqual(await page.locator('#stats-budget dd').allTextContents(), beforeBudget);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
