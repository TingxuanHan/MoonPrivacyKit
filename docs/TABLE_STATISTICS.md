# 从真实表格发布隐私统计

本节点把 CSV／JSON 表格连接到现有中心化统计核心与发布账本，提供命令行和 Node.js 接口。使用者指定人员标识列，以及直方图所需的类别列和公开类别集合；MoonBit 负责解析和映射，账本负责预算、受保护结果保存及重试复用。工作台的图表与报告入口是下一节点。

## 运行完整示例

在仓库根目录执行，先准备 `private-data/` 目录。示例数据均为虚构，CSV 和 JSON 表达相同的记录。下面的账本和输出路径必须尚不存在；已有账本应继续使用，不能为了重跑示例删除真实发布历史。

```sh
npm run build
mkdir private-data
node cli/main.mjs init-ledger private-data/table-example.sqlite table-example 1
node cli/main.mjs publish-table csv private-data/table-example.sqlite examples/table.csv examples/table-count-plan.json private-data/table-count.json
node cli/main.mjs publish-table json private-data/table-example.sqlite examples/table.json examples/table-histogram-plan.json private-data/table-histogram.json
node cli/main.mjs ledger-status private-data/table-example.sqlite
node cli/main.mjs publish-table json private-data/table-example.sqlite examples/table.json examples/table-count-plan.json private-data/table-count-again.json
```

前两次发布分别消耗 0.3 和 0.7，剩余预算为 0。最后一次使用相同请求编号及等价数据，取得原计数报告，内容与第一次一致，不再次扣减预算。报告已经保存时，也可不读取原表，直接恢复：

```sh
node cli/main.mjs export-release private-data/table-example.sqlite participants-v1 private-data/table-count-recovered.json
```

## 配置自己的表格

`publish-table` 的参数顺序为：格式、账本、原文件、发布方案、新报告。方案示例：

```json
{
  "schemaVersion": 1,
  "scope": "table-example",
  "requestId": "answers-v1",
  "query": "histogram",
  "epsilon": "0.7",
  "maxContributions": 1,
  "unitField": "person_id",
  "categoryField": "answer",
  "categories": ["满意", "一般", "不满意"]
}
```

- `schemaVersion` 固定为数字 `1`。未知字段、未知版本和缺少必填项均被拒绝。
- `scope` 对应账本中的保护范围，应覆盖可能重复出现的人员；不能只按文件名划分。`requestId` 是一次发布的稳定编号，重试时保持不变，两者都不要包含个人信息。
- `query` 为 `count` 或 `histogram`。计数方案省略 `categoryField`、`categories`。
- `epsilon` 为最多六位小数的十进制字符串，单次在 `0.01` 至 `8` 之间；累计值受账本总预算约束。
- `unitField` 指定稳定的人员标识列。同一个人在所有相关记录中必须使用一致的标识，不能用行号或每条记录的流水号代替。
- `maxContributions` 为 `1` 至 `32` 的整数，省略时为 `1`。计数在上限为 `1` 时估计不同人员数；上限更大时，统计的是按人裁剪后的记录数。
- 直方图须指定 `categoryField` 和 1 至 256 个唯一、非空的公开类别标签。类别顺序就是报告计数的顺序，未出现的预设类别也会输出受保护计数。类别及其含义须事先确定，不从真实数据自动提取类别作为可公开输出域。

直方图的贡献上限作用于一个人在全部类别中的记录，按原表顺序保留其最前面的有限条贡献。以样例为例，上限为 `1` 时，`unit-001` 的第二条记录不参与统计，但仍必须通过完整校验。系统不会把未知类别、缺失值或格式错误静默丢弃。

## 输入约定

- CSV：严格的 UTF-8 逗号分隔文本，有唯一且非空的表头；支持 BOM、LF／CRLF、双引号和单元格内换行。字段名按原样匹配。
- JSON：顶层对象或对象数组。被映射字段必须存在于每条记录中，且值必须为字符串；拒绝数字、布尔、空值和对象，也拒绝各层对象中的重复键，包括转义后相同的键。
- 人员标识长度为 1 至 128 个文本单位，不能为空或带首尾空白。系统不自动修剪、转数字或合并不同写法，以免破坏身份对应关系。JSON 中的 `"001"` 保留原值，数字 `1` 会被拒绝。
- 字段名不超过 256 个文本单位，类别标签不超过 128 个文本单位。类别值精确匹配，不自动去空格或改变大小写。
- 表格限制沿用现有解析器：文件至多 4 MB，核心文本至多 200 万文本单位、10 万记录、512 个不同字段。JSON 空数组和仅含有效表头的 CSV 可发布受保护的零统计；空数组没有可检查的字段实例，须由调用者核对映射。
- 未选中的列可包含其他结构化内容，不进入统计请求；它们不会被复制进报告。输入校验错误只供可信数据持有者查看，错误消息不回显原值。

该流程直接在可信持有者处读取原表。人员标识和类别索引作为内存中的中间数据交给统计核心，不能作为公开结果。若先删除或遮盖人员标识列，将无法可靠地执行按人贡献限制；无需保留的字段可以另行处理后导出。

## 输出、预算与恢复

输出与原有账本报告格式一致，包含发布编号、公开类别、受保护计数、单次预算、贡献上限及 95% 同时绝对误差界；不附带原始明细、真实人数、被裁剪的记录数、字段映射或人员标识。误差界针对贡献裁剪后的统计量，不覆盖裁剪引入的偏差。

请求绑定以映射后的人员和类别序列、公开类别定义、预算和贡献上限为准。CSV 与 JSON 的等价输入可以复用同一结果；只修改无关列也不会要求重新发布。映射后的序列或统计设置改变，却沿用已使用的编号时，会报请求冲突。新发布须使用新编号，并累计消耗预算；不能通过更换文件或格式重置开销。

输出文件必须不存在，原表不被覆盖。报告写出失败时，账本可能已经完成提交，使用原请求编号重试或执行 `export-release`，不要换编号重新生成。账本依赖可信持有者保留最新历史；边界和异常恢复方式见[发布账本](RELEASE_LEDGER.md)。

## Node.js 接口

```js
import { readFileSync } from 'node:fs';
import { publishTableRelease } from './runtime/table.mjs';

const report = publishTableRelease(
  'private-data/table-example.sqlite',
  'csv',
  new TextDecoder('utf-8', { fatal: true }).decode(readFileSync('examples/table.csv')),
  JSON.parse(readFileSync('examples/table-count-plan.json', 'utf8')),
);
```

该接口同步执行，仅返回账本已提交的受保护报告。MoonBit 的 `map_table` 和 JSON 边界的 `mapTable` 是可信持有者使用的低层映射接口，返回的是私有中间数据，本身不产生隐私保护，也不扣减预算。正式发布应使用 `publishTableRelease`。
