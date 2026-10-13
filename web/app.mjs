import { callCore, validateSurvey, protectResponse, aggregateResponses } from '/runtime/client.mjs';
import { initStatistics } from '/web/statistics.mjs';
import { initRedaction } from '/web/redaction.mjs';
import { initPlanner } from '/web/planner.mjs';
import { reportActions } from '/web/report-actions.mjs';
import { surveyPresets, parseSurveyTemplate, createSurveyTemplate, surveyFromTemplate, parseSurvey, surveyBudget, participantGuide, formatEpsilon } from '/runtime/survey-templates.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
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
  if (/collection count/.test(msg)) return '计划采集次数须为 1 至 10,000 的整数。';
  if (/sample count/.test(msg)) return '每次预计人数须为 1 至 1,000 万的整数。';
  if (/target error/.test(msg)) return '目标误差必须大于 0 且小于 100 个百分点。';
  if (/UTF-8/.test(msg)) return '文件不是有效的 UTF-8 文本，请转换编码后重试。当前问卷已保留。';
  if (/template.*limit|at most 20/.test(msg)) return '问卷模板最多包含 20 道题，文本长度最多 100,000。';
  if (/template labels/.test(msg)) return '模板标题和选项须为单行，首尾不要留空格。';
  if (/template name/.test(msg)) return '模板名称须为 1 至 80 个字符的单行文字。';
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
  try { return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('File must be valid UTF-8.'); }
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
  window.scrollTo(0, 0);
}
for (const button of $$('[data-view]')) button.addEventListener('click', () => activate('view', button.dataset.view, 'view'));
for (const button of $$('[data-step]')) button.addEventListener('click', () => activate('step', button.dataset.step, 'step'));
const statistics = initStatistics({ callCore, element, download });
initRedaction({ callCore, element, download, notice, statistics, openStatistics: () => {
  const button = $('[data-view="statistics"]'); button.click(); button.focus();
} });

let surveyId = `survey-${crypto.randomUUID()}`;
function questionEditor(question, index) {
  const title = element('input', { value: question.title, required: true, maxLength: 500, 'data-field': 'title' });
  const options = element('textarea', { value: question.options.join('\n'), required: true, 'data-field': 'options', rows: Math.min(6, Math.max(3, question.options.length)) });
  const epsilon = element('input', { type: 'number', min: '0', max: '8', step: 'any', value: question.epsilon, required: true, 'data-field': 'epsilon' });
  const remove = element('button', { type: 'button', class: 'text-button', text: '删除此题', 'aria-label': `删除第 ${index + 1} 题` });
  remove.addEventListener('click', () => { const current = currentQuestions(); if (current.length > 1) { current.splice(index, 1); renderEditor(current); } else notice('问卷至少保留一道题。', true); });
  return element('div', { class: 'question', 'data-question-id': question.id }, [
    element('div', { class: 'question-title' }, [element('h3', { text: `问题 ${String(index + 1).padStart(2, '0')}` }), remove]),
    element('label', { class: 'field' }, [document.createTextNode('问题内容'), title]),
    element('div', { class: 'question-fields' }, [element('label', { class: 'field' }, [document.createTextNode('选项（每行一个）'), options]), element('label', { class: 'field' }, [document.createTextNode('每题 ε'), epsilon])])
  ]);
}
function currentQuestions() {
  return $$('#question-editor .question').map(row => ({ id: row.dataset.questionId, title: row.querySelector('[data-field=title]').value.trim(), options: row.querySelector('[data-field=options]').value.split('\n').map(v => v.trim()), epsilon: Number(row.querySelector('[data-field=epsilon]').value) }));
}
const currentSurvey = () => validateSurvey({ schema_version: 1, id: surveyId, title: $('#survey-title').value.trim(), questions: currentQuestions() });
const plannedCollections = () => Number($('#survey-collections').value);
const planner = initPlanner({ callCore, element, download, guarded, currentSurvey, plannedCollections,
  openSurvey: () => { $('[data-view=survey]').click(); $('[data-step=create]').click(); $('#survey-title').focus(); },
  openPlan: () => $('[data-view=plan]').click(),
});
$('#survey-evaluate').addEventListener('click', () => guarded(() => planner.openCurrent()));
const budgetText = b => `${b.questions} 道题 · 每人单次 ε ≈ ${formatEpsilon(b.single_epsilon)} · ${b.collections} 次累计 ε ≈ ${formatEpsilon(b.total_epsilon)}`;
function updateBudget() {
  try { $('#create-meta').textContent = budgetText(surveyBudget(currentSurvey(), plannedCollections())); }
  catch { $('#create-meta').textContent = '完善题目、保护参数与计划次数后显示开销'; }
  planner.draftChanged();
}
function renderEditor(questions) { $('#question-editor').replaceChildren(...questions.map(questionEditor)); updateBudget(); }
$('#create-form').addEventListener('input', updateBudget);
$('#add-question').addEventListener('click', () => {
  const questions = currentQuestions();
  if (questions.length >= 20) { notice('工作台首版最多编辑 20 道题。', true); return; }
  renderEditor([...questions, { id: `q-${crypto.randomUUID()}`, title: '', options: ['选项一', '选项二'], epsilon: 1 }]);
  $('#question-editor .question:last-child input').focus();
});
let pendingTemplate = null, templateGeneration = 0;
function dismissTemplate() {
  templateGeneration++; pendingTemplate = null;
  $('#survey-template-preview').hidden = true;
  $('#survey-template-file').value = ''; $('#survey-preset').value = '';
}
function previewTemplate(template, description) {
  pendingTemplate = template;
  $('#survey-template-title').textContent = template.name;
  $('#survey-template-description').textContent = description;
  $('#survey-template-questions').replaceChildren(...template.settings.questions.map(q => element('li', { text: `${q.title}（${q.options.join(' / ')}；ε = ${formatEpsilon(q.epsilon)}）` })));
  const survey = { schema_version: 1, id: 'preview', title: template.settings.title, questions: template.settings.questions };
  $('#survey-template-budget').textContent = budgetText(surveyBudget(survey, template.settings.plannedCollections));
  $('#survey-template-preview').hidden = false;
}
for (const preset of surveyPresets) $('#survey-preset').append(element('option', { value: preset.id, text: preset.name }));
$('#survey-preset').addEventListener('change', () => {
  notice('');
  const preset = surveyPresets.find(item => item.id === $('#survey-preset').value);
  templateGeneration++; pendingTemplate = null; $('#survey-template-file').value = ''; $('#survey-template-preview').hidden = true;
  if (preset) previewTemplate(preset.template, preset.description);
});
$('#survey-template-file').addEventListener('change', () => guarded(async () => {
  const ticket = ++templateGeneration;
  pendingTemplate = null; $('#survey-preset').value = ''; $('#survey-template-preview').hidden = true;
  try {
    const text = await fileText($('#survey-template-file').files[0]);
    if (ticket === templateGeneration) previewTemplate(parseSurveyTemplate(text), '已校验导入的配置。请复核题目和保护参数后应用。');
  } catch (error) { if (ticket === templateGeneration) throw error; }
}));
$('#survey-template-dismiss').addEventListener('click', () => { dismissTemplate(); notice(''); $('#survey-preset').focus(); });
$('#survey-template-apply').addEventListener('click', () => guarded(() => {
  if (!pendingTemplate) return;
  const survey = surveyFromTemplate(pendingTemplate);
  surveyId = survey.id; $('#survey-title').value = survey.title;
  $('#survey-collections').value = pendingTemplate.settings.plannedCollections;
  $('#survey-template-name').value = pendingTemplate.name;
  renderEditor(survey.questions); dismissTemplate(); $('#survey-templates').open = false;
  $('#survey-title').focus(); notice('已创建新问卷，请复核后导出配置与参与说明。');
}));
$('#survey-template-export').addEventListener('click', () => guarded(() => {
  const template = createSurveyTemplate($('#survey-template-name').value.trim(), currentSurvey(), plannedCollections());
  download('questionnaire.survey-template.json', template); notice('问卷模板已导出，可用于创建其他问卷。');
}, $('#survey-template-export')));
$('#survey-guide-export').addEventListener('click', () => guarded(async () => {
  const survey = currentSurvey(), collections = plannedCollections();
  const instructions = await participantGuide(survey, collections);
  if (JSON.stringify(survey) !== JSON.stringify(currentSurvey()) || collections !== plannedCollections()) {
    notice('问卷或计划已修改，请重新下载参与说明。', true); return;
  }
  download(`${survey.id}.participation.txt`, instructions, 'text/plain');
  notice('参与说明已导出。请补充用途、收集渠道与保留期限，连同对应配置一起发送。');
}, $('#survey-guide-export')));
$('#create-form').addEventListener('submit', event => { event.preventDefault(); guarded(() => {
  const survey = currentSurvey();
  surveyBudget(survey, plannedCollections());
  download(`${survey.id}.survey.json`, survey); notice('问卷配置已导出。参与者可在“填写问卷”中载入。');
}, event.submitter); });
renderEditor([surveyPresets[0].template.settings.questions[0]]);

let fillSurvey = null, preparedResponse = null, pendingFillSurvey = null, fillBusy = false;
function syncFillControls() {
  $('#fill-file').disabled = fillBusy;
  $('#protect-button').disabled = fillBusy || !!pendingFillSurvey;
  $('#fill-replace').disabled = $('#fill-cancel').disabled = fillBusy;
}
function loadFillSurvey(survey) {
  fillSurvey = survey;
  preparedResponse = pendingFillSurvey = null;
  $('#response-ready').hidden = $('#fill-replacement').hidden = true;
  $('#fill-title').textContent = survey.title;
  const budget = surveyBudget(survey);
  $('#fill-budget').textContent = `${budget.questions} 道题 · 单次 ε ≈ ${formatEpsilon(budget.single_epsilon)}`;
  $('#fill-privacy-note').textContent = `每人完整填写一次的开销上界 ε 约为 ${formatEpsilon(budget.single_epsilon)}；同一人分别生成并提交两次会累计至约 ${formatEpsilon(budget.single_epsilon * 2)}。本工具不限制重复参与。重传请复用原回答文件，不要重新生成。随机化不保证每次选项改变，也不保证匿名。`;
  $('#answer-fields').replaceChildren(...survey.questions.map((q, i) => element('fieldset', {}, [element('legend', { text: q.title }), ...q.options.map((option, j) => element('label', { class: 'radio-option' }, [element('input', { type: 'radio', name: `answer-${i}`, value: j, required: true }), document.createTextNode(option)]))])));
  $('#answer-form').hidden = false;
  syncFillControls();
}
$('#fill-file').addEventListener('change', () => guarded(async () => {
  if (fillBusy) return;
  fillBusy = true; pendingFillSurvey = null; $('#fill-replacement').hidden = true; syncFillControls();
  try {
    const survey = parseSurvey(await fileText($('#fill-file').files[0]));
    if (!fillSurvey) loadFillSurvey(survey);
    else {
      pendingFillSurvey = survey;
      $('#fill-replacement-note').textContent = `当前：${fillSurvey.title}。准备载入：${survey.title}（${survey.questions.length} 道题）。`;
      $('#fill-replacement').hidden = false;
    }
  } finally { fillBusy = false; $('#fill-file').value = ''; syncFillControls(); }
}));
$('#fill-cancel').addEventListener('click', () => { pendingFillSurvey = null; $('#fill-replacement').hidden = true; syncFillControls(); $('#fill-file').focus(); });
$('#fill-replace').addEventListener('click', () => { if (pendingFillSurvey && !fillBusy) { loadFillSurvey(pendingFillSurvey); $('#answer-fields input').focus(); } });
$('#answer-form').addEventListener('submit', event => { event.preventDefault(); guarded(async () => {
  if (fillBusy || pendingFillSurvey || !fillSurvey || preparedResponse) return;
  fillBusy = true; syncFillControls();
  try {
    const answers = fillSurvey.questions.map((_, i) => Number($(`input[name=answer-${i}]:checked`).value));
    preparedResponse = await protectResponse(fillSurvey, answers);
    $('#answer-fields').replaceChildren();
    $('#answer-form').hidden = true;
    $('#response-survey-title').textContent = fillSurvey.title;
    $('#response-ready').hidden = false;
    notice('已生成受保护回答，原始选择已从表单清除。');
  } finally { fillBusy = false; syncFillControls(); }
}); });
$('#download-response').addEventListener('click', () => { if (preparedResponse) download(`response-${preparedResponse.response_id}.json`, preparedResponse); });

let collectGeneration = 0;
for (const input of [$('#collect-survey'), $('#collect-files')]) input.addEventListener('change', () => { collectGeneration++; $('#collect-result').hidden = true; });
$('#collect-form').addEventListener('submit', event => { event.preventDefault(); guarded(async () => {
  $('#collect-result').hidden = true;
  const ticket = collectGeneration;
  const files = [...$('#collect-files').files];
  if (files.length > 10000 || files.reduce((sum, f) => sum + f.size, 0) > 8_000_000) throw new Error('collection size');
  const survey = parseSurvey(await fileText($('#collect-survey').files[0]));
  const responses = await Promise.all(files.map(fileJson));
  const report = await aggregateResponses(survey, responses);
  if (ticket !== collectGeneration) return;
  const exportButton = reportActions({ kind: 'survey', report, filename: `${survey.id}.report`, jsonLabel: '导出统计报告', element, download });
  const content = [element('div', { class: 'result-heading' }, [element('div', {}, [element('h2', { text: `${report.accepted} 份有效回答` }), element('p', { class: 'muted', text: `已忽略 ${report.duplicates} 份重复文件 · 整份问卷使用 95% 同时置信范围` })]), exportButton])];
  for (const q of report.questions) {
    const rows = q.statistics.categories.map((value, i) => element('div', { class: 'result-row' }, [element('span', { text: q.options[i] }), element('meter', { min: 0, max: 1, value: value.display_proportion, 'aria-label': `${q.options[i]}估计比例` }), element('small', { text: `${(value.display_proportion * 100).toFixed(1)}% · ${(value.lower * 100).toFixed(1)}–${(value.upper * 100).toFixed(1)}%` })]));
    content.push(element('section', { class: 'result-question' }, [element('h3', { text: q.title }), ...(!q.statistics.informative ? [element('p', { class: 'help', text: '当前误差范围很宽，暂时不能据此作出可靠的群体判断。请增加样本量或调整调查方案。' })] : []), ...rows]));
  }
  content.push(element('p', { class: 'footnote', text: '比例是经随机化校正的估计值，展示时限制在 0–100%；各选项展示值之和可能不等于 100%。误差范围不覆盖选择偏差和虚假回答。' }));
  $('#collect-result').replaceChildren(...content); $('#collect-result').hidden = false;
}, event.submitter); });
