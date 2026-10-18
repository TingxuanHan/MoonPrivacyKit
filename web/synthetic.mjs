import { syntheticResult } from './synthetic-result.mjs';

export function initSynthetic(root, ui) {
  const { e, text, button, field, file, read, panel, row, note, controller, callCore, download } = ui;
  root.append(e('div', { class: 'page-heading' }, [e('div', {}, [text('p', '保留可用的结构，生成替代表格', { class: 'eyebrow' }), text('h1', '隐私合成数据'), text('p', '从受保护统计中生成分类表，用于演示、测试与探索性分析。')])]));
  const run = controller(root), storageKey = 'moonprivacykit.synthetic.pending.v1';
  const project = field('合成数据所属项目', {}, 'select'), budget = text('p', '连接本机项目后显示剩余预算。', { role: 'status', id: 'synthetic-budget' });
  const projectName = field('合成项目名称', { maxlength: 60 }), total = field('合成项目总预算 ε', { type: 'number', min: .01, max: 1000, step: 'any', value: '3' });
  const source = file('原始分类表（CSV 或 JSON）'); source.input.accept = '.csv,.json';
  const unit = field('人员标识列（不进入结果）', { value: 'person' });
  const amount = field('生成行数（事先指定）', { type: 'number', min: 1, max: 5000, step: 1, value: 500 });
  const epsilon = field('本次合成预算 ε', { type: 'number', min: .01, max: 8, step: 'any', value: '1' });
  const fields = e('div', { class: 'synthetic-fields' }), explain = note(''); explain.id = 'synthetic-explanation';
  const recovery = note(''), history = e('div', { id: 'synthetic-history' }); recovery.id = 'synthetic-pending';
  const output = e('section', { class: 'panel', id: 'synthetic-result', hidden: true });
  let token, pending, finished = false, offset = 0, controls = [];
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (saved && /^[A-Za-z0-9_-]{1,320}$/.test(saved.projectId) && /^[a-f0-9-]{36}$/.test(saved.requestId)) pending = saved;
  } catch { /* A later write must succeed before publishing. */ }
  const defaultFields = [{ name: 'group', categories: ['student', 'staff'], parent: -1 }, { name: 'choice', categories: ['yes', 'no'], parent: 0 }];
  const currentFields = () => controls.map((f, i) => ({ name: f.name.input.value, categories: f.categories.input.value.split('\n'), parent: i === 0 ? -1 : Number(f.parent.input.value) }));
  const plan = () => ({ schema_version: 1, unit_field: unit.input.value, output_rows: Number(amount.input.value), fields: currentFields() });
  function preview() {
    controls.forEach((f, i) => { if (i > 0) for (let j = 0; j < i; j++) f.parent.input.options[j].textContent = `字段 ${j + 1} · ${controls[j].name.input.value}`; });
    try {
      const p = callCore({ op: 'planSynthetic', plan: plan() });
      explain.textContent = `共 ${p.measurement_cells} 个受保护测量格子，每人最多贡献 ${p.l1_sensitivity} 次。一次发布统一扣除 ε ${epsilon.input.value}；输出行数不取自真实人数。配置检查不读取原表、不花费预算。`;
    } catch { explain.textContent = '请检查字段名、公开类别与关联字段。支持 1–6 个字段、每字段 1–8 个类别，总测量格子不超过 256。'; }
  }
  function renderFields(values) {
    controls = values.map((value, i) => {
      const name = field(`字段 ${i + 1} 名称`, { value: value.name, maxlength: 256 });
      const categories = field(`字段 ${i + 1} 公开类别（每行一个）`, { rows: 3, spellcheck: 'false' }, 'textarea'); categories.input.value = value.categories.join('\n');
      const parent = field(`字段 ${i + 1} 依据哪个字段生成`, {}, 'select');
      if (i === 0) parent.input.append(e('option', { value: -1, text: '起始字段，先生成这一列' }));
      else for (let j = 0; j < i; j++) parent.input.append(e('option', { value: j, text: `字段 ${j + 1} · ${values[j].name}` }));
      parent.input.value = String(value.parent);
      if (i === 0) parent.input.disabled = true;
      return { name, categories, parent, node: e('fieldset', { class: 'synthetic-field' }, [text('legend', `字段 ${i + 1}`), name.node, parent.node, categories.node]) };
    });
    fields.replaceChildren(...controls.map(c => c.node)); preview();
  }
  async function api(path, body) {
    if (!token) token = (await (await fetch('/api/session')).json()).data.token;
    const response = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'x-moonprivacykit-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!result.ok) { if (result.code === 'SESSION_REQUIRED') token = null; throw new Error(result.message); }
    return result.data;
  }
  function pendingNotice() {
    recoverButton.hidden = !pending; nextButton.hidden = !finished || Boolean(pending);
    recovery.textContent = pending ? `有一项待确认生成（${pending.requestId}）。先恢复；若还未保存，选择原文件与原配置后重试，将继续使用同一编号。` : '与“隐私统计”和多表统计共用预算。同一人群请沿用原项目；下载已有数据不花费预算。';
  }
  async function status() {
    const id = pending?.projectId || project.input.value;
    budget.textContent = id ? `剩余预算 ε ${(await api(`projects/${id}/status`)).remaining_epsilon}` : '请选择已有项目，或创建一个项目设置总预算。';
  }
  const more = button('更多生成记录', () => run(() => loadHistory(true))); more.hidden = true;
  async function loadHistory(append = false) {
    const id = project.input.value;
    if (!append) { history.replaceChildren(); offset = 0; }
    if (!id) { more.hidden = true; return; }
    const page = await api(`projects/${id}/releases?offset=${offset}`);
    for (const item of page.items.filter(x => x.kind === 'synthetic-table')) {
      history.append(e('div', { class: 'history-row' }, [text('p', `合成数据 · ε ${item.epsilon} · ${item.request_id}`), button('打开这份合成数据', () => run(async () => {
        if (pending) throw new Error('请先恢复待确认生成，再打开其他结果。');
        show(await api(`projects/${id}/releases/${item.request_id}`));
      }))]));
    }
    offset = page.offset + page.items.length; more.hidden = !page.has_more;
    if (!history.children.length) history.append(note(page.has_more ? '这一页没有合成记录，可继续查看。' : '还没有合成记录，生成后可在此重新打开。'));
  }
  async function refresh() {
    const selected = pending?.projectId || project.input.value;
    const projects = await api('projects');
    project.input.replaceChildren(e('option', { value: '', text: '选择已有项目' }), ...projects.filter(p => p.status).map(p => e('option', { value: p.id, text: p.name })));
    project.input.value = selected; await status(); await loadHistory();
  }
  function show(result) {
    if (result.synthetic?.kind !== 'moonprivacykit/synthetic-table') throw new Error('这份记录不是合成数据，请在“隐私统计”查看。');
    output.replaceChildren(syntheticResult(result, { element: e, download }));
    output.hidden = false; editor.hidden = true; finished = true;
    pending = undefined;
    try { sessionStorage.removeItem(storageKey); } catch { /* The saved artifact remains recoverable. */ }
    pendingNotice();
  }
  const configFile = file('导入公开合成配置');
  configFile.input.addEventListener('change', () => run(async () => {
    const raw = await read(configFile.input, false);
    const imported = callCore({ op: 'parseSyntheticPlan', input: raw.replace(/^\uFEFF/, '') });
    unit.input.value = imported.unit_field; amount.input.value = imported.output_rows; renderFields(imported.fields);
  }));
  const editor = panel('2. 设置公开字段关系', [
    note('先根据问卷定义或业务规则填写类别，再导入数据。不要从真实数据中抄出姓名、罕见值或自动选择关联字段。第一列先生成，其他列各选择一个前面的字段作为依据。'),
    e('div', { class: 'two-col' }, [unit.node, amount.node]), fields,
    row(button('添加合成字段', () => { const values = currentFields(); if (values.length < 6) renderFields([...values, { name: '', categories: [''], parent: 0 }]); }), button('移除最后字段', () => { if (controls.length > 1) renderFields(currentFields().slice(0, -1)); })),
    e('details', {}, [text('summary', '保存或导入公开配置'), note('配置只保存字段、公开类别、关系与输出行数。原始表格和预算不在其中。'), configFile.node, button('保存公开合成配置', () => run(() => { const p = plan(); callCore({ op: 'planSynthetic', plan: p }); download('synthetic-plan.json', JSON.stringify(p, null, 2)); }))]),
    text('h3', '导入原表并生成'), note('原表必须一人一行，标识列为非空字符串；所选字段都须属于预设类别。数值请先按公开区间分组。原表仅在本机内存处理，最多 10,000 人。'),
    row(button('下载虚构示例表', () => download('synthetic-demo.csv', 'person,group,choice\ndemo-01,student,yes\ndemo-02,student,yes\ndemo-03,student,no\ndemo-04,staff,no\ndemo-05,staff,no\ndemo-06,staff,yes\n', 'text/csv;charset=utf-8'))),
    e('div', { class: 'two-col' }, [source.node, epsilon.node]), explain,
    row(button('生成并保存合成数据', () => run(async () => {
      if (finished) throw new Error('请先保存当前结果，再选择“准备下一次合成”。');
      const id = pending?.projectId || project.input.value;
      if (!id) throw new Error('请先选择预算项目。');
      const spend = String(Number(epsilon.input.value));
      if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(spend) || Number(spend) < .01 || Number(spend) > 8) throw new Error('本次预算须在 0.01 至 8 之间，最多六位小数。');
      if (!pending && Number((await api(`projects/${id}/status`)).remaining_epsilon) < Number(spend)) throw new Error('项目剩余预算不足。请使用已有结果，或降低本次预算。');
      const p = plan();
      try { callCore({ op: 'planSynthetic', plan: p }); } catch { throw new Error('请检查公开字段设置；所有类别和关系须在读取真实数据前确定。'); }
      const input = await read(source.input, false), format = source.input.files[0].name.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
      if (input.length > 2_000_000) throw new Error('原表文本不能超过 2 MB。');
      try { callCore({ op: 'mapSynthetic', plan: p, format, input: input.replace(/^\uFEFF/, '') }); }
      catch { throw new Error('原表不符合公开配置。请检查列名、类别、人员标识和一人一行要求；不会自动添加未知类别。'); }
      const next = pending || { projectId: id, requestId: crypto.randomUUID() };
      try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { throw new Error('浏览器无法保存恢复编号，请允许当前页面的会话存储后再生成。'); }
      pending = next; pendingNotice();
      show(await api(`projects/${id}/publish-synthetic`, { plan: p, format, input, requestId: pending.requestId, epsilon: spend }));
      await status(); await loadHistory();
    }, '合成数据已保存，可下载或从生成记录恢复。'), { class: 'primary' })),
  ]);
  editor.addEventListener('input', preview);
  const recoverButton = button('恢复待确认合成数据', () => run(async () => {
    if (!pending) throw new Error('没有待确认生成，可在下方生成记录中打开已有数据。');
    project.input.value = pending.projectId; show(await api(`projects/${pending.projectId}/releases/${pending.requestId}`)); await status(); await loadHistory();
  }));
  const nextButton = button('准备下一次合成', () => {
    if (pending || !finished) return; finished = false; editor.hidden = false; output.hidden = true;
    pendingNotice();
  });
  const newProject = e('details', {}, [text('summary', '新建合成项目'), projectName.node, total.node, button('创建合成项目', () => run(async () => {
    if (pending) throw new Error('请先恢复待确认生成。');
    const result = await api('projects', { name: projectName.input.value, totalEpsilon: total.input.value });
    await refresh(); project.input.value = result.id; await status(); await loadHistory(); newProject.open = false;
  }))]);
  root.append(panel('1. 选择预算项目', [project.node, budget, row(button('刷新合成项目', () => run(refresh))), newProject, recovery, row(recoverButton, nextButton)]), editor, output, panel('已保存的生成记录', [note('这里仅显示当前项目的合成数据。其他统计发布仍计入同一预算。'), history, row(button('刷新生成记录', () => run(() => loadHistory())), more)]));
  project.input.addEventListener('change', () => run(async () => { if (pending) project.input.value = pending.projectId; await status(); await loadHistory(); }));
  renderFields(defaultFields); pendingNotice(); run(refresh, '合成工具已就绪。');
}
