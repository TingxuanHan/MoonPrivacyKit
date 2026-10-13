# 使用说明

## 工作台

运行 `npm run build` 后运行 `npm start`，打开 http://127.0.0.1:4173。需要 MoonBit `moon 0.1.20261012`／`moonc v0.10.15` 或更新版本，以及 Node.js 22.13.0+；先用 `moon version --all` 确认版本。Windows 的 `start.cmd` 可以完成构建、启动及打开页面；如 MoonBit 安装在自定义目录，可先设置 `MOON_HOME`。旧版本出现 `Int32` 未定义时须更新工具链，已有问卷、字段模板和统计账本无需迁移。

### 隐私问卷

1. 发起者在“创建问卷”直接编辑，或展开“从场景模板开始”，选择团队反馈、课程反馈、服务体验或已保存模板，预览后明确应用。复核题目、每行一个选项、每题 ε 与计划次数，导出问卷配置和参与说明。首版只支持必答、单选、有限选项；不收集姓名和自由文本。
2. 补充调查目的、收集渠道、结果用途与保留期限，把配置和说明一起交给参与者。参与者在可信工作台中打开“填写问卷”，复核开销后填写；点击“生成受保护回答”后，页面清除原始选项，提供响应文件下载。
3. 参与者把响应文件交给发起者。文件传递渠道可能暴露参与者身份，应按调查用途选择合适的渠道。
4. 发起者在“汇总结果”选择原问卷与多个响应文件，查看校正比例、95% 同时置信范围和小样本提示，导出 JSON 或可离线阅读的 HTML 报告。

重复下载同一次生成的响应会得到相同文件。重传时使用该文件；重新填写或重新生成会增加隐私开销。配置或选项顺序改变后指纹会变化，旧响应不能与新配置混用。去重只识别同一响应编号，不能证明每个自然人只参加了一次。

模板保存题目、参数与计划次数，每次应用都会创建新问卷；继续收集已有问卷时，直接发送原配置。更换填写文件不会立即清除已有选择或回答，只有明确确认后才替换；文件无效或取消替换时保留当前状态。刷新仍会清除浏览器中的问卷与回答，须先下载。计划次数只用于组合开销估算，不限制实际参与；详见[问卷模板与参与说明](SURVEY_TEMPLATES.md)。

### 文件脱敏

每个字段可选保留、删除、遮盖、年龄分段或日期降精度。至少处理一个字段；CSV 至少保留一列。遮盖将整项替换为 `[REDACTED]`，不会保留手机号尾号等部分内容。年龄分段接受 0 至 130 的整数，日期接受有效的 `YYYY-MM-DD`，可保留到月或年；选择规则后显示对应参数。可点击“试用年龄与日期处理”查看示例。

- CSV：UTF-8、逗号分隔、必须有唯一且非空的表头。支持 LF／CRLF、双引号转义与带换行的引用字段。暂不支持 `.xlsx`、分号分隔或无表头文件。
- JSON：顶层对象或对象数组，按顶层字段名称精确选择。删除／遮盖字段允许部分记录缺失，处理记录只计实际存在的值；泛化字段必须每条记录都有有效值。选中遮盖的嵌套对象整体替换，未选中的嵌套内容原样保留。
- 公式文本化：默认在可能被表格软件当成公式的单元格前加单引号，负数也可能成为文本。可在工作台关闭，然后自行审查表格软件中的打开方式。
- 复核：规则或文件修改后，旧预览与下载按钮失效，需要重新处理。处理记录只有数量，不包含原值。

首版每个文件上限 4 MB；核心文本处理上限 200 万文本单位、10 万记录和 512 个不同字段。工作台一次汇总最多 10,000 个响应文件、合计 8 MB。超过范围时应缩小输入；当前没有流式处理。

字段规则可导出为模板，下次检查列名及泛化值后应用。模板必须覆盖全部列名；新增或缺少字段时先复核。工作台字段名最多 256 个文本单位，JSON 输入中的重复键被拒绝。处理结果可直接“用此结果继续统计”：人员标识须保持原样，年龄段和月份／年份仅可作类别，转入不发布、不重置预算。操作步骤及边界见[字段配置与统计衔接](FIELD_WORKFLOWS.md)和[年龄、日期处理](FIELD_GENERALIZATION.md)。

### 效果评估

在“创建问卷”的“发放前检查”区域点击“评估当前问卷”，或在“效果评估”切换到“当前问卷”。题目、选项数、每题 ε 与计划采集次数会自动载入；补充每次预计人数和目标误差后，查看逐题误差条、达标状态及所需人数，导出评估结果。误差为百分点，例如 5 表示 ±5 个百分点。

修改问卷或原采集计划会使旧评估失效，须重新载入后计算。评估页可单独修改采集次数比较方案，不回写问卷计划。“自定义方案”保留每题选项数、ε 相同的快速比较方式。重复采集只累加每人的计划开销，不增加每次独立参与者人数；评估不生成回答或扣减统计账本预算。完整说明见[逐题精度评估](SURVEY_ASSESSMENT.md)。

### 隐私统计

1. 选择已有统计项目，或填写项目名称和总预算创建项目。可能涉及同一批人的发布应沿用同一项目，不能通过更换文件或新建项目重置预算。
2. 选择 CSV／JSON 文件，或载入虚构统计示例。页面只展示列名，不预览个人记录。选择稳定的人员标识列，再设置计数或类别分布；类别分布另需类别列和事先确定的公开类别。
3. 设置每人贡献上限与本次 ε，查看不消耗预算的误差预估。核对后点击“生成报告”，表格发送到本机服务完成发布。
4. 查看受保护结果和误差范围，下载报告。再次下载、从“历史报告”查看或恢复同一次结果均不重复扣减预算；“准备下一次发布”才开启新的发布操作。

请求中断时保留原编号，优先“恢复已保存报告”，也可“重试本次发布”。刷新页面后只保留恢复编号，不保留表格；报告尚未找到时，重新选择原文件和原设置再重试。详细的文件位置、恢复边界与保护条件见[本地统计工作台](LOCAL_WORKBENCH.md)。

重复使用相同统计口径时，可导出当前配置模板，下次载入兼容文件后导入、预览并应用。支持人数统计和满意度分布起步模板；导入、检查、应用和导出均不消耗预算。模板不保存原始数据或账本身份，详见[统计配置模板](STATISTICS_TEMPLATES.md)。

## 命令行

问卷汇总、两种精度评估及隐私统计结果旁均提供“下载可读报告（HTML）”。用浏览器打开后可打印或保存为 PDF；报告包括对应参数、误差范围和保护条件。统计历史也能导出同一结果，不重新采样或扣减预算，详见[可读报告导出](READABLE_REPORTS.md)。

在仓库根目录构建后运行。输出路径必须是新文件；程序拒绝覆盖已有文件。

```sh
node cli/main.mjs init-survey my-survey.json
node cli/main.mjs survey-guide my-survey.json 1 participation.txt
node cli/main.mjs assess-survey my-survey.json 1000 5 1 assessment.json
node cli/main.mjs protect my-survey.json response-1.json
node cli/main.mjs aggregate my-survey.json report.json response-1.json
node cli/main.mjs redact csv examples/sample.csv clean.csv examples/policy.json
node cli/main.mjs redact json examples/sample.json clean.json examples/policy.json
node cli/main.mjs check-redaction-template csv examples/redaction-table.csv examples/redaction-template.json
node cli/main.mjs redact-template csv examples/redaction-table.csv processed.csv examples/redaction-template.json
node cli/main.mjs plan examples/plan.json plan-report.json
node cli/main.mjs export-report plan plan-report.json plan-report.html
```

`protect` 在终端逐题询问。自动化管道可向其标准输入传入从 0 开始的选项下标数组；不要把真实回答放在命令行参数、共享日志或 Git 仓库中。脱敏会同时写入 `<输出文件>.audit.json`。使用 `private-data/` 和 `reports/` 目录可避免默认被 Git 跟踪，但仍需在提交前检查。

工作台导出的问卷模板可用 `survey-from-template <模板.json> <新问卷.json>` 创建新配置，再用 `survey-guide <问卷.json> <计划采集次数> <新说明.txt>` 导出对应参与说明。两项命令拒绝覆盖已有文件；模板不会保留原问卷编号。

中心化统计另提供 `init-ledger`、`publish`、`publish-table`、`ledger-status` 和 `export-release` 命令，可完成创建预算、发布、查看余额与重试导出。`publish` 接收约定的 JSON 请求，`publish-table` 从 CSV／JSON 表中映射人员标识和类别字段。完整示例见[发布预算与结果复用](RELEASE_LEDGER.md)与[真实表格统计](TABLE_STATISTICS.md)。

工作台导出的模板可通过 `check-template <csv|json> <原文件> <模板.json>` 检查兼容性，再通过 `publish-template <csv|json> <账本> <原文件> <模板.json> <请求编号> <新报告>` 发布。仍需显式指定受控账本和稳定请求编号，重试不更换编号。

## SDK

### 问卷与字段处理接口

```js
import { protectResponse, aggregateResponses, callCore } from './runtime/client.mjs';

const response = await protectResponse(survey, [0, 2]);
// 重试复用 response；不要重新调用 protectResponse。
const report = await aggregateResponses(survey, [response]);
const cleaned = callCore({
  op: 'redact', format: 'json', input: JSON.stringify(records),
  policy: { remove: ['name'], mask: ['email'] }, spreadsheet_safe: true,
});
```

浏览器需要可信的 HTTPS 或 localhost 安全上下文。MoonBit 调用方可直接使用 `make_mechanism`、`estimate`、`plan_survey`、`assess_survey`、`parse_survey`、`aggregate_responses`、`redact_csv` 和 `redact_json`。逐题评估的 JavaScript 接口为 `runtime/survey-assessment.mjs` 中的 `assessSurvey`。底层 `randomize` 的随机样本由调用方负责，接真实数据前必须满足独立、均匀、不可预测的要求。

## 开发约定

新增功能同步更新来源、保护范围、测试与示例；完成一个独立可验证的目标后提交。默认执行 `npm run verify`；影响界面或文件流程时执行 `npm run test:ui`。不使用空提交、重复提交或拆分无意义改动增加提交次数。
