import { reportActions } from './report-actions.mjs';

export function initPersonQuery(root, ui) {
  const { e, text, button, field, file, read, panel, row, note, controller, callCore, download } = ui;
  const run = controller(root), project = field('共用统计项目', {}, 'select');
  const budget = text('p', '请连接本机项目。', { role: 'status' });
  const projectName = field('新项目名称', { maxlength: 60 }), total = field('项目总预算 ε', { value: '3', type: 'number', min: .01, max: 1000, step: 'any' });
  const left = file('左表：人员或活动记录'), right = file('右表：同一人员的数值记录');
  [left, right].forEach(f => { f.input.accept = '.csv,.json'; });
  const unit = field('两表共用的人员标识列', { value: 'person' }), valueField = field('右表整数值列', { value: 'hours' });
  const cap = label => field(label, { type: 'number', min: 1, max: 32, step: 1, value: 3 });
  const lc = cap('连接前每人最多保留左表行数'), rc = cap('连接前每人最多保留右表行数'), oc = cap('连接后每人最多保留行数'); lc.input.value = '1';
  const query = field('统计任务', {}, 'select'); query.input.append(e('option', { value: 'bounded_sum', text: '裁剪后的整数总和' }), e('option', { value: 'count', text: '连接后的记录数' }));
  const upper = field('每个数值的公开上限', { type: 'number', min: 1, max: 1000, step: 1, value: 8 });
  const epsilon = field('本次发布预算 ε', { type: 'number', min: .01, max: 8, step: 'any', value: '.5' });
  const explain = text('p', '', { class: 'help', id: 'person-explanation', 'aria-live': 'polite' });
  const recovery = text('p', '', { class: 'help', id: 'person-pending' });
  const output = e('section', { class: 'panel', id: 'person-result', hidden: true });
  const storageKey = 'moonprivacykit.person.pending.v1';
  let token, pending, finished = false;
  try { const saved = JSON.parse(sessionStorage.getItem(storageKey)); if (saved && /^[A-Za-z0-9_-]{1,320}$/.test(saved.projectId) && /^[a-f0-9-]{36}$/.test(saved.requestId)) pending = saved; } catch {}
  function pendingNotice() { recovery.textContent = pending ? `有一项待确认发布（${pending.requestId}）。先恢复；若尚未保存，重新选择原文件和原设置后重试。不要另建项目绕过预算。` : '下载和恢复已有报告不增加预算。相同人群的发布请继续使用原项目。'; }
  async function api(path, body) {
    if (!token) token = (await (await fetch('/api/session')).json()).data.token;
    const response = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'x-moonprivacykit-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); if (!result.ok) { if (result.code === 'SESSION_REQUIRED') token = null; throw new Error(result.message); } return result.data;
  }
  async function refresh() {
    const selected = pending?.projectId || project.input.value, items = await api('projects');
    project.input.replaceChildren(e('option', { value: '', text: '选择已有项目' }), ...items.filter(p => p.status).map(p => e('option', { value: p.id, text: p.name })));
    project.input.value = selected;
    await status();
  }
  async function status() {
    const id = pending?.projectId || project.input.value;
    if (!id) { budget.textContent = '先选择统计项目，或新建项目设置总预算。'; return; }
    const state = await api(`projects/${id}/status`);
    budget.textContent = `项目剩余预算 ε ${state.remaining_epsilon}。多表统计与“隐私统计”共用这一账本。`;
  }
  const plan = () => ({ schema_version: 1, join: 'same_person_inner', unit_field: unit.input.value, left_cap: Number(lc.input.value), right_cap: Number(rc.input.value), output_cap: Number(oc.input.value), query: query.input.value, value_field: query.input.value === 'count' ? '' : valueField.input.value, value_upper: query.input.value === 'count' ? 1 : Number(upper.input.value) });
  function preview() {
    valueField.node.hidden = upper.node.hidden = query.input.value === 'count';
    try {
      const p = callCore({ op: 'planPersonQuery', plan: plan() });
      explain.textContent = `每人最多进入结果 ${p.output_rows_per_person} 行；移除一个人在两表中的全部记录，统计量最多变化 ${p.l1_sensitivity} ${query.input.value === 'count' ? '条' : '数值单位'}。公开配置预览不读取数据、不花费预算。`;
    } catch { explain.textContent = '请补齐人员列与公开上限，才能计算每人贡献。'; }
  }
  const editor = panel('2. 连接同一人的记录并限制贡献', [note('两表人员标识必须由持有方事先一致定义。本工具只连接同一人的记录，不支持任意 SQL。每人按输入顺序保留前若干行；右表数值裁剪到 0 至公开上限。不要用姓名猜测匹配关系。'), e('div', { class: 'two-col' }, [left.node, right.node, unit.node, query.node, valueField.node, upper.node, lc.node, rc.node, oc.node, epsilon.node]), explain]);
  editor.addEventListener('input', () => { output.hidden = true; preview(); }); editor.addEventListener('change', () => { output.hidden = true; });
  function show(result) {
    const r = result.report;
    output.replaceChildren(text('h2', r.query === 'bounded_sum' ? '受保护总和已保存' : '受保护计数已保存'), text('p', String(r.counts[0]), { class: 'stats-count' }), text('p', `本次 ε ${r.epsilon}；95% 绝对误差界 ±${r.absolute_error_bound}。范围针对裁剪后的统计量，不包含裁剪偏差。`), reportActions({ kind: 'statistics', report: result, filename: `person-query-${result.release_id}`, jsonLabel: '下载已保存的报告', element: e, download }));
    output.hidden = false; editor.hidden = true; finished = true;
    pending = undefined; sessionStorage.removeItem(storageKey); pendingNotice();
  }
  editor.append(row(button('发布受保护多表统计', () => run(async () => {
    if (finished) throw new Error('已有结果，请先下载；要进行新发布请明确选择“准备下一次”。');
    const id = pending?.projectId || project.input.value;
    if (!id) throw new Error('请先选择统计项目。');
    const p = plan(); callCore({ op: 'planPersonQuery', plan: p });
    const [l, r] = await Promise.all([read(left.input, false), read(right.input, false)]);
    pending ??= { projectId: id, requestId: crypto.randomUUID() };
    sessionStorage.setItem(storageKey, JSON.stringify(pending)); pendingNotice();
    const result = await api(`projects/${id}/publish-person`, { plan: p, left: l, right: r, leftFormat: left.input.files[0].name.toLowerCase().endsWith('.csv') ? 'csv' : 'json', rightFormat: right.input.files[0].name.toLowerCase().endsWith('.csv') ? 'csv' : 'json', epsilon: epsilon.input.value, requestId: pending.requestId });
    show(result.release); await status();
  }), { class: 'primary' })));
  root.append(panel('1. 选择预算归属', [project.node, budget, row(button('刷新项目', () => run(refresh))), e('details', {}, [text('summary', '新建统计项目'), projectName.node, total.node, button('创建多表统计项目', () => run(async () => { if (pending) throw new Error('请先恢复待确认发布。'); const result = await api('projects', { name: projectName.input.value, totalEpsilon: total.input.value }); await refresh(); project.input.value = result.id; await status(); }))]), recovery, row(button('恢复待确认报告', () => run(async () => { if (!pending) throw new Error('当前没有待确认发布，可在“隐私统计”的历史中打开已有报告。'); const result = await api(`projects/${pending.projectId}/releases/${pending.requestId}`); project.input.value = pending.projectId; show(result); await status(); })), button('准备下一次多表发布', () => { if (pending || !finished) return; finished = false; editor.hidden = false; output.hidden = true; }))]), editor, output);
  project.input.addEventListener('change', () => run(async () => { if (pending) project.input.value = pending.projectId; await status(); }));
  preview(); pendingNotice();
  run(refresh, '项目列表已载入。');
}
