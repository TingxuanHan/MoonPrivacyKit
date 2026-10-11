# 字段配置复用与统计衔接

处理列名和用途相同的数据时，可以保存每列的保留、删除或遮盖规则，再用于下一份文件。处理后若仍保留稳定的人员标识及需要的类别，便可在工作台直接继续统计，省去下载再上传的步骤。两种模板共用版本校验和预览方式，字段模板与统计模板各自保存对应设置，不混用类型。

## 从配置到报告

1. 在“文件脱敏”选择 UTF-8 CSV／JSON。为每列设置保留、删除或遮盖，至少处理一列。JSON 规则作用于顶层字段。
2. 展开“保存当前字段配置”，填写用途名称并导出。模板包含全部列名和处理规则，不含记录、文件路径、统计项目、预算或发布编号。
3. 下次展开“使用已保存的字段配置”导入。系统先核对全部列名；新增、缺少字段或模板格式错误时不应用。核对每列含义后点击“应用字段配置”，再“处理并预览”。应用不会直接执行处理，也不改变当前统计项目。
4. 检查预览及处理记录。需要统计时，展开“查看可用字段”，确认有稳定人员标识；点击“用此结果继续统计”。页面只传递处理后的内存副本，无需创建中间文件。
5. 在“隐私统计”沿用相关项目，选择人员标识及所需类别列。也可以应用兼容的统计模板。核对公开类别、贡献上限和本次 ε，再明确点击“生成报告”。只有发布时才向本机服务发送处理后的表格并核算预算。

导入新文件后，字段规则默认需要重新确认；已有模板会重新检查。模板中的“保留”是明确决定，新增列不会被旧模板静默放行。字段相同不代表含义相同，使用者仍需核对口径。JSON 按整份输入的字段集合检查，单条记录可以缺少要删除的字段；统计所需字段则必须在每条记录中存在并通过统计校验。

## 哪些字段可以继续统计

| 字段状态 | 衔接行为 |
| --- | --- |
| 明确保留，列名和值未改写 | 列入可选字段；人员标识、类别仍需通过统计校验 |
| 删除或遮盖 | 不提供为人员标识或类别列，即使遮盖结果是合法字符串 |
| CSV 公式文本化改变列名或任意一条值 | 整列排除，避免把改写后的身份或类别当作原值 |
| 公式文本化造成重复表头，或输出无法校验 | 禁止直接转入；回到字段规则检查 |
| 统计模板依赖已删除或改写的列 | 显示原因，禁止应用，保留当前设置 |

不能为了获得人数统计而将所有人员标识遮盖为同一个占位符，也不能使用行号替代自然人标识。若需要导出的明细必须删除标识，可分别生成最小化明细，并在可信环境中用原表进行统计；两项任务不要求共用同一份导出文件。CSV 公式文本化默认开启，不会为衔接自动关闭。

已转入的副本与后续编辑分开：修改字段规则会使脱敏预览失效，但不改变统计中已接收的副本，需要重新处理并转入。当前发布尚待确认且原输入仍在页面中时，禁止替换它；已完成发布则先点击“准备下一次发布”。刷新后可用原文件、原规则重新生成副本，以原设置和原编号重试；应先尝试恢复已保存报告。切换和模板操作均不重置预算。

## 模板协议

示例文件为 [`examples/redaction-template.json`](../examples/redaction-template.json)，配套虚构数据为 [`examples/redaction-table.csv`](../examples/redaction-table.csv)。

```json
{
  "schemaVersion": 1,
  "kind": "moonprivacykit/redaction-template",
  "name": "保留统计字段并移除联系方式",
  "settings": {
    "fields": [
      { "name": "person_id", "action": "keep" },
      { "name": "answer", "action": "keep" },
      { "name": "contact", "action": "remove" }
    ],
    "spreadsheetSafe": true
  }
}
```

- 所有字段均须显式填写，未知字段、重复 JSON 键和未知版本被拒绝；不能夹带原始数据或发布身份。
- 名称为 1 至 80 个文本单位的非空单行文字。规则数量为 1 至 512，每个列名非空、最多 256 个文本单位，不重复；操作只能是 `keep`、`remove`、`mask`，至少一项为删除或遮盖。
- `spreadsheetSafe` 必须为布尔值，对 CSV 有效，对 JSON 不改写内容。CSV 不能删除全部列；JSON 可输出空对象。
- 核心模板文本上限为 100,000 个文本单位，工作台模板文件上限 400 KB。数据文件要求有效 UTF-8，兼容 BOM，原有 4 MB 文件及核心行列限制仍适用。
- 模板名称和列名可能由用户写入敏感信息，导出前需复核。模板不自动识别敏感列，也不判断某列是否是真实、稳定的人员标识。

## 命令行

构建后，可先检查模板，再导出到新文件。`check-redaction-template` 返回兼容性及新增／缺失列名；不兼容时退出码为 1。两项操作都不需要统计账本。

```sh
node cli/main.mjs check-redaction-template csv examples/redaction-table.csv examples/redaction-template.json
node cli/main.mjs redact-template csv examples/redaction-table.csv processed.csv examples/redaction-template.json
```

处理同时生成 `processed.csv.audit.json`，仅记录处理数量。已有输出或原文件不会被覆盖。错误、审查结果及处理记录仅供可信数据持有者使用，不是差分隐私公开报告。

## 开发接口

浏览器与 Node.js 共用 `runtime/templates.mjs` 中的 `parseRedactionTemplate`、`createRedactionTemplate`、`checkRedactionTemplate`、`applyRedactionTemplate` 和 `prepareRedactionHandoff`。解析函数接收原始 JSON 文本，避免丢失重复键证据；返回对象递归冻结。衔接返回 `result`、`eligible_fields`、`excluded_fields`，处理结果含私有明细，只能在可信环境中使用。

Node.js 可通过一个调用重新校验来源、处理规则和统计字段，再由原账本发布：

```js
import { readFileSync } from 'node:fs';
import { publishRedactedRelease } from './runtime/table.mjs';

const report = publishRedactedRelease(
  'private-data/releases.sqlite',
  'csv',
  readFileSync('examples/redaction-table.csv', 'utf8'),
  readFileSync('examples/redaction-template.json', 'utf8'),
  readFileSync('examples/statistics-histogram-template.json', 'utf8'),
  'survey-round-1',
);
```

账本须事先建立，调用方必须显式提供发布编号。失败后重试使用同一编号；等价的原表统计和字段处理后统计可复用原报告，改变映射后的记录或统计设置则产生冲突。该接口会从原输入和规则重新生成衔接信息，不信任外部声称某列未改写的元信息。

MoonBit 对应接口为 `parse_redaction_template`、`check_redaction_template`、`apply_redaction_template`、`prepare_redaction_handoff`，提供相应 JSON 边界操作。CSV 衔接按列比较导出前后的名称与全部值，保留行序；JSON 保留未选中的值，并拒绝输入中的重复键，包括将被删除的嵌套内容。

## 范围

这是“字段处理 → 隐私统计”的受限衔接，尚不是通用流程引擎。工作台中的处理来源仅在当前页面内存中保留；下载文件再单独导入统计时，无法从文件推断其历史处理规则，使用者须自行确认人员标识与统计含义。字段删除、遮盖及兼容性检查都不等于匿名化或差分隐私；最终统计保护仍依赖可信持有者、正确的保护单位及累计发布预算。
