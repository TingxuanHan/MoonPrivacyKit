# 使用说明

## 工作台

运行 `npm run build` 后运行 `npm start`，打开 http://127.0.0.1:4173。需要 MoonBit 稳定版工具链和 Node.js 22.13.0+。Windows 的 `start.cmd` 可以完成构建、启动及打开页面；如 MoonBit 安装在自定义目录，可先设置 `MOON_HOME`。

### 隐私问卷

1. 发起者在“创建问卷”设置问题、每行一个选项和每题 ε，导出问卷配置。首版只支持必答、单选、有限选项；不收集姓名和自由文本。
2. 将配置文件交给参与者。参与者在可信工作台中打开“填写问卷”，载入配置并填写；点击“生成受保护回答”后，页面清除原始选项，提供响应文件下载。
3. 参与者把响应文件交给发起者。文件传递渠道可能暴露参与者身份，应按调查用途选择合适的渠道。
4. 发起者在“汇总结果”选择原问卷与多个响应文件，查看校正比例、95% 同时置信范围和小样本提示，导出报告。

重复下载同一次生成的响应会得到相同文件。重传时使用该文件；重新填写或重新生成会增加隐私开销。配置或选项顺序改变后指纹会变化，旧响应不能与新配置混用。去重只识别同一响应编号，不能证明每个自然人只参加了一次。

### 文件脱敏

每个字段可选保留、删除、遮盖。至少处理一个字段；CSV 至少保留一列。遮盖将整项替换为 `[REDACTED]`，不会保留手机号尾号等部分内容。

- CSV：UTF-8、逗号分隔、必须有唯一且非空的表头。支持 LF／CRLF、双引号转义与带换行的引用字段。暂不支持 `.xlsx`、分号分隔或无表头文件。
- JSON：顶层对象或对象数组，按顶层字段名称精确选择。部分记录缺少选中字段是允许的；处理记录只计实际存在的值。选中遮盖的嵌套对象整体替换，未选中的嵌套内容原样保留。
- 公式文本化：默认在可能被表格软件当成公式的单元格前加单引号，负数也可能成为文本。可在工作台关闭，然后自行审查表格软件中的打开方式。
- 复核：规则或文件修改后，旧预览与下载按钮失效，需要重新处理。处理记录只有数量，不包含原值。

首版每个文件上限 4 MB；核心文本处理上限 200 万文本单位、10 万记录和 512 个不同字段。工作台一次汇总最多 10,000 个响应文件、合计 8 MB。超过范围时应缩小输入；当前没有流式处理。

### 效果评估

输入预计人数、选项数、题目数量、ε 和期望误差。工作台展示每次采集的精度及每人跨多次采集的累计开销，不把多次采集自动当成更多独立参与者。当前页面假设每题选项数、ε 相同，MoonBit 的 `plan_survey` 接口支持各题使用不同配置。

### 隐私统计

1. 选择已有统计项目，或填写项目名称和总预算创建项目。可能涉及同一批人的发布应沿用同一项目，不能通过更换文件或新建项目重置预算。
2. 选择 CSV／JSON 文件，或载入虚构统计示例。页面只展示列名，不预览个人记录。选择稳定的人员标识列，再设置计数或类别分布；类别分布另需类别列和事先确定的公开类别。
3. 设置每人贡献上限与本次 ε，查看不消耗预算的误差预估。核对后点击“生成报告”，表格发送到本机服务完成发布。
4. 查看受保护结果和误差范围，下载报告。再次下载、从“历史报告”查看或恢复同一次结果均不重复扣减预算；“准备下一次发布”才开启新的发布操作。

请求中断时保留原编号，优先“恢复已保存报告”，也可“重试本次发布”。刷新页面后只保留恢复编号，不保留表格；报告尚未找到时，重新选择原文件和原设置再重试。详细的文件位置、恢复边界与保护条件见[本地统计工作台](LOCAL_WORKBENCH.md)。

## 命令行

在仓库根目录构建后运行。输出路径必须是新文件；程序拒绝覆盖已有文件。

```sh
node cli/main.mjs init-survey my-survey.json
node cli/main.mjs protect my-survey.json response-1.json
node cli/main.mjs aggregate my-survey.json report.json response-1.json
node cli/main.mjs redact csv examples/sample.csv clean.csv examples/policy.json
node cli/main.mjs redact json examples/sample.json clean.json examples/policy.json
node cli/main.mjs plan examples/plan.json plan-report.json
```

`protect` 在终端逐题询问。自动化管道可向其标准输入传入从 0 开始的选项下标数组；不要把真实回答放在命令行参数、共享日志或 Git 仓库中。脱敏会同时写入 `<输出文件>.audit.json`。使用 `private-data/` 和 `reports/` 目录可避免默认被 Git 跟踪，但仍需在提交前检查。

中心化统计另提供 `init-ledger`、`publish`、`publish-table`、`ledger-status` 和 `export-release` 命令，可完成创建预算、发布、查看余额与重试导出。`publish` 接收约定的 JSON 请求，`publish-table` 从 CSV／JSON 表中映射人员标识和类别字段。完整示例见[发布预算与结果复用](RELEASE_LEDGER.md)与[真实表格统计](TABLE_STATISTICS.md)。

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

浏览器需要可信的 HTTPS 或 localhost 安全上下文。MoonBit 调用方可直接使用 `make_mechanism`、`estimate`、`plan_survey`、`parse_survey`、`aggregate_responses`、`redact_csv` 和 `redact_json`。底层 `randomize` 的随机样本由调用方负责，接真实数据前必须满足独立、均匀、不可预测的要求。

## 开发约定

新增功能同步更新来源、保护范围、测试与示例；完成一个独立可验证的目标后提交。默认执行 `npm run verify`；影响界面或文件流程时执行 `npm run test:ui`。不使用空提交、重复提交或拆分无意义改动增加提交次数。
