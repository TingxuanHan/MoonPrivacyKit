import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbenchServer } from '../runtime/workbench-server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'mpk-workflow-ui-'));
const artifacts = resolve(process.env.UI_ARTIFACTS_DIR || join(root, 'reports/ui'));
let server, origin, browser, page;
const errors = [], external = [], writes = [];
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
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); if (request.method() !== 'GET') writes.push(request.method()); });
  await page.goto(origin); await click('发布检查'); await click('隐私流程检查');
});
afterEach(async () => { await page.close(); });
const click = name => page.getByRole('button', { name, exact: true }).click();
async function save(label) {
  const promise = page.waitForEvent('download'); await click(label);
  return readFileSync(await (await promise).path(), 'utf8');
}
async function preset(value) { await page.getByLabel('示例情形').selectOption(value); await click('载入流程示例'); }
async function openStep(number) { await page.locator('#workflow-tool summary').filter({ hasText: new RegExp(`^第 ${number} 步`) }).click(); }
const file = text => ({ name: 'workflow.json', mimeType: 'application/json', buffer: Buffer.from(text) });

test('workbench checks declared lineage, reuses exports and invalidates a changed plan', async () => {
  await page.screenshot({ path: join(artifacts, 'workflow-editor-desktop.png'), fullPage: true });
  await click('检查流程'); await page.getByRole('heading', { name: '声明条件相容' }).waitFor();
  const report = await save('下载内部流程检查'); assert.equal(await save('下载内部流程检查'), report);
  assert.equal(JSON.parse(report).budget.planned_epsilon_units, 300000);
  assert.equal(JSON.parse(report).budget.charged, false);
  assert.match(await page.locator('#workflow-result').innerText(), /敏感度 30/);
  await page.locator('#workflow-result').screenshot({ path: join(artifacts, 'workflow-result-desktop.png') });
  await openStep(4); await page.getByLabel('第 4 步发布预算 ε').fill('0.9');
  assert.match(await page.locator('#workflow-tool summary').filter({ hasText: /^第 4 步/ }).innerText(), /0.9/);
  assert.equal(await page.locator('#workflow-result').isVisible(), false);
  await click('检查流程'); await page.getByRole('heading', { name: '发现衔接问题' }).waitFor();
  assert.match(await page.locator('#workflow-result').innerText(), /超过剩余预算/);
});

test('ordinary controls explain early identity deletion, private bounds and exact joint output', async () => {
  await preset('missing'); await click('检查流程');
  await page.getByRole('heading', { name: '发现衔接问题' }).waitFor();
  assert.match(await page.locator('#workflow-result').innerText(), /人员标识缺失/);
  await click('查看此步骤'); assert.equal(await page.getByLabel('第 2 步操作').isVisible(), true);
  await openStep(1);
  await page.getByLabel('第 1 步保留字段').fill('person,score');
  await click('检查流程'); await page.getByRole('heading', { name: '声明条件相容' }).waitFor();
  await preset('private'); await click('检查流程');
  await page.getByRole('heading', { name: '发现衔接问题' }).waitFor();
  await click('查看此步骤'); await page.getByLabel('第 3 步数值上界来源').selectOption('unknown'); await click('检查流程');
  await page.getByRole('heading', { name: '流程尚无法验证' }).waitFor();
  await preset('joint'); await click('检查流程');
  await page.getByRole('heading', { name: '发现衔接问题' }).waitFor();
  assert.match(await page.locator('#workflow-result').innerText(), /加密计算不自动保护公开输出/);
});

test('import preserves graph branches and ambiguous JSON does not keep an old conclusion', async () => {
  const plan = JSON.parse(readFileSync(join(root, 'examples/privacy-workflow.json'), 'utf8'));
  plan.steps.push({ id: 'second', op: 'dp_release', input: 'total', settings: { epsilon_units: 500000, trust: 'trusted_holder' } });
  plan.outputs.push({ node: 'second', audience: 'public' });
  await page.getByLabel('导入已有流程方案').setInputFiles(file(JSON.stringify(plan)));
  await page.locator('#workflow-tool summary').filter({ hasText: /^第 6 步/ }).waitFor();
  assert.deepEqual(JSON.parse(await save('保存流程方案')), plan);
  await click('检查流程'); await page.getByRole('heading', { name: '声明条件相容' }).waitFor();
  assert.equal(JSON.parse(await save('下载内部流程检查')).budget.remaining_after_plan_units, 0);
  await page.getByLabel('导入已有流程方案').setInputFiles(file(JSON.stringify(plan).replace('"schema_version":1', '"schema_version":1,"schema_version":2')));
  await page.locator('#workflow-tool .notice.error').waitFor();
  assert.equal(await page.locator('#workflow-result').isVisible(), false);
});

test('narrow-screen workflow supports keyboard execution without overflow or external writes', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preset('missing');
  await page.getByRole('button', { name: '检查流程', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '发现衔接问题' }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(artifacts, 'workflow-mobile.png') });
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []);
});
