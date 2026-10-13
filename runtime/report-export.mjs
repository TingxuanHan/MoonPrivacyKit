// Formatting only: no random source, source records, network or ledger access.
const fail = () => { throw new Error('Invalid or unsupported report. Use an unchanged MoonPrivacyKit report and its matching report type.'); };
const expect = condition => { if (!condition) fail(); };
function object(value, required, optional = []) {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value));
  expect(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
  return value;
}
function text(value, max = 500) { expect(typeof value === 'string' && value.trim().length > 0 && value.length <= max); return value; }
function number(value, min = 0, max = Number.MAX_SAFE_INTEGER) { expect(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max); return value; }
function integer(value, min = 0, max = 10000000) { number(value, min, max); expect(Number.isSafeInteger(value)); return value; }
function list(value, min = 1, max = 256) { expect(Array.isArray(value) && value.length >= min && value.length <= max); return value; }
function boolean(value) { expect(typeof value === 'boolean'); return value; }
function fingerprint(value) { expect(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); return value; }
function unique(values) { expect(new Set(values).size === values.length); }
function close(a, b) { expect(Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(b))); }
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 6, useGrouping: true });
// Round confidence bounds outward so display precision never narrows them.
const percent = (value, edge) => `${n((edge === 'lower' ? Math.floor : edge === 'upper' ? Math.ceil : Math.round)(value * 10000) / 100)}%`;
const points = (value, outward = false) => `${outward ? n(Math.ceil(value * 10000) / 100) : String(value * 100)} 个百分点`;
const paragraph = value => `<p>${escape(value)}</p>`;
const metadata = pairs => `<dl class="facts">${pairs.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`;
function table(headers, rows) {
  return `<table><thead><tr>${headers.map(h => `<th scope="col">${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((cell, i) => `<td data-label="${escape(headers[i])}">${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
const section = (title, body) => `<section><h2>${escape(title)}</h2>${body}</section>`;
const scope = lines => section('保护范围与使用条件', lines.map(paragraph).join(''));
const RR_SCOPE = [
  '回答在参与者本地按随机响应机制保护。保护回答内容，不隐藏参与事实、传送身份或网络元数据；依赖可信客户端与独立、安全的随机化。',
  '95% 同时范围覆盖单次采集的全部题目与选项，不覆盖全部重复批次。误差不包含选择偏差、虚假回答或非代表性样本造成的偏差。',
];
const PLAN_SCOPE = [...RR_SCOPE,
  '这是基于公开配置的规划，不是实际调查结果。每次人数单独计算；重复采集只累加计划开销，不能代替独立参与者，也不实施参与次数限制。',
  '调整 ε 会同时改变保护强度与统计精度；增加 ε 不能视为无代价的精度改进。评估不生成回答或消耗发布预算。',
];

function surveyReport(r) {
  const base = ['survey_id', 'accepted', 'duplicates', 'questionnaire_confidence', 'questions'];
  const versioned = Object.hasOwn(r, 'schema_version');
  object(r, versioned ? [...base, 'schema_version', 'mechanism', 'survey_title', 'survey_fingerprint', 'single_epsilon'] : base);
  text(r.survey_id, 80); integer(r.accepted, 1, 100000); integer(r.duplicates, 0, 99999); expect(r.accepted + r.duplicates <= 100000);
  expect(r.questionnaire_confidence === .95);
  if (versioned) {
    expect(r.schema_version === 1 && r.mechanism === 'rr24-v1');
    text(r.survey_title); fingerprint(r.survey_fingerprint); number(r.single_epsilon, 0, 800);
  }
  list(r.questions, 1, 100);
  unique(r.questions.map(q => text(q.id, 80)));
  let total = 0;
  const sections = r.questions.map((q, index) => {
    object(q, ['id', 'title', 'options', 'statistics', ...(versioned ? ['epsilon'] : [])]);
    text(q.title); list(q.options, 2, 256).forEach(option => text(option, 200)); unique(q.options);
    if (versioned) total += number(q.epsilon, 0, 8);
    const s = object(q.statistics, ['samples', 'confidence', 'simultaneous_radius', 'informative', 'categories']);
    expect(s.samples === r.accepted); close(number(s.confidence, .5, 1), 1 - .05 / r.questions.length);
    number(s.simultaneous_radius); expect(boolean(s.informative) === (s.simultaneous_radius < .5));
    list(s.categories, q.options.length, q.options.length);
    let reported = 0;
    const rows = s.categories.map((v, i) => {
      object(v, ['category', 'reported_count', 'raw_proportion', 'display_proportion', 'lower', 'upper']);
      expect(v.category === i); reported += integer(v.reported_count, 0, r.accepted);
      number(v.raw_proportion, -Number.MAX_SAFE_INTEGER); number(v.display_proportion, 0, 1); number(v.lower, 0, 1); number(v.upper, v.lower, 1);
      close(v.display_proportion, Math.max(0, Math.min(1, v.raw_proportion)));
      close(v.lower, Math.max(0, Math.min(1, v.raw_proportion - s.simultaneous_radius)));
      close(v.upper, Math.max(0, Math.min(1, v.raw_proportion + s.simultaneous_radius)));
      return [q.options[i], percent(v.display_proportion), `${percent(v.lower, 'lower')} – ${percent(v.upper, 'upper')}`];
    });
    expect(reported === r.accepted);
    return section(`${index + 1}. ${q.title}`, paragraph(`${q.options.length} 个选项${versioned ? ` · ε ${q.epsilon}` : ''} · 误差界 ±${points(s.simultaneous_radius, true)}`) +
      (!s.informative ? '<p class="caution">当前误差范围较宽，不宜据此作出可靠的群体判断。</p>' : '') +
      table(['选项', '估计比例', '同时误差范围'], rows));
  });
  if (versioned) close(total, r.single_epsilon);
  return {
    type: '问卷汇总报告', title: versioned ? r.survey_title : '隐私问卷汇总',
    intro: '汇总已受保护的回答，估计本次参与者的群体意见。',
    facts: [['有效回答', `${n(r.accepted)} 份`], ['忽略重复文件', `${n(r.duplicates)} 份`], ['同时置信水平', '95%'], ...(versioned ? [['每人单次开销 ε', String(r.single_epsilon)]] : [])],
    body: (!versioned ? '<p class="caution">旧版报告未保存标题、各题 ε 与配置指纹，请以原问卷配置为准。</p>' : '') + sections.join('') + scope([...RR_SCOPE,
      '展示比例和区间限制在 0–100%，比例保留至两位小数，区间向外取整；各选项展示比例之和可能不等于 100%。去重只识别相同响应文件，不能证明每个自然人仅参与一次。',
      '报告没有个人回答或响应编号。重新排版和下载已有结果不生成新回答；同一人的重复参与仍需累计核算相关开销。',
    ]),
    identity: [['问卷编号', r.survey_id], ...(versioned ? [['配置指纹（SHA-256）', r.survey_fingerprint], ['机制版本', r.mechanism]] : [])],
  };
}

function assessmentReport(r) {
  object(r, ['schemaVersion', 'kind', 'surveyId', 'surveyTitle', 'surveyFingerprint', 'assessment']);
  expect(r.schemaVersion === 1 && r.kind === 'moonprivacykit/survey-assessment');
  text(r.surveyId, 80); text(r.surveyTitle); fingerprint(r.surveyFingerprint);
  const a = object(r.assessment, ['samples', 'collections', 'target_radius', 'confidence', 'single_epsilon', 'total_epsilon', 'required_samples', 'reason', 'target_met', 'questions']);
  integer(a.samples, 1); integer(a.collections, 1, 10000); number(a.target_radius, Number.MIN_VALUE, 1); expect(a.target_radius < 1 && a.confidence === .95);
  number(a.single_epsilon, 0, 800); number(a.total_epsilon, 0, 8000000); close(a.total_epsilon, a.single_epsilon * a.collections);
  list(a.questions, 1, 100); unique(a.questions.map(q => text(q.id, 80)));
  let total = 0, required = 1, reason = '';
  const rows = a.questions.map(q => {
    object(q, ['id', 'title', 'categories', 'epsilon', 'radius', 'required_samples', 'reason', 'target_met']);
    text(q.title); integer(q.categories, 2, 256); total += number(q.epsilon, 0, 8); boolean(q.target_met);
    expect(['', 'no_signal', 'above_limit'].includes(q.reason));
    if (q.reason === 'no_signal') { expect(q.radius === null && q.required_samples === null && !q.target_met); reason = 'no_signal'; }
    else {
      number(q.radius); expect(q.target_met === (q.radius <= a.target_radius));
      if (q.reason === 'above_limit') { expect(q.required_samples === null && !q.target_met); if (reason !== 'no_signal') reason = 'above_limit'; }
      else { required = Math.max(required, integer(q.required_samples, 1)); expect(q.target_met === (a.samples >= q.required_samples)); }
    }
    return [q.title, `${q.categories} 个选项 · ε ${q.epsilon}`, q.radius === null ? '无统计信号' : `±${points(q.radius, true)}`, q.reason === 'no_signal' ? '增加人数不能解决' : q.reason === 'above_limit' ? '超过 1,000 万人' : `${n(q.required_samples)} 人`, q.target_met ? '达到目标' : q.reason === 'no_signal' ? '无法估计' : '未达目标'];
  });
  close(total, a.single_epsilon); expect(a.reason === reason && a.required_samples === (reason ? null : required));
  expect(boolean(a.target_met) === a.questions.every(q => q.target_met));
  const conclusion = a.target_met ? '当前人数达到全部题目的目标。' : reason === 'no_signal' ? '部分题目没有统计信号，请复核 ε 与收集必要性。' : reason === 'above_limit' ? '至少一题的所需人数超过当前 1,000 万人的评估范围。' : `按保守误差界，每次至少需要 ${n(required)} 人，才能达到全部题目的目标。`;
  return {
    type: '逐题精度评估', title: r.surveyTitle, intro: conclusion,
    facts: [['每次预计人数', `${n(a.samples)} 人`], ['目标误差', `±${points(a.target_radius)}`], ['计划采集次数', n(a.collections)], ['每人累计开销 ε', String(a.total_epsilon)]],
    body: section('各题预期表现', table(['题目', '保护配置', '当前误差界', '所需人数', '状态'], rows)) + scope(PLAN_SCOPE),
    identity: [['问卷编号', r.surveyId], ['配置指纹（SHA-256）', r.surveyFingerprint]],
  };
}

function statisticsReport(r) {
  object(r, ['schema_version', 'release_id', 'categories', 'report']);
  expect(r.schema_version === 1); expect(typeof r.release_id === 'string' && /^[a-f0-9-]{36}$/.test(r.release_id));
  const s = object(r.report, ['schema_version', 'mechanism', 'query', 'adjacency', 'epsilon', 'epsilon_upper_bound', 'max_contributions', 'category_count', 'output_upper', 'confidence', 'absolute_error_bound', 'counts']);
  expect(s.schema_version === 1 && s.mechanism === 'central-geometric24-v1' && ['count', 'histogram'].includes(s.query));
  expect(s.adjacency === 'add_remove_user');
  number(s.epsilon, .01, 8); number(s.epsilon_upper_bound, 0, s.epsilon); integer(s.max_contributions, 1, 32);
  integer(s.category_count, 1, 256); expect(s.output_upper === 100000 && s.confidence === .95); integer(s.absolute_error_bound, 0, s.output_upper);
  list(s.counts, s.category_count, s.category_count).forEach(v => integer(v, 0, s.output_upper));
  if (s.query === 'count') { expect(s.category_count === 1); list(r.categories, 0, 0); }
  else { list(r.categories, s.category_count, s.category_count).forEach(c => text(c, 128)); unique(r.categories); }
  const rows = s.counts.map((v, i) => [s.query === 'count' ? (s.max_contributions === 1 ? '受保护人数' : '受保护记录数') : r.categories[i], n(v), `${n(Math.max(0, v - s.absolute_error_bound))} – ${n(Math.min(s.output_upper, v + s.absolute_error_bound))}`]);
  return {
    type: '隐私统计报告', title: s.query === 'count' ? '受保护计数' : '受保护类别分布',
    intro: '以下为已保存的中心化差分隐私结果。导出只进行排版，不重新加噪或扣减预算。',
    facts: [['本次隐私预算 ε', n(s.epsilon)], ['每人贡献上限', `${s.max_contributions} 条`], ['同时置信水平', '95%'], ['绝对误差界', `±${n(s.absolute_error_bound)}`]],
    body: section('受保护结果', table(['统计项', '受保护计数', '同时误差范围'], rows)) + scope([
      '采用中心化差分隐私，以增加或删除一个人的全部记录为相邻关系。依赖可信数据持有方和正确、稳定的人员标识，不能保护持有方已经知晓的原始明细。',
      '结果已加入随机噪声，0 不代表无人参与。误差范围针对按人裁剪后的统计量，不覆盖贡献裁剪偏差、样本偏差或错误标识。',
      '类别与参数须事先确定。每人贡献上限为 1 时估计不同人员数；大于 1 时统计裁剪后的记录数。',
      '本文件不包含原始记录、人员标识、项目路径或账本余额。本次 ε 不是剩余预算；新发布仍需沿用受控账本累计开销，重复查看或导出复用原结果。',
    ]),
    identity: [['结果编号', r.release_id], ['机制版本', s.mechanism]],
  };
}

function planReport(r) {
  object(r, ['configuration', 'plan', 'required_samples', 'mechanism']);
  const c = object(r.configuration, ['categories', 'questions', 'epsilon', 'samples', 'radius', 'collections']);
  integer(c.categories, 2, 256); integer(c.questions, 1, 100); number(c.epsilon, Number.MIN_VALUE, 8); integer(c.samples, 1); integer(c.collections, 1, 10000); number(c.radius, Number.MIN_VALUE, 1); expect(c.radius < 1);
  const p = object(r.plan, ['questions', 'collections', 'total_epsilon', 'sample_count', 'per_question_radius']);
  expect(p.questions === c.questions && p.collections === c.collections && p.sample_count === c.samples);
  close(number(p.total_epsilon), c.questions * c.epsilon * c.collections);
  list(p.per_question_radius, c.questions, c.questions).forEach(radius => { number(radius); expect(radius === p.per_question_radius[0]); });
  const m = object(r.mechanism, ['categories', 'threshold', 'requested_epsilon', 'effective_epsilon', 'truthful_probability', 'other_probability']);
  expect(m.categories === c.categories && m.requested_epsilon === c.epsilon); integer(m.threshold, 1, 16777215); number(m.effective_epsilon, 0, c.epsilon); number(m.truthful_probability, 0, 1); number(m.other_probability, 0, 1);
  if (r.required_samples !== null) integer(r.required_samples, 1);
  return {
    type: '统一参数精度评估', title: '调查方案评估', intro: '各题采用相同的选项数和 ε，比较人数与保护强度对预期精度的影响。',
    facts: [['每次预计人数', `${n(c.samples)} 人`], ['题目数量', n(c.questions)], ['每人累计开销 ε', String(p.total_epsilon)], ['计划采集次数', n(c.collections)]],
    body: section('方案配置与预期表现', table(['配置或指标', '数值'], [
      ['每题选项数', n(c.categories)], ['每题 ε', String(c.epsilon)], ['目标误差', `±${points(c.radius)}`],
      ['当前误差界', `±${points(p.per_question_radius[0], true)}`], ['达到目标所需人数', r.required_samples === null ? '超过 1,000 万人' : `${n(r.required_samples)} 人`],
    ])) + scope(PLAN_SCOPE), identity: [],
  };
}

const CSS = `
:root{color:#183a34;background:#f1f5f3;font-family:"Segoe UI","Microsoft YaHei",sans-serif;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;padding:32px 20px;font-size:14px;line-height:1.75}main{max-width:980px;margin:auto;background:#fff;border:1px solid #d7e4de;padding:42px 48px}
.brand{font-family:Bahnschrift,"Segoe UI",sans-serif;font-weight:600;letter-spacing:.03em;color:#126957}.kind{font-size:12px;color:#526d64;margin-top:24px}h1{font-size:28px;line-height:1.4;margin:8px 0 16px}h2{font-size:18px;line-height:1.6;margin:0 0 12px}p{margin:8px 0}
header{padding-bottom:22px;border-bottom:3px solid #126957}.intro{color:#526d64}.facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;padding:22px 0;margin:0;border-bottom:1px solid #d7e4de}.facts div{min-width:0}dt{font-size:12px;color:#526d64}dd{font-size:20px;font-weight:600;margin:4px 0 0;font-variant-numeric:tabular-nums}
section{padding:26px 0;border-bottom:1px solid #d7e4de}table{width:100%;border-collapse:collapse;table-layout:fixed;margin-top:16px}th{text-align:left;font-weight:600;background:#edf5f1}td,th{padding:12px 10px;border-bottom:1px solid #d7e4de;vertical-align:top}td{font-variant-numeric:tabular-nums}p,h1,h2,dd,td,th{overflow-wrap:anywhere}.caution{background:#fff7ea;border-left:3px solid #b5791f;padding:12px 16px}
.identity{margin-top:24px;font-size:12px;color:#526d64}.identity p{font-family:Consolas,"Microsoft YaHei",monospace}.hint,footer{font-size:12px;color:#526d64}footer{margin-top:20px}.hint{margin-bottom:18px;text-align:right}
@media screen and (max-width:620px){body{padding:14px 10px}main{padding:24px 18px}.facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}h1{font-size:24px}thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}table,tbody,tr,td{display:block;width:100%}tr{border-bottom:1px solid #a9beb3;padding:8px 0}td{border:0;padding:6px 0}td::before{content:attr(data-label);display:block;color:#526d64;font-size:12px}section{padding:22px 0}}
@page{size:A4;margin:16mm}@media print{:root{background:#fff;color:#000}body{padding:0;font-size:10pt}main{padding:0;max-width:none;border:0}.hint{display:none}h1{font-size:20pt}h2{font-size:13pt;break-after:avoid}header{border-color:#333}.facts{gap:12px}dd{font-size:14pt}th,td{padding:7px 6px}thead{display:table-header-group}tr,.facts,.identity{break-inside:avoid}section{padding:16px 0}.caution{border:1px solid #777;background:none}footer{font-size:9pt}}
`;

/** Render an existing result into a deterministic, standalone HTML document. */
export function renderReport(kind, report) {
  let snapshot;
  try {
    const encoded = JSON.stringify(report, (_key, value) => { if (typeof value === 'number' && !Number.isFinite(value)) fail(); return value; });
    expect(typeof encoded === 'string' && encoded.length <= 4000000);
    snapshot = JSON.parse(encoded);
    expect(snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot));
    const render = { survey: surveyReport, assessment: assessmentReport, statistics: statisticsReport, plan: planReport };
    expect(Object.hasOwn(render, kind));
    const doc = render[kind](snapshot);
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${escape(doc.title)} · ${escape(doc.type)} · MoonPrivacyKit</title><style>${CSS}</style></head>
<body><main><p class="hint">可离线查看；用浏览器“打印”保存为 PDF。</p><header><div class="brand">MoonPrivacyKit / 隐私工具箱</div><p class="kind">${escape(doc.type)}</p><h1>${escape(doc.title)}</h1><p class="intro">${escape(doc.intro)}</p></header>${metadata(doc.facts)}${doc.body}${doc.identity.length ? `<div class="identity">${doc.identity.map(([key, value]) => paragraph(`${key}：${value}`)).join('')}</div>` : ''}<footer>本文件按所提供的报告排版，不核验来源或签名。题目、选项和公开类别由使用者提供，转交前请复核其中是否包含个人信息。</footer></main></body></html>\n`;
  } catch { fail(); }
}
