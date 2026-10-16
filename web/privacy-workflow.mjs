import { checkPrivacyWorkflow } from '/runtime/privacy-workflow.mjs';

const labels = { select_fields: '保留所需字段', bound_person: '按人限制贡献', aggregate: '计算内部合计', dp_release: '受保护发布', postprocess: '复用为图表或表格' };
const origins = [['public', '公开规则，与当前私有数据无关'], ['private', '根据当前私有数据选择'], ['unknown', '来源尚不确定']];
const kinds = { private_table: '私有明细', exact_total: '内部精确合计', exact_joint_total: '联合精确合计', dp_report: '受保护统计结果', unknown: '未确认的数据状态' };
const settings = op => ({ select_fields: { keep: ['score'] }, bound_person: { max_rows: 3, origin: 'public' }, aggregate: { query: 'bounded_sum', value_field: 'score', upper: 10, origin: 'public' }, dp_release: { epsilon_units: 300000, trust: 'trusted_holder' }, postprocess: { format: 'chart' } }[op]);
function example(kind = 'valid') {
  const source = { id: 'source', kind: 'private_table', fields: ['person', 'score', 'email'], person_field: 'person', selection_origin: 'public' };
  const ops = kind === 'missing' ? ['select_fields', 'bound_person', 'aggregate', 'dp_release', 'postprocess'] : ['bound_person', 'select_fields', 'aggregate', 'dp_release', 'postprocess'];
  const steps = ops.map((op, i) => ({ id: `step${i + 1}`, op, input: i ? `step${i}` : 'source', settings: settings(op) }));
  if (kind === 'private') steps[2].settings.origin = 'private';
  if (kind === 'joint') Object.assign(source, { kind: 'exact_joint_total', fields: [], person_field: '' });
  return { schema_version: 1, kind: 'moonprivacykit/privacy-workflow', scope: 'survey-october', budget: { total_epsilon_units: 1000000, spent_epsilon_units: 200000 }, sources: [source], steps: kind === 'joint' ? [] : steps, outputs: [{ node: kind === 'joint' ? 'source' : 'step5', audience: 'public' }] };
}

export function initPrivacyWorkflow(root, ui) {
  const { e, text, button, field, file, read, panel, row, note, controller, download } = ui;
  const run = controller(root);
  let plan = example(), revision = 0;
  const editor = e('div', { class: 'workflow-editor' });
  const result = e('section', { id: 'workflow-result', class: 'panel', hidden: true, tabindex: -1, 'aria-label': '流程检查结果' });
  function invalidate() { revision++; result.hidden = true; }
  const caption = step => ({ bound_person: () => `每人至多 ${step.settings.max_rows} 条`, select_fields: () => `保留 ${step.settings.keep.join('、') || '零个字段'}`, aggregate: () => step.settings.query === 'count' ? '记录计数' : `数值上界 ${step.settings.upper}`, dp_release: () => `计划 ε = ${step.settings.epsilon_units / 1000000}`, postprocess: () => '复用原发布结果' }[step.op] || (() => '此操作需要单独验证'))();
  const edited = () => { invalidate(); plan.steps.forEach(step => { const summary = editor.querySelector(`details[data-node="${step.id}"] summary span`); if (summary) summary.textContent = caption(step); }); };
  root.addEventListener('input', edited); root.addEventListener('change', edited);
  const names = () => new Map([...plan.sources.map((s, i) => [s.id, `数据来源 ${i + 1}`]), ...plan.steps.map((s, i) => [s.id, `第 ${i + 1} 步 · ${labels[s.op] || '未支持操作'}`])]);
  function select(label, options, value, change) {
    const f = field(label, {}, 'select');
    const entries = options.some(([key]) => key === value) ? options : [...options, [value, '未识别：' + value]];
    entries.forEach(([key, label]) => f.input.append(text('option', label, { value: key })));
    f.input.value = value;
    f.input.addEventListener('change', () => { change(f.input.value); invalidate(); });
    return f.node;
  }
  function input(label, value, change, attrs = {}) {
    const f = field(label, { value, ...attrs });
    f.input.addEventListener('input', () => { change(f.input.value); invalidate(); });
    return f.node;
  }
  const fields = value => value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const epsilon = value => {
    if (!/^\d{1,4}(\.\d{1,6})?$/.test(value)) return -1;
    const [whole, fraction = ''] = value.split('.');
    return Number(whole) * 1000000 + Number(fraction.padEnd(6, '0'));
  };
  function renderEditor() {
    const opened = new Set([...editor.querySelectorAll('details[open][data-node]')].map(node => node.dataset.node));
    invalidate(); editor.replaceChildren();
    const sourceCards = plan.sources.map((source, i) => {
      const inputs = [select(`来源 ${i + 1} 类型`, [['private_table', '真实数据明细表'], ['exact_joint_total', '已有精确联合合计']], source.kind, value => {
        source.kind = value; source.fields = value === 'private_table' ? ['person', 'score'] : []; source.person_field = value === 'private_table' ? 'person' : ''; renderEditor();
      }), select(`来源 ${i + 1} 的选取规则`, origins, source.selection_origin, v => { source.selection_origin = v; })];
      if (source.kind === 'private_table') inputs.push(input(`来源 ${i + 1} 的字段（逗号分隔）`, source.fields.join(','), v => { source.fields = fields(v); }), input(`来源 ${i + 1} 的人员标识字段`, source.person_field, v => { source.person_field = v; }));
      return e('div', { class: 'workflow-source' }, [text('h3', `数据来源 ${i + 1}`), e('div', { class: 'two-col' }, inputs)]);
    });
    editor.append(panel('1. 声明数据来源和保护范围', [note('填写字段和规则即可，无需上传原始记录。所有来源按同一群体的“增减一个人的全部记录”共同核算；人员对应和预算快照需由你核实。'), ...sourceCards, e('div', { class: 'two-col' }, [
      input('共同保护范围编号', plan.scope, v => { plan.scope = v; }),
      input('范围内的总预算 ε', plan.budget.total_epsilon_units / 1000000, v => { plan.budget.total_epsilon_units = epsilon(v); }, { inputMode: 'decimal' }),
      input('范围内的已用预算 ε', plan.budget.spent_epsilon_units / 1000000, v => { plan.budget.spent_epsilon_units = epsilon(v); }, { inputMode: 'decimal' }),
    ])]));
    const sequence = e('ol', { class: 'workflow-sequence', 'aria-label': '计划处理步骤' });
    plan.steps.forEach((step, i) => {
      const card = e('li', { class: 'workflow-step' });
      const details = e('details', { 'data-node': step.id, open: opened.has(step.id) });
      details.append(e('summary', {}, [text('strong', `第 ${i + 1} 步 · ${labels[step.op] || '未支持操作'}`), text('span', caption(step))]));
      const controls = row(button('上移', () => { [plan.steps[i - 1], plan.steps[i]] = [plan.steps[i], plan.steps[i - 1]]; renderEditor(); }, { disabled: i === 0, 'aria-label': `上移第 ${i + 1} 步` }), button('移除', () => { plan.steps.splice(i, 1); renderEditor(); }, { 'aria-label': `移除第 ${i + 1} 步` }));
      details.append(e('div', { class: 'section-heading' }, [text('h3', '步骤设置'), controls]));
      const allNames = names();
      const previous = [...plan.sources, ...plan.steps.slice(0, i)].map(n => [n.id, allNames.get(n.id)]);
      const properties = [select(`第 ${i + 1} 步操作`, Object.entries(labels), step.op, v => { step.op = v; step.settings = settings(v); renderEditor(); }), select(`第 ${i + 1} 步输入来自`, previous, step.input, v => { step.input = v; })];
      const s = step.settings;
      if (step.op === 'select_fields') properties.push(input(`第 ${i + 1} 步保留字段`, s.keep.join(','), v => { s.keep = fields(v); }));
      if (step.op === 'bound_person') properties.push(input(`第 ${i + 1} 步每人最多记录数`, s.max_rows, v => { s.max_rows = Number(v); }, { type: 'number', min: 1, max: 32 }), select(`第 ${i + 1} 步上限来源`, origins, s.origin, v => { s.origin = v; }));
      if (step.op === 'aggregate') {
        properties.push(select(`第 ${i + 1} 步统计内容`, [['count', '贡献裁剪后的记录总数'], ['bounded_sum', '有界整数总和']], s.query, v => {
          Object.assign(s, v === 'count' ? { query: v, value_field: '', upper: 1, origin: 'public' } : { query: v, value_field: 'score', upper: 10, origin: 'public' }); renderEditor();
        }));
        if (s.query === 'bounded_sum') properties.push(input(`第 ${i + 1} 步数值字段`, s.value_field, v => { s.value_field = v; }), input(`第 ${i + 1} 步数值上界`, s.upper, v => { s.upper = Number(v); }, { type: 'number', min: 1, max: 1000 }), select(`第 ${i + 1} 步数值上界来源`, origins, s.origin, v => { s.origin = v; }));
      }
      if (step.op === 'dp_release') properties.push(input(`第 ${i + 1} 步发布预算 ε`, s.epsilon_units / 1000000, v => { s.epsilon_units = epsilon(v); }, { inputMode: 'decimal' }), select(`第 ${i + 1} 步执行方`, [['trusted_holder', '可信数据持有方'], ['untrusted', '不可信执行方']], s.trust, v => { s.trust = v; }));
      if (step.op === 'postprocess') properties.push(select(`第 ${i + 1} 步复用形式`, [['chart', '图表'], ['table', '表格']], s.format, v => { s.format = v; }));
      details.append(e('div', { class: 'two-col' }, properties)); card.append(details); sequence.append(card);
    });
    const newOp = field('要添加的处理步骤', {}, 'select');
    Object.entries(labels).forEach(([key, label]) => newOp.input.append(text('option', label, { value: key })));
    editor.append(panel('2. 安排处理步骤', [note('展开步骤修改设置。修改顺序后，请核对“输入来自”。多次发布从同一范围累计预算；复用图表保留原发布来源。'), sequence, row(newOp.node, button('添加步骤', () => {
      let n = 1; const ids = names(); while (ids.has(`step${n}`)) n++;
      plan.steps.push({ id: `step${n}`, op: newOp.input.value, input: plan.steps.at(-1)?.id || plan.sources[0].id, settings: settings(newOp.input.value) }); renderEditor();
    }, { disabled: plan.steps.length >= 32 }))]));
    const outputs = e('div', { class: 'workflow-outputs' });
    plan.outputs.forEach((destination, i) => outputs.append(e('div', { class: 'workflow-output' }, [select(`交付 ${i + 1} 的结果`, [...names()], destination.node, v => { destination.node = v; }), select(`交付 ${i + 1} 的用途`, [['internal', '仅限可信持有者内部'], ['public', '对外提供受保护统计']], destination.audience, v => { destination.audience = v; }), button('移除交付', () => { plan.outputs.splice(i, 1); renderEditor(); }, { disabled: plan.outputs.length === 1, 'aria-label': `移除交付 ${i + 1}` })])));
    editor.append(panel('3. 指定交付结果', [outputs, row(button('增加交付结果', () => { plan.outputs.push({ node: plan.steps.at(-1)?.id || plan.sources[0].id, audience: 'internal' }); renderEditor(); }, { disabled: plan.outputs.length >= 16 }))]));
  }

  const preset = field('示例情形', {}, 'select');
  [['valid', '先限贡献，再删除标识'], ['missing', '过早删除人员标识'], ['private', '用私有数据选择数值上界'], ['joint', '直接公开精确联合合计']].forEach(([key, label]) => preset.input.append(text('option', label, { value: key })));
  const uploaded = file('导入已有流程方案');
  uploaded.input.addEventListener('change', () => run(async () => {
    invalidate(); const content = await read(uploaded.input, false);
    checkPrivacyWorkflow(content); plan = JSON.parse(content); renderEditor();
  }, '方案已载入，请复核来源声明后检查。'));
  root.append(panel('检查工具之间能否衔接', [text('p', '先声明来源、安排步骤，再检查保护条件是否保留。检查不会读取真实数据、消耗预算或执行发布。'), row(preset.node, button('载入流程示例', () => { plan = example(preset.input.value); renderEditor(); })), uploaded.node]), editor,
    row(button('检查流程', () => run(async () => {
      invalidate(); const version = revision;
      let report;
      try { report = checkPrivacyWorkflow(plan); }
      catch { throw new Error('方案格式或引用不成立。请检查步骤输入是否来自更早步骤、字段是否重复，以及预算和人数上限是否有效。'); }
      if (version !== revision) return;
      const titles = { compatible: '声明条件相容', blocked: '发现衔接问题', inconclusive: '流程尚无法验证' };
      result.dataset.status = report.status;
      result.replaceChildren(text('h2', titles[report.status]), text('p', '结论仅针对当前声明和支持的操作；不代表已经发布、取得许可或完成安全认证。'));
      const b = report.budget;
      result.append(text('p', `可核对的新发布开销 ε = ${b.planned_epsilon_units / 1000000}；计划后剩余 ε = ${b.remaining_after_plan_units / 1000000}。${b.estimate_complete ? '重复呈现复用原发布。' : '流程未通过，整份预算估算尚不完整。'}`, { class: 'workflow-budget' }));
      const nodeNames = names();
      report.issues.forEach(issue => {
        const section = e('section', { class: 'workflow-issue' }, [text('h3', nodeNames.get(issue.node) || issue.node), text('p', issue.reason), text('p', issue.action), text('p', issue.path.map(id => nodeNames.get(id) || id).join(' → '), { class: 'footnote' })]);
        const target = editor.querySelector(`details[data-node="${issue.node}"]`);
        if (target) section.append(button('查看此步骤', () => { target.open = true; target.scrollIntoView({ block: 'center' }); target.querySelector('select,input')?.focus(); }));
        result.append(section);
      });
      const trace = e('ol', { class: 'workflow-trace' });
      report.checks.forEach(item => trace.append(e('li', {}, [text('strong', nodeNames.get(item.node) || item.node), text('span', `${kinds[item.data_kind] || item.data_kind} · ${{ valid: '条件已核对', blocked: '存在阻断条件', unverified: '条件未确认' }[item.status]}${item.rows_per_person ? ` · 每人至多 ${item.rows_per_person} 条` : ''}${item.l1_sensitivity ? ` · 敏感度 ${item.l1_sensitivity}` : ''}`)])));
      result.append(trace, button('下载内部流程检查', () => download('private-workflow-check.json', report)), e('details', {}, [text('summary', '声明条件与检查范围'), ...report.assumptions.map(a => text('p', a))]));
      result.hidden = false; result.focus();
    }, '检查完成；修改方案后需重新检查。'), { class: 'primary' }), button('保存流程方案', () => run(async () => {
      try { checkPrivacyWorkflow(plan); } catch { throw new Error('方案存在格式或引用错误，请修正后保存。'); }
      download('privacy-workflow.json', plan);
    }, '方案已导出；不含原始记录。'))), result);
  renderEditor();
}
