# 问卷模板与参与说明

团队反馈、课程反馈和服务体验共用同一套创建、填写与汇总流程。模板提供可编辑的起步题目，帮助发起者复用方案；题目与 ε 仍须按调查目的、样本量和精度要求复核，预设值不是适合所有场景的建议。

## 工作台操作

1. 在“隐私问卷 → 创建问卷”展开“从场景模板开始”，选择用途，或导入之前保存的模板文件。
2. 预览全部题目、选项、每题 ε 和计划开销。“替换为此模板”才会覆盖当前草稿并创建新问卷；取消或导入失败均保留当前内容。
3. 编辑问题，设置计划让同一人填写的次数。页面按不同题目的 ε 求和，再按次数计算组合上界。例如两题分别为 0.25 和 0.5，完整填写一次为 0.75，分别生成并提交三次为 2.25。
4. 导出问卷配置并下载参与说明。发送前补充调查目的、收集渠道、结果用途和保留期限。参与说明中的编号、指纹和开销针对导出时的配置；改动问卷后须重新导出两个文件。
5. 如需复用方案，展开“保存为可复用模板”并导出。以后应用该模板会建立另一份问卷，不能代替原配置汇总旧回答。

参与者在“填写问卷”载入配置，先查看单次和重复提交的开销说明，再生成受保护回答。已有选择或回答时，选择另一个文件只展示更换预览；此时原回答仍可下载。明确确认后才清除旧状态，取消后继续当前问卷。生成期间不能更换文件。工具不自动上传问卷或回答。

重新下载同一份受保护回答不会重新采样。已发送回答需要重传时，应复用原文件；重新填写并提交会增加开销。问卷和回答仅保存在页面内存中，刷新前须下载，不能承诺刷新后恢复。

## 模板与问卷配置的区别

| 文件 | 用途 | 包含 | 是否可用于汇总 |
| --- | --- | --- | --- |
| 问卷模板 | 复用题目与计划 | 名称、标题、题目编号、选项、每题 ε、计划次数 | 否，须先建立新问卷 |
| 问卷配置 | 分发同一份调查 | 版本 1 问卷协议及该问卷编号 | 是，必须与回答配置指纹一致 |
| 参与说明 | 解释步骤、开销与保护边界 | 配置编号及指纹、次数假设、说明文本 | 否，不是问卷或参与账本 |

题目编号在编辑中保持稳定。问卷编号、标题、题目内容、选项顺序或 ε 改变都会改变配置指纹，旧回答只能用填写时的原配置汇总。只调整模板名称或计划次数不会修改问卷配置内容；次数是独立的计划信息，不扩展版本 1 的回答协议。

模板协议如下，严格拒绝额外字段、重复 JSON 键（包括转义后重复）、未知版本和非法参数：

```json
{
  "schemaVersion": 1,
  "kind": "moonprivacykit/survey-template",
  "name": "团队反馈",
  "settings": {
    "title": "团队反馈问卷",
    "questions": [
      {
        "id": "satisfaction",
        "title": "你对目前的协作方式满意吗？",
        "options": ["满意", "不满意"],
        "epsilon": 1
      }
    ],
    "plannedCollections": 1
  }
}
```

模板最多 100,000 个文本单位、20 道题；计划次数为 1 至 10,000 的整数。名称是 1 至 80 个字符的单行文本，标题、问题和选项不允许换行或首尾空白，保证导入后可在按行编辑的界面中完整复用。已有问卷协议的核心上限仍为 100 题。模板不设调查身份、回答、人员信息或账本状态字段；名称和题目也不应夹带个人资料。

## SDK 与命令行

构建后可在 Node.js 或可信浏览器中使用：

```js
import {
  surveyPresets, surveyFromTemplate, createSurveyTemplate,
  parseSurveyTemplate, parseSurvey, surveyBudget, participantGuide,
} from './runtime/survey-templates.mjs';

const survey = surveyFromTemplate(surveyPresets[0].template);
const reusable = createSurveyTemplate('我的团队反馈', survey, 3);
const roundTrip = parseSurveyTemplate(JSON.stringify(reusable));
const budget = surveyBudget(survey, roundTrip.settings.plannedCollections);
const instructions = await participantGuide(survey, 3);
const original = parseSurvey(JSON.stringify(survey));
```

`surveyFromTemplate` 每次产生新的随机问卷编号。若只是重发配置，保存并复用原 `survey`，不要再次创建。解析、开销计算和参与说明不生成回答、不采样，也不操作中心化发布账本。返回的配置对象递归冻结；说明在异步指纹计算前读取校验后的配置副本。

MoonBit 提供 `parse_survey_template`、`survey_from_template` 和 `survey_budget`。原始 JSON 文本应交给解析接口，以便在解析丢失信息前发现重复键；已经转换为对象的输入无法恢复被覆盖的键。

命令行使用工作台导出的模板，输出路径必须不存在：

```sh
node cli/main.mjs survey-from-template saved-template.json new-survey.json
node cli/main.mjs survey-guide new-survey.json 3 participation.txt
node cli/main.mjs protect new-survey.json response.json
node cli/main.mjs aggregate new-survey.json report.json response.json
```

## 保护边界

计划次数不代表系统已经限制每人只参加这些次数。重复参与、换设备、另建问卷或使用其他工具的相关开销仍需组织者和参与者累计考虑。问卷模板不重置隐私开销，也不迁移中心化统计账本。

随机响应有可能输出与原选择相同的选项；保护来自随机化机制，不能承诺每个结果都被改变。它保护回答内容，不隐藏参加调查的事实或文件传送身份，依赖可信页面和安全随机源。配置指纹只能核对内容一致性，不认证发起者。小样本可能无法得到有用的群体统计。

目前不提供在线问卷托管、身份去重、跨设备参与记录、自动合并不同问卷或自动裁定安全参数。详情见[保护范围](PRIVACY_MODEL.md)和[验证记录](VALIDATION.md)。
