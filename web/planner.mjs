import { assessSurvey } from '/runtime/survey-assessment.mjs';
import { surveyBudget, formatEpsilon } from '/runtime/survey-templates.mjs';
import { reportActions } from '/web/report-actions.mjs';

export function initPlanner({ callCore, element, download, guarded, currentSurvey, plannedCollections, openSurvey, openPlan }) {
  const $ = selector => document.querySelector(selector);
  const form = $('#plan-form'), resultBox = $('#plan-result');
  const input = name => form.elements.namedItem(name);
  let mode = 'custom', source = null, stale = false, revision = 0, busy = false;
  const number = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const points = radius => number(radius * 100);
  const metric = (label, value, note) => element('div', { class: 'metric' }, [element('span', { class: 'metric-label', text: label }), element('div', { class: 'metric-value', text: value }), element('p', { class: 'metric-note', text: note })]);

  function sync() {
    $('#plan-mode-custom').setAttribute('aria-pressed', String(mode === 'custom'));
    $('#plan-mode-survey').setAttribute('aria-pressed', String(mode === 'survey'));
    $('#plan-uniform-fields').hidden = $('#plan-uniform-fields').disabled = mode === 'survey';
    $('#plan-survey-source').hidden = mode !== 'survey';
    $('#plan-run').disabled = busy || (mode === 'survey' && (!source || stale));
    $('#plan-run').textContent = busy ? '正在评估…' : '评估这个方案';
  }
  function invalidate(title, message) {
    revision++;
    resultBox.replaceChildren(element('div', { class: 'empty-state' }, [element('span', { 'aria-hidden': 'true', text: '±' }), element('h2', { text: title }), element('p', { text: message })]));
  }
  function useCurrent() {
    const survey = currentSurvey(), collections = plannedCollections();
    const budget = surveyBudget(survey, collections);
    source = { survey, collections, key: JSON.stringify({ survey, collections }) };
    stale = false; mode = 'survey'; input('collections').value = collections;
    $('#plan-survey-title').textContent = survey.title;
    $('#plan-survey-description').textContent = `${budget.questions} 道题 · 每人单次 ε ≈ ${formatEpsilon(budget.single_epsilon)} · 原计划 ${collections} 次`;
    $('#plan-survey-state').textContent = '按每题实际选项和保护参数计算，无需重新录入。';
    $('#plan-survey-state').className = 'source-state';
    invalidate('问卷已载入', '设置每次预计人数与目标误差，查看各题能达到的精度。');
    sync();
  }
  function draftChanged() {
    if (!source || stale) return;
    let key;
    try { key = JSON.stringify({ survey: currentSurvey(), collections: plannedCollections() }); }
    catch { key = null; }
    if (key === source.key) return;
    stale = true;
    $('#plan-survey-state').textContent = '问卷已修改，请重新载入当前问卷后评估。';
    $('#plan-survey-state').className = 'source-state source-stale';
    if (mode === 'survey') invalidate('问卷已修改', '旧结果已收起。重新载入当前问卷，再检查新的题目和采集计划。');
    sync();
  }
  $('#plan-mode-custom').addEventListener('click', () => {
    if (mode === 'custom') return;
    mode = 'custom'; invalidate('比较一个自定义方案', '这里按每题相同的选项数和 ε 估算，不修改问卷编辑器。'); sync();
  });
  $('#plan-mode-survey').addEventListener('click', () => guarded(useCurrent));
  $('#plan-reload').addEventListener('click', () => guarded(useCurrent));
  $('#plan-edit').addEventListener('click', openSurvey);
  form.addEventListener('input', () => {
    invalidate('方案已修改', '点击“评估这个方案”更新结果。'); sync();
  });

  function precisionBar(question, target) {
    const svgNode = (name, attrs) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      return node;
    };
    const bar = svgNode('svg', { viewBox: '0 0 600 24', class: 'precision-bar', role: 'img', 'aria-label': `误差界约 ${points(question.radius)} 个百分点，目标 ${points(target)} 个百分点` });
    bar.append(
      svgNode('rect', { x: 0, y: 8, width: 600, height: 8, rx: 4, class: 'bar-track' }),
      svgNode('rect', { x: 0, y: 8, width: Math.max(1, Math.min(1, question.radius) * 600), height: 8, rx: 4, class: question.target_met ? 'bar-value' : 'bar-value bar-over' }),
      svgNode('line', { x1: target * 600, x2: target * 600, y1: 2, y2: 22, class: 'bar-target' }),
    );
    return bar;
  }

  function renderSurvey(report) {
    const a = report.assessment;
    const needs = q => q.reason === 'no_signal' ? '无法通过增加人数解决' : q.reason === 'above_limit' ? '超过 1,000 万人' : `${number(q.required_samples)} 人`;
    const met = a.questions.filter(q => q.target_met).length;
    const heading = a.target_met ? '当前人数达到设定的精度目标' : a.reason === 'no_signal' ? '有题目无法估计真实比例' : a.reason === 'above_limit' ? '所需人数超出当前评估范围' : '当前人数尚未达到全部题目的目标';
    const note = a.reason === 'no_signal' ? '这些题目的 ε 为 0 或过小，随机化后没有可用于估计的信号。返回编辑题目，复核参数与收集必要性。' : a.reason === 'above_limit' ? '至少一题达到目标需要超过 1,000 万人。可复核目标误差、题目选项与保护参数后重新评估。' : `按保守误差界，每次收集 ${number(a.required_samples)} 份独立回答，可让所有题目达到目标。`;
    const rows = a.questions.map((q, i) => {
      const title = element('div', { class: 'precision-title' }, [element('h3', { text: `${i + 1}. ${q.title}` }), element('span', { class: `precision-state ${q.target_met ? 'is-ready' : 'needs-review'}`, text: q.reason === 'no_signal' ? '无法估计' : q.target_met ? '达到目标' : '未达目标' })]);
      const meta = element('p', { class: 'muted', text: `${q.categories} 个选项 · ε = ${formatEpsilon(q.epsilon)}` });
      const values = element('div', { class: 'precision-values' }, [element('strong', { text: q.radius === null ? '无统计信号' : `±${points(q.radius)} 个百分点` }), element('span', { text: `所需人数：${needs(q)}` })]);
      return element('li', {}, [title, meta, values, ...(q.radius === null ? [element('p', { class: 'footnote', text: '请先复核本题参数，其他题目的评估仍有效。' })] : [precisionBar(q, a.target_radius)]), ...(q.radius > 1 ? [element('p', { class: 'footnote', text: '误差超过 100 个百分点；刻度条显示至 100。' })] : [])]);
    });
    const exportButton = reportActions({ kind: 'assessment', report, filename: `${report.surveyId}.assessment`, jsonLabel: '导出逐题评估', element, download });
    const edit = element('button', { class: 'text-button', type: 'button', text: '返回调整问卷' }); edit.addEventListener('click', openSurvey);
    resultBox.replaceChildren(
      element('p', { class: 'eyebrow', text: '问卷精度检查' }),
      element('h2', { text: '当前问卷的预期表现' }),
      element('div', { class: `assessment-conclusion ${a.target_met ? 'is-ready' : ''}` }, [element('h3', { text: heading }), element('p', { text: note })]),
      element('div', { class: 'assessment-metrics' }, [metric('达到目标的题目', `${met} / ${a.questions.length}`, `每次预计 ${number(a.samples)} 人`), metric('各题目标误差', `±${points(a.target_radius)}`, '单位：百分点'), metric('每人累计开销 ε', formatEpsilon(a.total_epsilon), `${a.collections} 次采集，单次约 ${formatEpsilon(a.single_epsilon)}`)]),
      element('div', { class: 'precision-legend' }, [element('span', { text: '逐题误差界 · 越短越精确' }), element('span', { text: `竖线为目标 ±${points(a.target_radius)}；刻度 0–100` })]),
      element('ol', { class: 'precision-list' }, rows),
      element('p', { class: 'help', text: '95% 同时范围覆盖单次采集的全部题目与选项，假设随机化独立；不覆盖样本选择偏差或虚假回答。重复采集只累加开销，不自动增加每次的独立人数。评估不生成回答，也不消耗发布预算。' }),
      element('div', { class: 'button-row' }, [exportButton, edit]),
    );
  }

  function renderCustom(config, result) {
    const radius = result.plan.per_question_radius[0];
    const button = reportActions({ kind: 'plan', report: { configuration: config, ...result }, filename: 'privacy-plan', jsonLabel: '导出评估结果', element, download });
    resultBox.replaceChildren(element('p', { class: 'eyebrow', text: '统一参数评估' }), element('h2', { text: '这份方案的预期表现' }), metric('当前人数下的误差界', `±${points(radius)} 个百分点`, '95% 同时覆盖单次采集的全部题目与选项。'), metric('达到目标精度，预计需要', result.required_samples === null ? '超过 1,000 万人' : `${number(result.required_samples)} 人`, `每个选项目标误差不超过 ±${points(config.radius)} 个百分点。`), metric('每人的累计隐私开销 ε', formatEpsilon(result.plan.total_epsilon), `${config.questions} 道题 × 每题 ε ${config.epsilon} × ${config.collections} 次采集。`), element('p', { class: 'help', text: radius >= 0.5 ? '当前统计误差很宽。建议先增加样本量、减少题目或比较其他保护参数，再开展调查。' : '该误差界较保守，假设各次随机化独立；不保证样本具有代表性。重复采集的开销已计入，人数按每次采集计算。' }), element('div', { class: 'button-row' }, [button]));
  }

  form.addEventListener('submit', event => { event.preventDefault(); guarded(async () => {
    if (busy || (mode === 'survey' && stale)) return;
    const ticket = ++revision, selectedMode = mode;
    const config = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, Number(value)]));
    config.radius /= 100;
    busy = true; sync();
    // Hide old downloads before evaluation; failures cannot leave a stale report.
    resultBox.replaceChildren(element('p', { role: 'status', text: '正在计算误差与样本量…' }));
    try {
      const result = selectedMode === 'survey'
        ? await assessSurvey(source.survey, { samples: config.samples, targetRadius: config.radius, collections: config.collections })
        : callCore({ ...config, op: 'plan' });
      if (ticket !== revision) return;
      if (selectedMode === 'survey') renderSurvey(result); else renderCustom(config, result);
      resultBox.focus({ preventScroll: true });
    } catch (error) {
      if (ticket !== revision) return;
      invalidate('尚未完成评估', '请检查人数、目标误差和保护参数后重试。');
      throw error;
    } finally { busy = false; sync(); }
  }); });
  sync();
  return {
    draftChanged,
    openCurrent() { useCurrent(); openPlan(); $('#plan-survey-title').scrollIntoView({ block: 'nearest' }); input('samples').focus({ preventScroll: true }); },
  };
}
