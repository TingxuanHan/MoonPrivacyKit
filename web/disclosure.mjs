export function initDisclosure(root, ui) {
  const { e, text, button, field, file, read, panel, row, note, controller, callCore, download } = ui;
  const run = controller(root), imported = file('导入已保存的报表约束（JSON）');
  const cohort = field('共同统计范围', { value: '', placeholder: '例如：十月团队成员', maxlength: 120 });
  const cells = e('div', { class: 'constraint-list' }), equations = e('div', { class: 'constraint-list' });
  const result = e('section', { class: 'panel', id: 'disclosure-result', hidden: true, 'aria-live': 'polite' });
  let generation = 0, worker;
  function invalidate() { generation++; result.hidden = true; }
  root.addEventListener('input', invalidate);
  function cell(value = { id: '', lower: 0, upper: 100, protected: true, min_width: 5 }) {
    const fields = [field('类别代号', { value: value.id }), field('公开下界', { type: 'number', min: 0, max: 10000, value: value.lower }), field('公开上界', { type: 'number', min: 0, max: 10000, value: value.upper }), field('要求保留的范围宽度', { type: 'number', min: 1, max: 10000, value: value.min_width }), field('需要保护', { type: 'checkbox', checked: value.protected })];
    const item = e('div', { class: 'constraint-item' }, fields.map(f => f.node));
    item.append(button('移除此类别', () => { item.remove(); invalidate(); })); cells.append(item);
    item.model = () => ({ id: fields[0].input.value, lower: Number(fields[1].input.value), upper: Number(fields[2].input.value), min_width: Number(fields[3].input.value), protected: fields[4].input.checked });
  }
  function equation(value = { id: '', cells: [], total: 0, published: false }) {
    const fields = [field('报表条目名称', { value: value.id }), field('相加的类别代号（逗号分隔）', { value: value.cells.join(',') }), field('精确人数', { type: 'number', min: 0, max: 120000, value: value.total }), field('已经公开', { type: 'checkbox', checked: value.published })];
    const item = e('div', { class: 'constraint-item' }, fields.map(f => f.node));
    item.append(button('移除此条目', () => { item.remove(); invalidate(); })); equations.append(item);
    item.model = () => ({ id: fields[0].input.value, cells: fields[1].input.value.split(/[,，]/).map(s => s.trim()), total: Number(fields[2].input.value), published: fields[3].input.checked });
  }
  const model = () => ({ schema_version: 1, kind: 'exact-counts', cohort: cohort.input.value, node_limit: 20000, cells: [...cells.children].map(n => n.model()), equations: [...equations.children].map(n => n.model()) });
  function load(value) {
    // Validation in a worker also bounds imported models before creating controls.
    cohort.input.value = value.cohort; cells.replaceChildren(); equations.replaceChildren();
    value.cells.forEach(cell); value.equations.forEach(equation); invalidate();
  }
  const analyze = value => new Promise((resolve, reject) => {
    worker?.terminate(); worker = new Worker('/web/analysis-worker.mjs', { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('检查达到时间上限，请减少类别和约束。未给出安全结论。')); }, 30000);
    worker.onmessage = event => { clearTimeout(timer); worker.terminate(); event.data.ok ? resolve(event.data.report) : reject(new Error('约束无效：请检查唯一代号、类别引用、整数上下界及数量上限。')); };
    worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error('检查程序未完成，请重试。')); };
    worker.postMessage(value);
  });
  imported.input.addEventListener('change', () => { invalidate(); run(async () => { const value = await read(imported.input); await analyze(value); load(value); }); });
  root.append(panel('1. 整理已经公开和准备发布的统计', [note('仅适用于同一人群、同一口径的精确非负整数计数。不要把差分隐私、四舍五入结果或不同人群当作等式。上下界必须是公开知识。'), row(button('载入虚构示例', () => run(async () => load(await (await fetch('/examples/disclosure.json')).json())))), imported.node, cohort.node]),
    panel('2. 定义类别和已知关系', [text('p', '最多 12 个类别、24 个加法关系。已公开的条目会保留在所有修复验证中。', { class: 'muted' }), text('h3', '类别与保护要求'), cells, button('添加类别', () => { if (cells.children.length < 12) { cell(); invalidate(); } }), text('h3', '报表中的加法关系'), equations, button('添加报表条目', () => { if (equations.children.length < 24) { equation(); invalidate(); } }), row(button('检查能否反推', () => run(async () => {
      const value = model(), ticket = generation, report = await analyze(value);
      if (ticket !== generation) return;
      const titles = { risk_found: '发现可反推风险', no_risk_in_model: '当前模型内未发现风险', inconsistent: '约束互相矛盾，无法评估', inconclusive: '搜索未完成，不能判断风险' };
      result.replaceChildren(text('h2', titles[report.status]), ...report.findings.map(f => text('p', `${f.cell}：可推断范围 ${f.minimum} 至 ${f.maximum}；依据：${f.evidence_equations.join('、')}`)), text('p', '结论仅覆盖输入的关系和保护要求。检查报告可能包含推断出的敏感数值，请仅供内部复核。', { class: 'help' }));
      for (const repair of report.repairs) result.append(text('p', `经重新验证的候选方案：暂不发布 ${repair.remove_drafts.join('、')}。已公开条目全部保留。`));
      result.append(row(button('下载内部检查报告', () => download('private-disclosure-review.json', { model: value, report })), button('保存报表约束', () => download('disclosure-model.json', value)))); result.hidden = false;
    }), { class: 'primary' }))]), result);
}
