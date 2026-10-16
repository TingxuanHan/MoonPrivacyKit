import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbenchServer } from '../runtime/workbench-server.mjs';
import { createCredentialIssuer, issueCredential, createCredentialCollector, redeemCredential } from '../runtime/credentials.mjs';
import { protectResponse } from '../runtime/client.mjs';
import { createAggregateIdentity, createAggregateNode, registerAggregateTask, acceptAggregatePacket, finalizeAggregateNode, validateAggregateTask } from '../runtime/secure-aggregation.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url)), scratch = mkdtempSync(join(tmpdir(), 'mpk-advanced-ui-'));
const artifacts = resolve(process.env.UI_ARTIFACTS_DIR || join(root, 'reports/ui'));
let server, origin, browser, page, session;
const errors = [], external = [];
before(async () => {
  mkdirSync(artifacts, { recursive: true });
  server = createWorkbenchServer({ root, dataDir: join(scratch, 'projects') });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${server.address().port}`;
  session = (await (await fetch(origin + '/api/session')).json()).data.token;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  page = await browser.newPage({ viewport: { width: 1365, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()); });
});
after(async () => { await browser?.close(); await new Promise(r => server?.close(r)); });
const file = (name, value) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
const click = name => page.getByRole('button', { name, exact: true }).click();
async function save(label) { const promise = page.waitForEvent('download'); await click(label); const item = await promise; const path = await item.path(); return readFileSync(path, 'utf8'); }
async function api(path, body) { const response = await fetch(origin + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { origin, 'x-moonprivacykit-token': session, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return (await response.json()).data; }
async function openReview(tab) { await page.goto(origin); await click('发布检查'); if (tab) await click(tab); }

test('report inspection shows the inference, preserves history and invalidates stale exports', async () => {
  await openReview(); await click('载入虚构示例'); await page.getByLabel('共同统计范围').fill('synthetic-team-october');
  await click('检查能否反推'); await page.getByRole('heading', { name: '发现可反推风险' }).waitFor();
  assert.match(await page.locator('#disclosure-result').innerText(), /C：可推断范围 1 至 1/);
  const report = JSON.parse(await save('下载内部检查报告'));
  assert.deepEqual(report.report.repairs.map(r => r.remove_drafts), [['待发布类别B']]);
  await page.screenshot({ path: join(artifacts, 'disclosure-desktop.png'), fullPage: true });
  await page.getByLabel('精确人数').last().fill('15'); assert.equal(await page.locator('#disclosure-result').isVisible(), false);
});

test('person-level publication recovers a lost response and shares one existing budget', async () => {
  const project = await api('projects', { name: '多表浏览器测试', totalEpsilon: '1' });
  await openReview('按人保护的多表统计'); await click('刷新项目'); await page.getByLabel('共用统计项目').selectOption(project.id);
  await page.getByLabel('左表：人员或活动记录').setInputFiles(file('left.json', [{ person: 'a' }, { person: 'b' }]));
  await page.getByLabel('右表：同一人员的数值记录').setInputFiles(file('right.json', [{ person: 'a', hours: 4 }, { person: 'b', hours: 7 }]));
  await page.getByLabel('本次发布预算 ε', { exact: true }).last().fill('0.5');
  await page.route('**/publish-person', async route => { await route.fetch(); await route.abort(); });
  await click('发布受保护多表统计'); await page.locator('#person-tool .notice.error').waitFor();
  const before = await api(`projects/${project.id}/status`); assert.equal(before.release_count, 1);
  await page.unroute('**/publish-person'); await page.reload(); await click('发布检查'); await click('按人保护的多表统计'); await click('恢复待确认报告');
  await page.getByRole('heading', { name: '受保护总和已保存' }).waitFor();
  const json = await save('下载已保存的报告'); assert.equal(json, await save('下载已保存的报告'));
  assert.match(await save('下载可读报告（HTML）'), /受保护有界整数和/);
  assert.deepEqual(await api(`projects/${project.id}/status`), before);
  assert.equal(JSON.stringify(JSON.parse(json)).includes('person'), false);
});

test('browser blind credentials interoperate with issuer and atomic collector', async () => {
  const survey = JSON.parse(readFileSync(new URL('../examples/survey.json', import.meta.url)));
  const issuer = join(scratch, 'issuer.sqlite'), collector = join(scratch, 'collector.sqlite');
  const { manifest, enrollment } = await createCredentialIssuer(issuer, survey, ['eligible-one']);
  await createCredentialCollector(collector, manifest, survey);
  await page.goto(origin); await click('协作工具');
  await page.getByLabel('组织者的凭证公开配置').setInputFiles(file('manifest.json', manifest)); await click('准备签发请求');
  await page.getByRole('heading', { name: '先保存私有状态，再发送签发请求' }).waitFor();
  const state = JSON.parse(await save('保存私有状态')), request = JSON.parse(await save('下载签发请求'));
  assert.ok(!JSON.stringify(request).includes(state.prepared));
  const signed = await issueCredential(issuer, { ...enrollment[0], request });
  await page.getByLabel('签发方返回的签名响应').setInputFiles(file('signed.json', signed)); await click('核验并生成凭证');
  await page.getByRole('heading', { name: '凭证核验通过' }).waitFor();
  const answer = await protectResponse(survey, survey.questions.map(() => 0));
  await page.getByLabel('填写时的原问卷配置').setInputFiles(file('survey.json', survey));
  await page.getByLabel('已生成的受保护回答').setInputFiles(file('response.json', answer)); await click('生成参与提交包');
  await page.getByRole('heading', { name: '提交包已准备好' }).waitFor();
  const submission = JSON.parse(await save('下载参与提交包'));
  assert.deepEqual(await redeemCredential(collector, submission), await redeemCredential(collector, submission));
  assert.ok(!(await page.locator('body').innerText()).includes(submission.token.prepared));
  await page.getByLabel('已生成的受保护回答').setInputFiles(file('changed.json', {})); assert.equal(await page.getByRole('button', { name: '下载参与提交包' }).isVisible(), false);
});

test('browser encrypted shares and signed joint results interoperate with independent node stores', async () => {
  const identities = ['p1', 'p2', 'p3'].map(createAggregateIdentity), files = [join(scratch, 'A.sqlite'), join(scratch, 'B.sqlite')];
  const task = { schema_version: 1, kind: 'moonprivacykit/two-server-sum', task_id: 'browser-task', participants: identities.map(i => i.participant), nodes: files.map((p, i) => createAggregateNode(p, i ? 'B' : 'A')), labels: ['参与次数', '总时长'], value_upper: 10 };
  files.forEach(p => registerAggregateTask(p, task));
  await page.goto(origin); await click('协作工具'); await click('联合统计');
  await page.getByLabel('共同确认的联合统计任务').setInputFiles(file('task.json', task)); await click('载入联合任务');
  await page.getByLabel('参与次数', { exact: true }).waitFor();
  for (let i = 0; i < identities.length; i++) {
    await page.getByLabel('自己保管的参与方身份文件').setInputFiles(file('identity.json', identities[i]));
    await page.getByLabel('参与次数', { exact: true }).fill(String(i + 1)); await page.getByLabel('总时长', { exact: true }).fill(String(i + 2));
    await click('生成分别交付的加密文件'); await page.getByRole('heading', { name: '分别交给 A、B 两个聚合方' }).waitFor();
    for (const [index, role] of ['A', 'B'].entries()) {
      const bytes = await save(`下载发给 ${role} 的文件`); assert.equal(bytes, await save(`下载发给 ${role} 的文件`));
      const packet = JSON.parse(bytes); assert.equal(Object.hasOwn(packet, 'share'), false); acceptAggregatePacket(files[index], packet);
    }
  }
  const fp = validateAggregateTask(task).fingerprint;
  const parts = files.map(p => finalizeAggregateNode(p, fp));
  await page.getByLabel('聚合方 A 的签名合计').setInputFiles(file('A.json', parts[0])); await page.getByLabel('聚合方 B 的签名合计').setInputFiles(file('B.json', parts[1]));
  await click('核验并合并结果'); await page.getByRole('heading', { name: '双方签名与任务一致' }).waitFor();
  const report = JSON.parse(await save('下载联合统计结果')); assert.deepEqual(report.totals, [6, 9]);
  await page.getByLabel('聚合方 A 的签名合计').setInputFiles(file('bad.json', { ...parts[0], sum: [0, 0] }));
  await click('核验并合并结果'); await page.locator('#joint-tool .notice.error').waitFor(); assert.equal(await page.locator('#joint-result').isVisible(), false);
});

test('new tools fit narrow screens, expose keyboard focus and make no external requests', async () => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [view, sub] of [['发布检查', '报表防反推'], ['发布检查', '按人保护的多表统计'], ['协作工具', '匿名参与凭证'], ['协作工具', '联合统计']]) {
      await click(view); await click(sub);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${sub} overflow at ${width}`);
    }
  }
  await page.keyboard.press('Tab'); assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY');
  await page.screenshot({ path: join(artifacts, 'joint-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
