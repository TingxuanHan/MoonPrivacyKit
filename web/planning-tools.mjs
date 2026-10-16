export function initPlanningTools(comparison, versions, ui) {
  const { e, text, button, field, file, read, panel, row, note, controller, callCore, download } = ui;
  const list = input => input.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const format = input => input.files[0].name.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
  const table = label => { const f = file(label); f.input.accept = '.csv,.json'; return f; };
  const privateNote = '以下精确分析仅供可信持有者内部使用。分组大小不是重识别概率，达标不等于匿名。根据私有分析选出的规则不能直接沿用原差分隐私发布保证。';
  const analyze = request => new Promise((resolve, reject) => {
    const worker = new Worker('/web/analysis-worker.mjs', { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('分析超时，请减少记录、字段或候选。没有给出安全结论。')); }, 30000);
    const finish = (ok, result) => { clearTimeout(timer); worker.terminate(); ok ? resolve(result) : reject(new Error('无法分析，请核对所选字段、唯一人员对应和处理模板。未改写原文件。')); };
    worker.onmessage = event => finish(event.data.ok, event.data.report); worker.onerror = () => finish(false); worker.postMessage(request);
  });
  const run = controller(comparison), input = table('待比较的真实数据'), templates = file('候选字段模板（可多选，在“文件脱敏”中保存）'); templates.input.multiple = true;
  const qi = field('可能联合识别的字段（逗号分隔）', { placeholder: 'age,department' });
  const required = field('必须原样保留的字段（可留空）', { placeholder: 'department' });
  const k = field('期望最小分组大小 k', { type: 'number', min: 2, max: 10000, value: 2 });
  const result = e('section', { class: 'panel', id: 'comparison-result', hidden: true });
  comparison.addEventListener('input', () => { result.hidden = true; }); comparison.addEventListener('change', () => { result.hidden = true; });
  comparison.append(panel('比较保护程度与保留信息', [note(privateNote), input.node, row(button('扫描可能敏感的内容', () => run(async () => {
    const report = await analyze({ op: 'scanSensitiveFields', format: format(input.input), input: await read(input.input, false) });
    result.replaceChildren(text('h2', '内容扫描建议'), text('p', '由 moon_scrub 0.5.2 执行。这里只显示命中类型和数量，不回显原值。仅扫描顶层字符串；漏报与误报仍需人工复核。'), ...report.findings.map(f => text('p', `${f.field}：${f.affected_rows} 行；${Object.keys(f.kinds).join('、')}`)));
    if (!report.findings.length) result.append(text('p', '没有规则命中，不能据此判定没有敏感信息。'));
    result.hidden = false;
  }))), templates.node, e('div', { class: 'two-col' }, [qi.node, required.node, k.node]), row(button('比较候选方案', () => run(async () => {
    const files = [...templates.input.files]; if (!files.length || files.length > 64) throw new Error('请选择 1 至 64 个字段模板。');
    const candidates = await Promise.all(files.map(f => read({ files: [f] })));
    const source = await read(input.input, false), kind = format(input.input);
    const config = { schema_version: 1, quasi_fields: list(qi.input), required_unchanged: list(required.input), k: Number(k.input.value), candidates };
    const report = await analyze({ op: 'comparePrivacyPlans', format: kind, input: source, config });
    result.replaceChildren(text('h2', '候选方案比较结果'), text('p', `原表最小分组：${report.baseline.minimum_group}。满足约束且在风险与损失指标上未被其他候选同时改善的方案：${report.frontier.join('、') || '无'}。`));
    for (let i = 0; i < report.candidates.length; i++) {
      const c = report.candidates[i];
      result.append(e('section', { class: 'result-question' }, [text('h3', c.name), text('p', `最小组 ${c.metrics.minimum_group}；低于 k 的记录 ${(c.metrics.below_k_fraction * 100).toFixed(1)}%；公开规则损失指标 ${c.loss_index.toFixed(3)}；保留字段 ${(c.retained_fields_fraction * 100).toFixed(1)}%；缺失记录 ${c.missing_rows}。${c.meets_constraints ? '满足当前约束' : '不满足当前约束'}。`), button(`导出「${c.name}」处理副本`, () => run(async () => {
        const processed = callCore({ op: 'applyRedactionTemplate', template: JSON.stringify(candidates[i]), format: kind, input: source });
        download(`private-processed-${i + 1}.${kind}`, processed.output, kind === 'csv' ? 'text/csv' : 'application/json');
      }, '已导出处理副本；该副本仍需按内部数据保管。'))]));
    }
    result.append(note('损失指标由公开规则决定：保留为 0，遮盖/删除为 1，年龄按最大桶宽归一化，日期月/年为 0.5/0.8，再按字段等权平均。它不是通用效用评分。此处不删除记录、不自动发布。'), button('下载内部方案比较', () => download('private-plan-comparison.json', report))); result.hidden = false;
  }), { class: 'primary' }))]), result);

  const crossRun = controller(versions), left = table('第一版数据'), right = table('第二版数据');
  const id = field('两版的私有对应标识列', { value: 'id' }), lf = field('第一版可见字段（逗号分隔）', { value: 'x' }), rf = field('第二版可见字段（逗号分隔）', { value: 'y' });
  const threshold = field('联合检查的分组阈值 k', { type: 'number', min: 2, max: 10000, value: 2 });
  const linked = field('确认两版是同一群体、一人一行，且接收方能正确关联同一人', { type: 'checkbox' });
  const crossResult = e('section', { class: 'panel', id: 'versions-result', hidden: true });
  versions.addEventListener('input', () => { crossResult.hidden = true; }); versions.addEventListener('change', () => { crossResult.hidden = true; });
  versions.append(panel('检查两版可见信息叠加后的变化', [note(privateNote), e('div', { class: 'two-col' }, [left.node, right.node, id.node, threshold.node, lf.node, rf.node]), linked.node, text('p', '标识只用于本地对应，不进入检查报告；新增、缺失或重复人员会拒绝联查。系统不会备份原表或自动猜测人员身份。'), row(button('检查两版联合风险', () => crossRun(async () => {
    if (!linked.input.checked) throw new Error('请先核对并确认同一群体和可关联假设。');
    const config = { schema_version: 1, unit_field: id.input.value, left_fields: list(lf.input), right_fields: list(rf.input), k: Number(threshold.input.value), assume_linkable: true };
    const report = await analyze({ op: 'comparePrivateVersions', left_format: format(left.input), left: await read(left.input, false), right_format: format(right.input), right: await read(right.input, false), config });
    crossResult.replaceChildren(text('h2', '两版联合检查结果'), text('p', `最小分组：第一版 ${report.left.minimum_group}，第二版 ${report.right.minimum_group}，合并可见信息后 ${report.joint.minimum_group}。`), text('p', `分组变小 ${report.smaller_group_rows} 条；两版分别达标、联合后低于 k 的记录 ${report.newly_below_k_rows} 条。`), note('这是声明关联条件下的保守分析，不能证明现实中一定可以完成关联，也不覆盖未声明的背景知识。'), button('下载内部联查报告', () => download('private-version-comparison.json', report))); crossResult.hidden = false;
  }), { class: 'primary' }))]), crossResult);
}
