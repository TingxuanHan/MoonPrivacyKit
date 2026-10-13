import { callCore, validateSurvey, surveyFingerprint } from './client.mjs';

function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export function parseSurveyTemplate(input) {
  if (typeof input !== 'string') throw new Error('Survey templates must be JSON text.');
  return freeze(callCore({ op: 'parseSurveyTemplate', input: input.replace(/^\uFEFF/, '') }));
}

export function createSurveyTemplate(name, survey, plannedCollections = 1) {
  const valid = validateSurvey(survey);
  return parseSurveyTemplate(JSON.stringify({
    schemaVersion: 1, kind: 'moonprivacykit/survey-template', name,
    settings: { title: valid.title, questions: valid.questions, plannedCollections },
  }));
}

export function surveyFromTemplate(template) {
  // Each application starts a new questionnaire. Reusing an exported config
  // retains its identity; creating another instance must not mix old responses.
  if (!globalThis.crypto?.randomUUID) throw new Error('A secure context is required.');
  return freeze(callCore({ op: 'surveyFromTemplate', template: JSON.stringify(template), survey_id: `survey-${crypto.randomUUID()}` }));
}

export function parseSurvey(input) {
  if (typeof input !== 'string') throw new Error('Survey configuration must be JSON text.');
  return freeze(callCore({ op: 'parseSurvey', input: input.replace(/^\uFEFF/, '') }));
}

export function surveyBudget(survey, collections = 1) {
  return freeze(callCore({ op: 'surveyBudget', survey, collections }));
}

export const formatEpsilon = value => Number(value.toPrecision(12)).toString();

export async function participantGuide(survey, plannedCollections = 1) {
  // Take a validated snapshot before the asynchronous fingerprint operation.
  const valid = validateSurvey(survey);
  const budget = surveyBudget(valid, plannedCollections);
  const fingerprint = await surveyFingerprint(valid);
  return [
    `问卷参与说明：${valid.title}`,
    '',
    `共 ${budget.questions} 道单选题。每人完整填写一次的隐私开销上界 ε 约为 ${formatEpsilon(budget.single_epsilon)}。`,
    `若同一人按这份配置分别生成并提交 ${budget.collections} 次回答，累计开销上界 ε 约为 ${formatEpsilon(budget.total_epsilon)}。`,
    '采集次数是组织者的计划，不是系统已执行的限制；参与其他调查的相关开销也需要另行累计。ε 越小通常保护越强，统计误差也越大。',
    '',
    '如何参与',
    '1. 从组织者处取得问卷配置，使用可信的 MoonPrivacyKit 本地工作台，在“填写问卷”中载入。',
    '2. 复核题目与保护参数，再逐题选择并生成受保护回答。请勿在问卷文件、文件名或附加消息中添加个人资料。',
    '3. 下载回答文件，按组织者说明交回。需要重传时使用同一文件；重复下载不会重新随机化。不要为了重传而重新填写。',
    '',
    '保护范围',
    '工作台在本地随机化选择，导出的回答不包含原始选择。组织者汇总后估计群体比例，不能将随机化后的选项当成个人真实回答。',
    '该机制不保证单次选项一定改变，也不保证完全匿名。传送文件使用的账号、文件来源或其他已知信息仍可能暴露参与身份。',
    '本地工具不识别真实参与者，也不阻止同一人重新生成回答。重新生成并提交会增加开销；新建问卷或换模板不能清除过去的开销。',
    '小样本的误差可能很大；群体估计不应用于判断某个参与者的真实选择。',
    '',
    '配置核对',
    `问卷编号：${valid.id}`,
    `配置指纹：${fingerprint}`,
    '说明只适用于上述配置。标题、问题、选项、顺序或 ε 改动后，须重新导出配置和说明；汇总使用填写时的原配置。',
    '组织者发送前应另外说明调查目的、收集渠道、结果用途和保留期限。配置指纹用于核对一致性，不证明组织者身份。',
    '',
  ].join('\n');
}

const question = (id, title, options) => ({ id, title, options, epsilon: 1 });
function preset(id, name, description, questions) {
  return freeze({ id, name, description, template: parseSurveyTemplate(JSON.stringify({
    schemaVersion: 1, kind: 'moonprivacykit/survey-template', name,
    settings: { title: `${name}问卷`, questions, plannedCollections: 1 },
  })) });
}

export const surveyPresets = freeze([
  preset('team', '团队反馈', '了解协作体验与优先改善事项，不收集姓名或岗位。', [
    question('satisfaction', '你对目前的协作方式满意吗？', ['满意', '不满意']),
    question('priority', '你最希望优先改善什么？', ['沟通', '工具', '安排']),
  ]),
  preset('course', '课程反馈', '了解课程节奏与支持需求，不收集学号或成绩。', [
    question('pace', '你觉得目前的课程节奏如何？', ['偏快', '合适', '偏慢']),
    question('support', '你最需要哪种学习支持？', ['更多示例', '练习讲解', '答疑时间', '暂无需要']),
  ]),
  preset('service', '服务体验', '了解使用体验与改进方向，不收集账号或订单信息。', [
    question('experience', '你对本次服务的整体体验满意吗？', ['满意', '一般', '不满意']),
    question('improvement', '你最希望改善哪个方面？', ['等待时间', '操作流程', '问题解决', '暂无建议']),
  ]),
]);
