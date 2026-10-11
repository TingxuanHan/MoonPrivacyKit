import { parseRedactionTemplate, createRedactionTemplate, checkRedactionTemplate, applyRedactionTemplate, prepareRedactionHandoff } from '/runtime/templates.mjs';

export function initRedaction({ callCore, element, download, notice, statistics, openStatistics }) {
  const $ = id => document.getElementById(`redact-${id}`);
  const policies = () => [...document.querySelectorAll('#field-policies select')];
  const actions = { keep: '保留', remove: '删除', mask: '遮盖' };
  let input = null, result = null, handoff = null, template = null, compatible = false, busy = false;
  function invalid(message) { const error = new Error(message); error.publicMessage = message; throw error; }
  function sync() {
    for (const control of document.querySelectorAll('#view-redact button, #view-redact input, #view-redact select')) control.disabled = busy;
    $('template-apply').disabled = busy || !compatible;
    $('to-statistics').disabled = busy || !handoff?.eligible_fields.length;
  }
  async function run(action) {
    if (busy) return;
    busy = true; notice(''); sync();
    try { await action(); }
    catch (error) { notice(error.publicMessage || '处理未完成。请检查文件结构、字段规则和大小；CSV 至少保留一列，规则至少删除或遮盖一列。', true); }
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
      fields: policies().map(select => ({ name: select.dataset.key, action: select.value })),
      spreadsheetSafe: document.getElementById('spreadsheet-safe').checked,
    });
  }
  function previewTemplate() {
    compatible = false; $('template-preview').hidden = !template;
    if (!template) { sync(); return; }
    $('template-title').textContent = template.name;
    $('template-rules').replaceChildren(...template.settings.fields.map(field => element('li', { text: `${field.name}：${actions[field.action]}` })));
    $('template-format').textContent = template.settings.spreadsheetSafe ? 'CSV 导出时将公式样式内容转为文本；JSON 不应用此选项。' : 'CSV 导出时不改写公式样式内容；请谨慎在表格软件中打开。';
    let description = '先选择数据文件，再检查字段是否一致。';
    if (input) {
      try {
        const check = checkRedactionTemplate(template, input.format, input.text);
        compatible = check.compatible;
        description = check.compatible ? '字段一致。请核对每列含义，再应用这份配置。'
          : check.issue === 'no_remaining_columns' ? '这份配置会删除所有列，无法用于 CSV。请取消预览并至少保留一列。'
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
      return element('div', { class: 'policy-row' }, [element('label', { htmlFor: select.id, text: name }), select]);
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
    const rules = new Map(template.settings.fields.map(rule => [rule.name, rule.action]));
    for (const select of policies()) select.value = rules.get(select.dataset.key);
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
    catch { invalid('无法保存配置。名称限 1 至 80 个单行字符，字段名限 256 个字符，至少选择一列删除或遮盖。'); }
    download('redaction-template.json', config);
    notice('字段配置已导出，只包含列名和处理规则。未导出原始记录或统计预算。');
  }));
  $('form').addEventListener('change', event => {
    if (event.target.matches('#field-policies select, #spreadsheet-safe')) invalidate();
  });
  $('form').addEventListener('submit', event => {
    event.preventDefault(); run(() => {
      invalidate();
      const config = currentTemplate();
      try { handoff = prepareRedactionHandoff(config, input.format, input.text); result = handoff.result; }
      catch { result = applyRedactionTemplate(config, input.format, input.text); }
      const audit = result.audit;
      $('summary').textContent = `共 ${audit.records} 条记录 · 删除 ${audit.removed_values} 处 · 遮盖 ${audit.masked_values} 处 · 公式文本化 ${audit.spreadsheet_escapes} 处`;
      $('preview').textContent = result.output.slice(0, 8000);
      $('handoff-note').textContent = handoff?.eligible_fields.length
        ? '可用未改写的字段继续统计。请确保其中有稳定的人员标识，转入后核对设置再发布。'
        : '没有可转入统计的字段，或输出列名无法通过校验。请调整规则，或在可信环境中使用原表统计；处理后文件仍可下载。';
      $('handoff-fields').textContent = handoff ? `保持原样：${handoff.eligible_fields.join('、') || '无'}\n不能用于本次统计：${handoff.excluded_fields.join('、') || '无'}` : '未通过衔接校验，请检查处理规则及 CSV 列名。';
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
