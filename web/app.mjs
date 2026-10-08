import { callCore, validateSurvey, protectResponse, aggregateResponses } from '/runtime/client.mjs';
import { initStatistics } from '/web/statistics.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const example = { schema_version: 1, id: 'team-feedback-v1', title: '团队反馈示例', questions: [
  { id: 'satisfaction', title: '你对目前的协作方式满意吗？', options: ['满意', '不满意'], epsilon: 1 },
  { id: 'priority', title: '你最希望优先改善什么？', options: ['沟通', '工具', '安排'], epsilon: 1 }
] };
function element(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key in node && !key.startsWith('aria')) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}
function notice(message, error = false) {
  const box = $('#notice');
  box.textContent = message;
  box.classList.toggle('error', error);
  box.setAttribute('role', error ? 'alert' : 'status');
  box.hidden = !message;
}
function humanError(error) {
  const msg = error.message || '';
  if (/integer/.test(msg)) return '人数、选项数和选项编号必须是整数，请修改后重试。';
  if (/no signal/.test(msg)) return '保护配置没有足够的统计信号，请提高 ε 后重新评估。';
  if (/does not belong/.test(msg)) return '有回答文件与当前问卷不匹配。请使用填写时的原始问卷配置。';
  if (/conflicting/.test(msg)) return '发现编号相同但内容不同的回答文件，请检查后重新导入。';
  if (/selected fields/.test(msg)) return '字段规则无效，请为已有字段选择一种处理方式。';
  if (/at least one field/.test(msg)) return '请至少选择一个要删除或遮盖的字段。';
  if (/retain at least/.test(msg)) return '请至少保留一列，才能导出 CSV 文件。';
  if (/CSV/.test(msg)) return 'CSV 格式不正确或超过限制。请检查表头是否唯一、每行列数与引号是否完整。';
  if (/option labels/.test(msg)) return '选项不能为空或重复，每个选项不超过 200 个字符。';
  if (/category count/.test(msg)) return '每道题需要 2 至 256 个选项。';
  if (/epsilon/.test(msg)) return '每题 ε 必须在 0 至 8 之间，请检查保护参数。';
  if (/file size/.test(msg)) return '文件超过首版的 4 MB 上限，请先缩小文件。';
  if (/collection size/.test(msg)) return '一次最多汇总 10,000 份文件，总大小不超过 8 MB，请减少本次选择的文件。';
  if (/JSON|schema|field type|fields do not match/.test(msg) || error instanceof SyntaxError) return '文件内容或格式不符合要求，请检查是否选择了正确的 JSON 文件。';
  if (/title/.test(msg)) return '请填写有效标题，并缩短过长的内容。';
  if (/secure context/.test(msg)) return '当前环境无法使用安全随机数，请通过本机地址或 HTTPS 打开页面。';
  return '操作未完成，请检查输入范围、文件格式与字段设置后重试。';
}
async function guarded(action, button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  notice('');
  try { await action(); }
  catch (error) { notice(humanError(error), true); }
  finally { if (button) button.disabled = false; }
}
async function fileText(file) {
  if (!file) throw new Error('JSON file required');
  if (file.size > 4_000_000) throw new Error('file size');
  return (await file.text()).replace(/^\uFEFF/, '');
}
const fileJson = async file => JSON.parse(await fileText(file));
function download(name, data, type = 'application/json') {
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const anchor = element('a', { href: url, download: name });
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function activate(group, target, attribute) {
  for (const button of $$(`[data-${attribute}]`)) button.setAttribute('aria-pressed', String(button.dataset[attribute] === target));
  for (const panel of $$(`.${group}`)) panel.hidden = panel.id !== `${group}-${target}`;
  notice('');
}
for (const button of $$('[data-view]')) button.addEventListener('click', () => activate('view', button.dataset.view, 'view'));
for (const button of $$('[data-step]')) button.addEventListener('click', () => activate('step', button.dataset.step, 'step'));
initStatistics({ callCore, element, download });

let surveyId = `survey-${crypto.randomUUID().slice(0, 8)}`;
function questionEditor(question, index) {
  const title = element('input', { value: question.title, required: true, maxLength: 500, 'data-field': 'title' });
  const options = element('textarea', { value: question.options.join('\n'), required: true, 'data-field': 'options', rows: 3 });
  const epsilon = element('input', { type: 'number', min: '.01', max: '8', step: 'any', value: question.epsilon, required: true, 'data-field': 'epsilon' });
  const remove = element('button', { type: 'button', class: 'text-button', text: '删除此题', 'aria-label': `删除第 ${index + 1} 题` });
  remove.addEventListener('click', () => { const current = currentQuestions(); if (current.length > 1) { current.splice(index, 1); renderEditor(current); } else notice('问卷至少保留一道题。', true); });
  return element('div', { class: 'question' }, [
    element('div', { class: 'question-title' }, [element('h3', { text: `问题 ${String(index + 1).padStart(2, '0')}` }), remove]),
    element('label', { class: 'field' }, [document.createTextNode('问题内容'), title]),
    element('div', { class: 'question-fields' }, [element('label', { class: 'field' }, [document.createTextNode('选项（每行一个）'), options]), element('label', { class: 'field' }, [document.createTextNode('每题 ε'), epsilon])])
  ]);
}
function currentQuestions() {
  return $$('#question-editor .question').map((row, i) => ({ id: `q${i + 1}`, title: row.querySelector('[data-field=title]').value.trim(), options: row.querySelector('[data-field=options]').value.split('\n').map(v => v.trim()), epsilon: Number(row.querySelector('[data-field=epsilon]').value) }));
}
function updateBudget() {
  const questions = currentQuestions();
  $('#create-meta').textContent = `${questions.length} 道题 · 每人单次总 ε = ${questions.reduce((sum, q) => sum + q.epsilon, 0).toFixed(2)}`;
}
function renderEditor(questions) { $('#question-editor').replaceChildren(...questions.map(questionEditor)); updateBudget(); }
$('#question-editor').addEventListener('input', updateBudget);
$('#add-question').addEventListener('click', () => {
  const questions = currentQuestions();
  if (questions.length >= 20) { notice('工作台首版最多编辑 20 道题。', true); return; }
  renderEditor([...questions, { title: '', options: ['选项一', '选项二'], epsilon: 1 }]);
  $('#question-editor .question:last-child input').focus();
});
$('#load-example').addEventListener('click', () => { $('#survey-title').value = example.title; surveyId = example.id; renderEditor(example.questions); notice('已载入虚构示例，可修改问题后导出。'); });
$('#create-form').addEventListener('submit', event => { event.preventDefault(); guarded(() => {
  const survey = validateSurvey({ schema_version: 1, id: surveyId, title: $('#survey-title').value.trim(), questions: currentQuestions() });
  download(`${survey.id}.survey.json`, survey); notice('问卷配置已导出。参与者可在“填写问卷”中载入。');
}, event.submitter); });
renderEditor([example.questions[0]]);

let fillSurvey = null, preparedResponse = null, fillGeneration = 0;
$('#fill-file').addEventListener('change', () => guarded(async () => {
  const ticket = ++fillGeneration;
  fillSurvey = preparedResponse = null;
  $('#answer-form').hidden = $('#response-ready').hidden = true;
  $('#answer-fields').replaceChildren();
  const survey = validateSurvey(await fileJson($('#fill-file').files[0]));
  if (ticket !== fillGeneration) return;
  fillSurvey = survey;
  $('#fill-title').textContent = survey.title;
  $('#fill-budget').textContent = `${survey.questions.length} 道题 · 单次总 ε = ${survey.questions.reduce((sum, q) => sum + q.epsilon, 0).toFixed(2)}`;
  $('#answer-fields').replaceChildren(...survey.questions.map((q, i) => element('fieldset', {}, [element('legend', { text: q.title }), ...q.options.map((option, j) => element('label', { class: 'radio-option' }, [element('input', { type: 'radio', name: `answer-${i}`, value: j, required: true }), document.createTextNode(option)]))])));
  $('#answer-form').hidden = false;
}));
$('#answer-form').addEventListener('submit', event => { event.preventDefault(); guarded(async () => {
  const ticket = fillGeneration;
  const answers = fillSurvey.questions.map((_, i) => Number($(`input[name=answer-${i}]:checked`).value));
  const response = await protectResponse(fillSurvey, answers);
  if (ticket !== fillGeneration) return;
  preparedResponse = response;
  $('#answer-fields').replaceChildren();
  $('#answer-form').hidden = true;
  $('#response-ready').hidden = false;
  notice('已生成受保护回答，原始选择已从表单清除。');
}, event.submitter); });
$('#download-response').addEventListener('click', () => { if (preparedResponse) download(`response-${preparedResponse.response_id}.json`, preparedResponse); });

let collectGeneration = 0;
for (const input of [$('#collect-survey'), $('#collect-files')]) input.addEventListener('change', () => { collectGeneration++; $('#collect-result').hidden = true; });
$('#collect-form').addEventListener('submit', event => { event.preventDefault(); guarded(async () => {
  $('#collect-result').hidden = true;
  const ticket = collectGeneration;
  const files = [...$('#collect-files').files];
  if (files.length > 10000 || files.reduce((sum, f) => sum + f.size, 0) > 8_000_000) throw new Error('collection size');
  const survey = validateSurvey(await fileJson($('#collect-survey').files[0]));
  const responses = await Promise.all(files.map(fileJson));
  const report = await aggregateResponses(survey, responses);
  if (ticket !== collectGeneration) return;
  const exportButton = element('button', { class: 'secondary', text: '导出统计报告' });
  exportButton.addEventListener('click', () => download(`${survey.id}.report.json`, report));
  const content = [element('div', { class: 'result-heading' }, [element('div', {}, [element('h2', { text: `${report.accepted} 份有效回答` }), element('p', { class: 'muted', text: `已忽略 ${report.duplicates} 份重复文件 · 整份问卷使用 95% 同时置信范围` })]), exportButton])];
  for (const q of report.questions) {
    const rows = q.statistics.categories.map((value, i) => element('div', { class: 'result-row' }, [element('span', { text: q.options[i] }), element('meter', { min: 0, max: 1, value: value.display_proportion, 'aria-label': `${q.options[i]}估计比例` }), element('small', { text: `${(value.display_proportion * 100).toFixed(1)}% · ${(value.lower * 100).toFixed(1)}–${(value.upper * 100).toFixed(1)}%` })]));
    content.push(element('section', { class: 'result-question' }, [element('h3', { text: q.title }), ...(!q.statistics.informative ? [element('p', { class: 'help', text: '当前误差范围很宽，暂时不能据此作出可靠的群体判断。请增加样本量或调整调查方案。' })] : []), ...rows]));
  }
  content.push(element('p', { class: 'footnote', text: '比例是经随机化校正的估计值，展示时限制在 0–100%；各选项展示值之和可能不等于 100%。误差范围不覆盖选择偏差和虚假回答。' }));
  $('#collect-result').replaceChildren(...content); $('#collect-result').hidden = false;
}, event.submitter); });

let redactionInput = null, redactionResult = null, redactGeneration = 0;
function invalidateRedaction() { redactionResult = null; $('#redact-result').hidden = true; }
function prepareRedaction(format, text, filename) {
  const fields = callCore({ op: 'inspect', format, input: text });
  redactionInput = { format, text };
  $('#redact-filename').textContent = filename;
  $('#field-policies').replaceChildren(...fields.map((name, i) => {
    const select = element('select', { id: `field-policy-${i}`, 'data-key': name }, [['keep', '保留'], ['remove', '删除'], ['mask', '遮盖']].map(([value, text]) => element('option', { value, text })));
    return element('div', { class: 'policy-row' }, [element('label', { htmlFor: select.id, text: name }), select]);
  }));
  $('#spreadsheet-label').hidden = format !== 'csv';
  $('#spreadsheet-label').nextElementSibling.hidden = format !== 'csv';
  $('#redact-form').hidden = false;
}
$('#redact-file').addEventListener('change', () => guarded(async () => {
  const ticket = ++redactGeneration;
  invalidateRedaction(); redactionInput = null; $('#redact-form').hidden = true;
  const file = $('#redact-file').files[0];
  const text = await fileText(file);
  if (ticket !== redactGeneration) return;
  const format = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
  prepareRedaction(format, text, file.name);
}));
$('#redact-example').addEventListener('click', () => guarded(() => {
  redactGeneration++; invalidateRedaction();
  prepareRedaction('csv', 'name,email,group,score\n示例甲,first@example.test,A,4\n示例乙,second@example.test,B,3', '虚构示例.csv');
  const selects = $$('#field-policies select'); selects[0].value = 'remove'; selects[1].value = 'mask';
}));
$('#redact-form').addEventListener('change', invalidateRedaction);
$('#redact-form').addEventListener('submit', event => { event.preventDefault(); guarded(() => {
  invalidateRedaction();
  const policy = { remove: [], mask: [] };
  for (const select of $$('#field-policies select')) if (select.value !== 'keep') policy[select.value].push(select.dataset.key);
  redactionResult = callCore({ op: 'redact', format: redactionInput.format, input: redactionInput.text, policy, spreadsheet_safe: $('#spreadsheet-safe').checked });
  const audit = redactionResult.audit;
  $('#redact-summary').textContent = `共 ${audit.records} 条记录 · 删除 ${audit.removed_values} 处 · 遮盖 ${audit.masked_values} 处 · 公式文本化 ${audit.spreadsheet_escapes} 处`;
  $('#redact-preview').textContent = redactionResult.output.slice(0, 8000);
  $('#redact-result').hidden = false;
}, event.submitter); });
$('#download-redacted').addEventListener('click', () => { if (redactionResult) download(`redacted.${redactionInput.format}`, redactionResult.output, redactionInput.format === 'csv' ? 'text/csv' : 'application/json'); });
$('#download-audit').addEventListener('click', () => { if (redactionResult) download('processing-record.json', redactionResult.audit); });

function metric(label, value, note) { return element('div', { class: 'metric' }, [element('span', { class: 'metric-label', text: label }), element('div', { class: 'metric-value', text: value }), element('p', { class: 'metric-note', text: note })]); }
$('#plan-form').addEventListener('input', () => { $('#plan-result').replaceChildren(element('div', { class: 'empty-state' }, [element('h2', { text: '方案已修改' }), element('p', { text: '点击“评估这个方案”更新结果。' })])); });
$('#plan-form').addEventListener('submit', event => { event.preventDefault(); guarded(() => {
  const config = Object.fromEntries([...new FormData($('#plan-form'))].map(([key, value]) => [key, Number(value)]));
  config.radius /= 100;
  const result = callCore({ ...config, op: 'plan' });
  const radius = result.plan.per_question_radius[0];
  const button = element('button', { class: 'secondary', text: '导出评估结果' });
  button.addEventListener('click', () => download('privacy-plan.json', { configuration: config, ...result }));
  $('#plan-result').replaceChildren(element('h2', { text: '这份方案的预期表现' }), metric('当前人数下的误差界', `±${(radius * 100).toFixed(1)} 个百分点`, '95% 同时覆盖本方案的全部题目与选项。'), metric('达到目标精度，预计需要', result.required_samples === null ? '超过 1,000 万人' : `${result.required_samples.toLocaleString('zh-CN')} 人`, `每个选项目标误差不超过 ±${(config.radius * 100).toFixed(2)} 个百分点。`), metric('每人的累计隐私开销 ε', result.plan.total_epsilon.toFixed(2), `${config.questions} 道题 × 每题 ε ${config.epsilon} × ${config.collections} 次采集。`), element('p', { class: 'help', text: radius >= 0.5 ? '当前统计误差很宽。建议先增加样本量、减少题目或比较其他保护参数，再开展调查。' : '该误差界较保守，假设各次随机化独立；不保证样本具有代表性。重复采集的开销已计入，人数按每次采集计算。' }), element('div', { class: 'button-row' }, [button]));
}, event.submitter); });
