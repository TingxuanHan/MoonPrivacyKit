// Render and export the persisted artifact. No sampling or write request here.
export function syntheticResult(result, { element: e, download }) {
  const table = result.synthetic;
  const text = (tag, value, attrs = {}) => e(tag, { ...attrs, text: value });
  const save = (label, suffix, data, type) => {
    const button = text('button', label, { type: 'button', class: 'secondary' });
    button.addEventListener('click', () => download(`synthetic-${result.release_id}.${suffix}`, data, type));
    return button;
  };
  const preview = e('table', {}, [
    e('caption', { class: 'footnote', text: `预览前 ${Math.min(8, table.rows.length)} 行，完整文件含 ${table.rows.length} 行。` }),
    e('thead', {}, [e('tr', {}, table.columns.map(name => text('th', name, { scope: 'col' })))]),
    e('tbody', {}, table.rows.slice(0, 8).map(row => e('tr', {}, row.map(value => text('td', value))))),
  ]);
  const audit = text('button', '评估这份数据的泄露风险', { type: 'button', class: 'secondary' });
  audit.addEventListener('click', () => document.dispatchEvent(new CustomEvent('moonprivacykit:audit-synthetic', { detail: result })));
  return e('div', { class: 'synthetic-saved' }, [
    text('h2', '合成数据已保存'),
    text('p', `${table.rows.length} 行 · ${table.columns.length} 个字段 · 本次预算 ε ${result.report.epsilon}`, { class: 'synthetic-summary' }),
    text('p', '这是根据受保护统计生成的替代表格，可用于流程演示与探索性分析，不代表真实个人。可能出现与原表相同的类别组合；稀有类别和高阶关系未必准确。', { class: 'help' }),
    e('div', { class: 'synthetic-preview', tabindex: '0', 'aria-label': '合成数据预览，可横向滚动' }, [preview]),
    e('div', { class: 'button-row' }, [
      save('下载合成 CSV', 'csv', table.csv, 'text/csv;charset=utf-8'),
      save('下载完整生成记录', 'json', JSON.stringify(result, null, 2), 'application/json'),
      audit,
    ]),
    text('p', `下载复用这份结果，不重新抽样或消耗预算。CSV 已对 ${table.csv_escaped_cells} 个公式样式单元格添加安全前缀；JSON 保留原公开标签。`, { class: 'footnote' }),
    e('details', {}, [text('summary', '查看保护方式和字段关系'),
      text('p', `使用公开关系树与中心化差分隐私；每人对 ${table.plan.fields.length} 个测量格子各贡献 1。加噪统计的 95% 同时绝对误差界为 ±${result.report.absolute_error_bound}，这不是合成表的精度保证。`, { class: 'help' }),
      e('ul', {}, table.plan.fields.map(f => text('li', f.parent < 0 ? `${f.name}：起始字段` : `${f.name}：依据 ${table.plan.fields[f.parent].name} 的类别生成`))),
    ]),
  ]);
}
