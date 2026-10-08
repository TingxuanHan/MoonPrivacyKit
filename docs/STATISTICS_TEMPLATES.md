# 保存和复用统计配置

统计模板用于重复开展口径相同的分析。例如，每月收到列名相同的调查数据时，可以复用人员标识列、类别列、公开类别、贡献上限和单次 ε，不必重新逐项填写。模板可在 CSV 和 JSON 之间使用，也可从工作台带到命令行。

模板只描述如何统计，不包含原始记录、文件路径、项目或账本身份、请求编号、总预算或已用预算。导入、检查和应用模板不会发布结果，也不会扣减或重置预算。重复分析同一批人仍需沿用相关账本，不能把复制模板当作新的隐私额度。

## 在工作台使用

1. 进入“隐私统计”，选择已有项目和预算范围。在表格设置区展开“使用统计配置模板”，选择起步模板，或导入之前保存的 JSON 文件。
2. 选择本次 CSV／JSON 文件。预览显示统计口径、字段、每人上限和 ε；类别分布可展开查看全部公开类别。选择模板不会立即覆盖当前表单。
3. 工作台在浏览器内检查所需列是否存在，并校验每条记录的人员标识、字段类型和类别值。缺失字段或记录不兼容时禁止应用，显示调整提示，保留原设置。
4. 点击“应用此模板”，核对列含义和人员标识，再按通常流程发布。应用不会推断列名、替换未知类别、转换标识类型或修改项目预算。
5. 在“保存当前统计配置”中命名并导出模板；报告生成后也可“导出本次配置”。下次选择新文件并导入模板即可复用。刷新后从历史恢复的报告不含字段映射，不能据此反推原模板。

提供“参与人数统计”和“满意度类别分布”两个起步模板，与 `examples/table.csv`、`examples/table.json` 的虚构字段匹配。模板中的参数用于演示流程，不代表适合任意数据规模或发布要求。

模板名称、字段名和公开类别会保存在导出的文件中，使用者应避免在这些位置填写个人信息。模板仅在当前页面内存中保留，明确导出后才保存文件；不复制数据集，也不自动写入浏览器存储。

## 格式与版本

```json
{
  "schemaVersion": 1,
  "kind": "moonprivacykit/statistics-template",
  "name": "满意度类别分布",
  "settings": {
    "query": "histogram",
    "unitField": "person_id",
    "categoryField": "answer",
    "categories": ["满意", "一般", "不满意"],
    "epsilon": "0.3",
    "maxContributions": 1
  }
}
```

- `schemaVersion` 固定为数字 `1`，`kind` 固定为上面的字符串。未知版本、未知字段、重复 JSON 键和错误类型被拒绝，包括经过转义后重复的键。不能直接把统计报告、问卷或带 `scope`／`requestId` 的发布请求当作模板。
- `name` 为 1 至 80 个文本单位的非空单行名称，仅用于识别模板，不影响统计结果或重试身份。
- `query` 为 `count` 或 `histogram`。计数模板必须省略 `categoryField`、`categories`；类别分布必须提供它们。
- `unitField`、`categoryField` 精确匹配顶层字段名，最多 256 个文本单位。模板不指定文件格式，相同语义和列名可在 CSV／JSON 之间复用。
- `categories` 为 1 至 256 个不重复、非空、单行字符串，每个最多 128 个文本单位。保留顺序及首尾空格，不自动修剪或合并。类别须独立于私有数据预先确定；本版模板不接受带换行的类别，避免与工作台逐行编辑方式产生歧义。
- `epsilon` 是 0.01 至 8 的十进制字符串，最多六位小数；`maxContributions` 是 1 至 32 的整数。所有设置显式填写，不依赖隐式默认值。
- 核心限制模板文本为 100,000 个文本单位；工作台同时限制文件不超过 400 KB，并要求有效 UTF-8。宿主接口支持去除 UTF-8 BOM。

解析、规则和兼容性检查由 MoonBit 核心实现，浏览器和 Node.js 使用同一编译产物。兼容性通过表示字段和当前记录符合约定，不能证明自然人标识真实唯一、公开类别来源合适或 ε 选择合理。检查结果、错误及缺失字段仅供可信数据持有者使用，不是受差分隐私保护的公开统计报告。

## 命令行复用

先构建程序。检查模板不需要账本，也不生成报告；返回 `compatible`、`missing_fields` 和 `issue`，不兼容时退出码为 1。

```sh
npm run build
node cli/main.mjs check-template csv examples/table.csv examples/statistics-histogram-template.json
```

正式发布时显式选择已有账本和请求编号。以下均为虚构示例；先准备 `private-data/` 目录，账本和输出路径须尚不存在：

```sh
node cli/main.mjs init-ledger private-data/template-example.sqlite template-example 0.6
node cli/main.mjs publish-template csv private-data/template-example.sqlite examples/table.csv examples/statistics-histogram-template.json monthly-summary-v1 private-data/monthly-summary.json
node cli/main.mjs publish-template json private-data/template-example.sqlite examples/table.json examples/statistics-histogram-template.json monthly-summary-v1 private-data/monthly-summary-again.json
```

两种格式的示例映射为相同记录，第二次发布复用同一报告，不再次扣费，剩余 ε 为 0.3。数据序列或统计设置改变后，旧请求编号会产生冲突；模板名称改变不影响结果复用。新分析需要新编号，并继续累计消耗原账本预算。`publish-template` 不会因模板导入而创建或重建账本。

## 程序接口

```js
import { readFileSync } from 'node:fs';
import { parseStatisticsTemplate, createStatisticsTemplate, checkStatisticsTemplate } from './runtime/templates.mjs';
import { publishTemplateRelease } from './runtime/table.mjs';

const templateText = readFileSync('examples/statistics-histogram-template.json', 'utf8');
const input = readFileSync('examples/table.csv', 'utf8');
const template = parseStatisticsTemplate(templateText);
const compatible = checkStatisticsTemplate(template, 'csv', input);
const renamed = createStatisticsTemplate('每月意见统计', template.settings);
// Only an explicit release uses a ledger and spends budget.
const report = publishTemplateRelease('private-data/template-example.sqlite', 'csv', input, templateText, 'monthly-summary-v1');
```

`parseStatisticsTemplate` 接受原始文本，以便发现重复键；返回冻结对象。`createStatisticsTemplate` 仅接受模板名称和统计设置，拒绝额外的发布身份或原始数据字段。`checkStatisticsTemplate` 不访问账本或随机源，只在内存中校验数据，不返回人员标识、实际人数或明细。

MoonBit 对应入口为 `parse_statistics_template` 和 `check_statistics_template`，JSON 边界操作为 `parseStatisticsTemplate`、`checkStatisticsTemplate`。这一节点实现单个统计工具内的配置复用；字段脱敏、问卷和多方协作的通用配置转换仍需独立设计，不能把类型不同的配置直接相互导入。
