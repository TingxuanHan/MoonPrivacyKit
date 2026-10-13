# 可读报告导出

把已有结果保存为一份可离线打开的 HTML 文档，适用于查看、交流和打印。问卷汇总、当前问卷逐题评估、自定义方案评估、中心化隐私统计采用相同的下载方式，原有 JSON 导出继续可用。

## 在工作台使用

1. 完成问卷汇总或效果评估；对于隐私统计，也可以从历史报告或中断恢复中打开已有结果。
2. 在结果旁点击“下载可读报告（HTML）”。文件包含结果、配置参数、误差范围和保护条件。
3. 用浏览器打开下载文件即可离线阅读。需要打印或保存为 PDF 时，使用浏览器的打印功能；文件本身不执行打印脚本。
4. 需要程序处理或完整数值时，下载相邻的 JSON。转交前复核题目、选项和公开类别中是否包含个人信息。

两种格式来自同一份结果快照。再次下载不重新随机化，不消耗发布预算；统计项目、待确认编号和历史结果保持原样。修改源问卷或评估条件后，旧评估及两种下载入口一同失效，需要重新评估。当前不保存浏览器中的评估历史，刷新前应先下载。

## 报告包括什么

| 类型 | 结果及说明 |
| --- | --- |
| 问卷汇总 | 有效回答与重复文件数量、各选项估计比例及同时误差范围、每题 ε、单次开销、配置指纹；没有个人回答或响应编号 |
| 逐题精度评估 | 每次预计人数、目标误差、计划次数、每题误差与所需人数；明确区分无信号、超限和达标 |
| 统一参数评估 | 选项数、题数、每题 ε、人数、重复次数、目标误差和所需人数 |
| 隐私统计 | 已保存的受保护计数、预设类别、每人贡献限制、本次 ε、误差范围及结果编号；不包含项目名、源表、人员标识或账本余额 |

问卷比例显示至两位小数；置信区间与误差上界向外取整，避免因排版缩小范围。达标状态仍以原始数值计算。各选项比例因裁剪与显示精度，合计可能不等于 100%。JSON 保留原始精度。报告说明是针对实际汇总还是预计方案，规划结果不能当作已经收集的数据。

统计报告中的 ε 是该次发布开销，不是项目余额。相同结果可重复导出；要重新查询，仍需经过账本核算。恢复报告时继续使用原请求编号，格式转换不创建发布编号。

## 命令行

在仓库根目录构建后执行。输出路径必须不存在，父目录须已存在。

```sh
node cli/main.mjs export-report survey reports/survey-report.json reports/survey-report.html
node cli/main.mjs export-report assessment reports/assessment.json reports/assessment.html
node cli/main.mjs export-report statistics reports/statistics.json reports/statistics.html
node cli/main.mjs plan examples/plan.json reports/plan.json
node cli/main.mjs export-report plan reports/plan.json reports/plan.html
```

`export-report` 只读取已有报告，不读取账本或源表，不覆盖原文件。输入须为有效 UTF-8 JSON，文件不超过 4 MB，类型参数须与结果一致。未知版本、夹带字段、非有限数值、缺少字段或部分数值／维度不一致时拒绝转换，不输出半成品，也不回显报告内容。

## SDK 与格式兼容

```js
import { renderReport } from './runtime/report-export.mjs';

const html = renderReport('assessment', assessmentReport);
// 将 html 作为 text/html 保存；不重新调用统计或回答生成接口。
```

转换器是独立的 JavaScript 展示模块，无随机数、网络和账本依赖。MoonBit 仍负责隐私机制、统计与评估。

新版 MoonBit `SurveyReport` 在原有字段之外增加 `schema_version`、`mechanism`、`survey_title`、`survey_fingerprint` 和 `single_epsilon`，每个 `QuestionResult` 增加 `epsilon`；原有计数和比例字段保持不变。JavaScript 汇总先保存经校验的问卷快照，再计算指纹，异步等待期间修改原对象不会改变结果所对应的配置。直接构造这些 MoonBit 结构体的调用方需补齐新字段。

未带版本的旧版问卷汇总仍可转换，但报告明确提示未保存标题、各题 ε 与指纹，不猜测或补造参数。旧版命令行 `plan` 输出未保存 `configuration` 时，需用原公开方案重新评估，再转换报告；新输出保留原字段并附带配置。现有中心化统计 JSON 无需迁移。

## 范围与限制

HTML 只输出经过校验的展示字段，不嵌入原始 JSON、脚本、远程字体或图片；所有题目、选项和类别按文本转义。文件内的内容安全策略进一步限制外部加载和活动内容。它不是签名报告，格式检查不证明来源或真实性，也不能验证数据持有方实际执行了隐私机制。使用者填写在标题和公开类别中的个人信息不会被自动识别或移除。

当前提供离线 HTML 与打印样式，不直接生成 PDF、Word，不提供在线报告托管或访问权限管理。打印分页与字体由浏览器负责。参数、置信范围和保护边界见[隐私模型](PRIVACY_MODEL.md)、[逐题评估](SURVEY_ASSESSMENT.md)与[中心化统计](CENTRAL_PRIVACY.md)。
