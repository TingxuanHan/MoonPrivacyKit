import { prepareCredential, finalizeCredential, validateCredentialPublic } from '/dist/credential-client.js';
import { validateJointTask, prepareJointPackets, combineJointParts } from '/runtime/joint-client.mjs';
import { surveyFingerprint } from '/runtime/client.mjs';

export function initCollaboration(credentialRoot, jointRoot, ui) {
  const { e, text, button, field, file, read, panel, row, note, controller, callCore, download } = ui;
  const run = controller(credentialRoot), manifest = file('组织者的凭证公开配置');
  const stateFile = file('恢复自己保存的私有状态'), signed = file('签发方返回的签名响应');
  const survey = file('填写时的原问卷配置'), response = file('已生成的受保护回答');
  const requestBox = e('div', { class: 'result-box', hidden: true }), tokenBox = e('div', { class: 'result-box', hidden: true });
  const submissionBox = e('div', { class: 'result-box', hidden: true });
  let prepared, token, publicConfig;
  function clear() { prepared = token = publicConfig = undefined; requestBox.hidden = tokenBox.hidden = submissionBox.hidden = true; }
  function showState() {
    requestBox.replaceChildren(text('h3', '先保存私有状态，再发送签发请求'), note('私有状态仅留在自己的设备。签发请求交给资格核验方；身份核验资料不要交给收卷方。重新下载复用同一请求。'), row(button('保存私有状态', () => download('private-credential-state.json', prepared.state)), ...(prepared.request ? [button('下载签发请求', () => download('credential-request.json', prepared.request))] : [])));
    requestBox.hidden = false;
  }
  manifest.input.addEventListener('change', clear);
  stateFile.input.addEventListener('change', () => run(async () => {
    const config = await read(manifest.input), state = await read(stateFile.input);
    const valid = await validateCredentialPublic(config);
    if (state.kind !== 'moonprivacykit/private-credential-state' || state.context !== valid.contextId) throw new Error('私有状态不属于当前公开配置。');
    publicConfig = config; prepared = { state }; token = undefined; tokenBox.hidden = submissionBox.hidden = true; showState();
  }));
  [signed, survey, response].forEach(f => f.input.addEventListener('change', () => { submissionBox.hidden = true; if (f === signed) { token = undefined; tokenBox.hidden = true; } }));
  credentialRoot.append(panel('1. 领取匿名参与凭证', [note('组织者先核验资格并签发，每个资格限一次。所有人须使用同一可信公开配置。凭证保护签发与兑换的关联，但传送时间、网络地址和文件内容仍可能暴露身份。'), manifest.node, row(button('准备签发请求', () => run(async () => {
    if (prepared) throw new Error('已有请求或私有状态，请使用它完成签发。重新生成可能耗掉唯一资格。');
    publicConfig = await read(manifest.input); prepared = await prepareCredential(publicConfig); showState();
  }), { class: 'primary' })), requestBox, e('details', {}, [text('summary', '中途离开后恢复'), stateFile.node])]),
  panel('2. 完成凭证', [signed.node, row(button('核验并生成凭证', () => run(async () => {
    if (!prepared || !publicConfig) throw new Error('请先准备请求或恢复私有状态。');
    token = await finalizeCredential(publicConfig, prepared.state, await read(signed.input));
    tokenBox.replaceChildren(text('h3', '凭证核验通过'), text('p', '凭证相当于一次参与资格，请妥善保管，不要公开。'), button('保存参与凭证', () => download('private-participation-token.json', token))); tokenBox.hidden = false;
  }), { class: 'primary' })), tokenBox]),
  panel('3. 绑定受保护回答', [text('p', '先到“隐私问卷”填写并下载受保护回答，再在这里生成交给收卷方的提交包。'), survey.node, response.node, row(button('生成参与提交包', () => run(async () => {
    if (!token) throw new Error('请先完成凭证。');
    const s = await read(survey.input), r = await read(response.input), fingerprint = await surveyFingerprint(s);
    if (fingerprint !== publicConfig.context.survey_fingerprint) throw new Error('问卷与凭证不属于同一调查。');
    callCore({ op: 'validateCredentialResponse', survey: s, fingerprint, response: r });
    const submission = { token: structuredClone(token), response: r };
    submissionBox.replaceChildren(text('h3', '提交包已准备好'), text('p', '仅交给收卷方。重试请使用同一包；收卷方会原子核验资格并返回回执。此处尚未提交。'), button('下载参与提交包', () => download('private-survey-submission.json', submission))); submissionBox.hidden = false;
  }), { class: 'primary' })), submissionBox]));

  const jointRun = controller(jointRoot), task = file('共同确认的联合统计任务'), identity = file('自己保管的参与方身份文件');
  const values = e('div', { class: 'two-col', id: 'joint-values' }), taskSummary = text('p', '先载入任务，查看参与方与统计项。', { role: 'status' });
  const packetsBox = e('div', { class: 'result-box', id: 'joint-packets', hidden: true });
  const partA = file('聚合方 A 的签名合计'), partB = file('聚合方 B 的签名合计'), reportBox = e('div', { class: 'result-box', id: 'joint-result', hidden: true });
  let jointTask, packetSnapshot;
  const resetPackets = () => { packetsBox.hidden = true; packetSnapshot = undefined; };
  task.input.addEventListener('change', () => { jointTask = undefined; values.replaceChildren(); taskSummary.textContent = '任务已改变，请重新载入。'; resetPackets(); reportBox.hidden = true; });
  identity.input.addEventListener('change', resetPackets);
  values.addEventListener('input', resetPackets);
  [partA, partB].forEach(f => f.input.addEventListener('change', () => { reportBox.hidden = true; }));
  jointRoot.append(panel('1. 确认同一任务', [note('至少三个参与方，两个独立聚合方。适用于参与方遵守协议且至少一方不串通的场景；结果为精确合计，尚无差分隐私保护。不要借助多次重叠任务反推个人。'), task.node, row(button('载入联合任务', () => jointRun(async () => {
    const checked = await validateJointTask(await read(task.input)); jointTask = checked.manifest; resetPackets(); reportBox.hidden = true;
    taskSummary.textContent = `${jointTask.task_id} · ${jointTask.participants.length} 个固定参与方 · 每项范围 0–${jointTask.value_upper}。所有人须确认相同任务指纹：${checked.fingerprint}`;
    values.replaceChildren(...jointTask.labels.map(label => field(label, { type: 'number', min: 0, max: jointTask.value_upper, step: 1, value: 0 }).node));
  }))), taskSummary]),
  panel('2. 参与方准备两个加密文件', [identity.node, values, row(button('生成分别交付的加密文件', () => jointRun(async () => {
    if (!jointTask) throw new Error('请先载入联合任务。');
    if (packetSnapshot) throw new Error('本次文件已经生成，请复用下载。不要重新生成后重复提交。');
    const packets = await prepareJointPackets(jointTask, await read(identity.input), [...values.querySelectorAll('input')].map(n => Number(n.value)));
    packetSnapshot = packets;
    packetsBox.replaceChildren(text('h3', '分别交给 A、B 两个聚合方'), text('p', '请保存两份文件。重试使用原文件；更改数值或重新生成后再次提交会被拒绝。同一人同时保管两方私钥会失去分离保护。'), row(button('下载发给 A 的文件', () => download('encrypted-share-A.json', packets[0])), button('下载发给 B 的文件', () => download('encrypted-share-B.json', packets[1])))); packetsBox.hidden = false;
  }), { class: 'primary' })), packetsBox]),
  panel('3. 接收方核验两个合计', [text('p', '只有全部固定参与方交齐后，聚合方才生成签名合计。接收方载入同一公开任务即可完成本步，无需导入参与方私钥。'), e('div', { class: 'two-col' }, [partA.node, partB.node]), row(button('核验并合并结果', () => jointRun(async () => {
    if (!jointTask) throw new Error('请先载入联合任务。');
    const report = await combineJointParts(jointTask, [await read(partA.input), await read(partB.input)]);
    reportBox.replaceChildren(text('h3', '双方签名与任务一致'), ...report.labels.map((label, i) => text('p', `${label}：${report.totals[i]}`)), note('这是精确联合统计。加密计算保护输入，不能防止从输出反推；对外发布仍需单独设计输出保护。'), button('下载联合统计结果', () => download('joint-statistics.json', report))); reportBox.hidden = false;
  }), { class: 'primary' })), reportBox]));
}
