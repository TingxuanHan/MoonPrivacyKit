import { parseRedactionTemplate, createRedactionTemplate, checkRedactionTemplate, applyRedactionTemplate, prepareRedactionHandoff } from '/runtime/templates.mjs';

export function initRedaction({ callCore, element, download, notice, statistics, openStatistics }) {
  const $ = id => document.getElementById(`redact-${id}`);
  const policies = () => [...document.querySelectorAll('#field-policies select[data-key]')];
  const actions = { keep: '保留', remove: '删除', mask: '遮盖', age: '年龄分段', date: '日期降精度' };
  let input = null, result = null, handoff = null, template = null, compatible = false, busy = false;
  function invalid(message) { const error = new Error(message); error.publicMessage = message; throw error; }
  function sync() {
    for (const control of document.querySelectorAll('#view-redact button, #view-redact input, #view-redact select')) control.disabled = busy;
    for (const select of policies()) {
      for (const box of select.parentElement.querySelectorAll('[data-parameters]')) {
        const active = box.dataset.parameters === select.value;
        box.hidden = !active;
        for (const control of box.querySelectorAll('input, select')) { control.disabled = busy || !active; control.required = active; }
      }
    }
    $('template-apply').disabled = busy || !compatible;
    $('to-statistics').disabled = busy || !handoff?.eligible_fields.length;
  }
  async function run(action) {
    if (busy) return;
    busy = true; notice(''); sync();
    try { await action(); }
    catch (error) { notice(error.publicMessage || '处理未完成。请检查文件结构、字段规则和大小；CSV 至少保留一列，规则至少处理一列。', true); }
    finally { busy = false; sync(); }
  }
  async function textFile(file, limit) {
    if (!file || file.size > limit) invalid(`请选择不超过 ${limit === 400_000 ? '400 KB 的模板' : '4 MB 的数据'}文件。`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()).replace(/^\uFEFF/, ''); }
    catch { invalid('文件不是有效的 UTF-8 文本，请转换编码后重新选择。'); }
  }
  function invalidate() { result = null; handoff = null; $('result').hidden = true; sync(); }
  function currentTemplate(name = '本次字段处理') {
    return createRedactionTemplate(name, {
      fields: policies().map(select => {
        const rule = { name: select.dataset.key, action: select.value };
        if (rule.action === 'age') {
          const parts = select.parentElement.querySelector('[data-boundaries]').value.split(/[,，]/).map(s => s.trim());
          if (parts.some(s => !/^[1-9][0-9]{0,2}$/.test(s))) invalid('年龄分段起点须为递增且不重复的整数，用逗号分隔，范围为 1 至 130。');
          rule.boundaries = parts.map(Number);
        }
        if (rule.action === 'date') rule.precision = select.parentElement.querySelector('[data-precision]').value;
        return rule;
      }),
      spreadsheetSafe: document.getElementById('spreadsheet-safe').checked,
    });
  }
  function previewTemplate() {
    compatible = false; $('template-preview').hidden = !template;
    if (!template) { sync(); return; }
    $('template-title').textContent = template.name;
    $('template-rules').replaceChildren(...template.settings.fields.map(field => element('li', { text: `${field.name}：${actions[field.action]}${field.action === 'age' ? `（分段起点 ${field.boundaries.join('、')}）` : field.action === 'date' ? `（保留到${field.precision === 'month' ? '月份' : '年份'}）` : ''}` })));
    $('template-format').textContent = template.settings.spreadsheetSafe ? 'CSV 导出时将公式样式内容转为文本；JSON 不应用此选项。' : 'CSV 导出时不改写公式样式内容；请谨慎在表格软件中打开。';
    let description = '先选择数据文件，再检查字段是否一致。';
    if (input) {
      try {
        const check = checkRedactionTemplate(template, input.format, input.text);
        compatible = check.compatible;
        description = check.compatible ? '字段一致。请核对每列含义，再应用这份配置。'
          : check.issue === 'no_remaining_columns' ? '这份配置会删除所有列，无法用于 CSV。请取消预览并至少保留一列。'
          : check.issue === 'invalid_values' ? '年龄或日期不符合规则：年龄须为 0 至 130 的整数，日期须为有效的 YYYY-MM-DD；不能缺失或留空。当前规则未修改，请检查源文件。'
          : [check.missing_fields.length ? `缺少字段：${check.missing_fields.join('、')}。` : '', check.unexpected_fields.length ? `新增字段尚未配置：${check.unexpected_fields.join('、')}。` : '', '当前规则未修改。请取消预览，逐列复核后保存新配置。'].join('');
      } catch { description = '数据结构不符合要求。请检查重复 JSON 键、CSV 表头和记录格式；当前规则未修改。'; }
    }
    $('template-check').textContent = description;
    $('template-check').classList.toggle('template-incompatible', Boolean(input && !compatible));
    sync();
  }
  function loadTable(format, text, filename) {
    const fields = callCore({ op: 'inspect', format, input: text });
    input = { format, text };
    $('filename').textContent = filename;
    document.getElementById('field-policies').replaceChildren(...fields.map((name, i) => {
      const select = element('select', { id: `field-policy-${i}`, 'data-key': name }, Object.entries(actions).map(([value, text]) => element('option', { value, text })));
      const age = element('div', { class: 'field-parameters', 'data-parameters': 'age', hidden: true }, [
        element('label', { class: 'field', text: '分段起点（周岁，逗号分隔）' }, [element('input', { 'data-boundaries': '', value: '18,30,45,60', maxlength: '160', 'aria-label': `${name} 的年龄分段起点` })]),
        element('p', { class: 'footnote', text: '例如 18,30,45,60 生成 0-17、18-29、30-44、45-59、60+。原值须为 0 至 130 的整数；文本不带空格或前导零。' }),
      ]);
      const date = element('div', { class: 'field-parameters', 'data-parameters': 'date', hidden: true }, [
        element('label', { class: 'field', text: '保留日期精度' }, [element('select', { 'data-precision': '', 'aria-label': `${name} 的日期精度` }, [element('option', { value: 'month', text: '月份（YYYY-MM）' }), element('option', { value: 'year', text: '年份（YYYY）' })])]),
        element('p', { class: 'footnote', text: '原值须为有效的 YYYY-MM-DD 日期。暂不接受时间戳、时区、空值或其他日期格式。' }),
      ]);
      return element('div', { class: 'policy-row' }, [element('label', { htmlFor: select.id, text: name }), select, age, date]);
    }));
    const spreadsheet = document.getElementById('spreadsheet-label');
    spreadsheet.hidden = format !== 'csv'; spreadsheet.nextElementSibling.hidden = format !== 'csv';
    $('form').hidden = false;
    previewTemplate();
  }
  $('file').addEventListener('change', () => run(async () => {
    invalidate(); input = null; $('form').hidden = true; previewTemplate();
    const file = $('file').files[0];
    const text = await textFile(file, 4_000_000);
    const format = file.name.split('.').pop().toLowerCase();
    if (!['csv', 'json'].includes(format)) invalid('请选择 CSV 或 JSON 数据文件。');
    loadTable(format, text, file.name);
  }));
  $('example').addEventListener('click', () => run(() => {
    invalidate(); $('file').value = '';
    loadTable('csv', 'person_id,name,email,answer\nunit-001,示例甲,first@example.test,满意\nunit-002,示例乙,second@example.test,一般\nunit-001,示例甲,first@example.test,不满意', '虚构示例.csv');
    policies()[1].value = 'remove'; policies()[2].value = 'mask';
  }));
  $('generalize-example').addEventListener('click', () => run(() => {
    invalidate(); $('file').value = '';
    loadTable('csv', 'person_id,age,visit_date,contact\nunit-001,23,2026-01-08,first@example.test\nunit-002,46,2026-02-18,second@example.test\nunit-001,23,2026-02-20,first@example.test', '虚构分段示例.csv');
    policies()[1].value = 'age'; policies()[2].value = 'date'; policies()[3].value = 'remove';
  }));
  $('template-file').addEventListener('change', () => run(async () => {
    template = null; previewTemplate();
    const text = await textFile($('template-file').files[0], 400_000);
    try { template = parseRedactionTemplate(text); }
    catch { invalid('无法读取字段处理模板。请检查版本、字段规则和格式；当前规则未修改。'); }
    previewTemplate();
  }));
  $('template-apply').addEventListener('click', () => run(() => {
    previewTemplate();
    if (!compatible) invalid('当前文件与模板不兼容，请先复核字段。');
    invalidate();
    const rules = new Map(template.settings.fields.map(rule => [rule.name, rule]));
    for (const select of policies()) {
      const rule = rules.get(select.dataset.key); select.value = rule.action;
      if (rule.action === 'age') select.parentElement.querySelector('[data-boundaries]').value = rule.boundaries.join(',');
      if (rule.action === 'date') select.parentElement.querySelector('[data-precision]').value = rule.precision;
    }
    document.getElementById('spreadsheet-safe').checked = template.settings.spreadsheetSafe;
    $('template-name').value = template.name;
    notice('字段配置已应用。请核对规则，再点击“处理并预览”。');
    policies()[0]?.focus();
  }));
  $('template-dismiss').addEventListener('click', () => {
    template = null; $('template-file').value = ''; previewTemplate();
  });
  $('template-export').addEventListener('click', () => run(() => {
    let config;
    try { config = currentTemplate($('template-name').value); }
    catch { invalid('无法保存配置。请检查名称和字段规则；至少处理一列，年龄分段起点须为 1 至 130 的递增整数，最多 32 个。'); }
    download('redaction-template.json', config);
    notice('字段配置已导出，只包含列名和处理规则。未导出原始记录或统计预算。');
  }));
  for (const type of ['input', 'change']) $('form').addEventListener(type, event => {
    if (event.target.matches('#field-policies select, #field-policies input, #spreadsheet-safe')) invalidate();
  });
  $('form').addEventListener('submit', event => {
    event.preventDefault(); run(() => {
      invalidate();
      let config;
      try { config = currentTemplate(); }
      catch { invalid('请检查字段规则。至少处理一列，年龄分段起点须为 1 至 130 的递增整数，最多 32 个。'); }
      if (checkRedactionTemplate(config, input.format, input.text).issue === 'invalid_values') invalid('处理已停止，未跳过任何记录。请检查年龄是否为 0 至 130 的整数、日期是否为有效的 YYYY-MM-DD，以及这些字段是否缺失或留空。');
      try { handoff = prepareRedactionHandoff(config, input.format, input.text); result = handoff.result; }
      catch { result = applyRedactionTemplate(config, input.format, input.text); }
      const audit = result.audit;
      $('summary').textContent = `共 ${audit.records} 条记录 · 删除 ${audit.removed_values} 处 · 遮盖 ${audit.masked_values} 处${audit.generalized_values ? ` · 泛化 ${audit.generalized_values} 处` : ''} · 公式文本化 ${audit.spreadsheet_escapes} 处`;
      $('preview').textContent = result.output.slice(0, 8000);
      $('handoff-note').textContent = handoff?.eligible_fields.length
        ? '人员标识必须保持原样；年龄段、月份或年份可用作类别。转入后核对公开类别与保护设置，再生成统计报告。'
        : '没有可转入统计的字段，或输出列名无法通过校验。请调整规则，或在可信环境中使用原表统计；处理后文件仍可下载。';
      $('handoff-fields').textContent = handoff ? `保持原样：${handoff.eligible_fields.join('、') || '无'}\n泛化后仅可用作类别：${handoff.generalized_fields.map(f => f.name).join('、') || '无'}\n不能用于本次统计：${handoff.excluded_fields.join('、') || '无'}` : '未通过衔接校验，请检查处理规则及 CSV 列名。';
      $('result').hidden = false;
    });
  });
  document.getElementById('download-redacted').addEventListener('click', () => { if (result) download(`redacted.${input.format}`, result.output, input.format === 'csv' ? 'text/csv' : 'application/json'); });
  document.getElementById('download-audit').addEventListener('click', () => { if (result) download('processing-record.json', result.audit); });
  $('to-statistics').addEventListener('click', () => run(() => {
    if (!handoff?.eligible_fields.length) invalid('请先生成可用于统计的处理结果。');
    const accepted = statistics.acceptRedaction({ format: input.format, handoff });
    if (!accepted.ok) invalid(accepted.message);
    openStatistics();
  }));
  sync();
}
