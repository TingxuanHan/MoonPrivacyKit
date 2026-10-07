# 发布预算与结果复用

发布账本把一次中心化隐私统计的预算扣减和结果保存放在同一个事务中。成功保存后才返回结果；重复调用同一请求会取回原结果，不再加噪或消耗预算。当前可通过 Node.js 接口和命令行使用，尚未接入工作台。

账本只保存预算、请求绑定信息和受保护结果，不保存原始数据副本或人员标识。它会占用随发布次数、类别数增长的存储空间；不需要另外启动数据库服务。

## 完整示例

准备 MoonBit 与 Node.js 22.13.0 或以上版本，运行 `npm run build`，再创建本地 `private-data` 文件夹。以下输入均为仓库中的虚构数据，输出路径必须尚不存在。

```sh
node cli/main.mjs init-ledger private-data/october.sqlite example-october 1
node cli/main.mjs publish private-data/october.sqlite examples/release-count.json private-data/count-report.json
node cli/main.mjs publish private-data/october.sqlite examples/release-histogram.json private-data/histogram-report.json
node cli/main.mjs ledger-status private-data/october.sqlite
node cli/main.mjs export-release private-data/october.sqlite participant-count-v1 private-data/count-report-again.json
```

两次发布分别消耗 0.3 和 0.7，剩余预算为 0。最后一条命令仍可导出第一次发布的原结果，两个计数报告的内容一致。新的发布请求会被拒绝。`ledger-status` 在终端显示账本范围、总预算、已用预算、剩余预算和发布次数，不输出原始数据或内部指纹。

`publish` 接收约定结构的 JSON 请求，目前不直接读取任意 CSV／JSON 业务表。字段选择、人员标识映射及工作台报告流程是下一节点的工作。

## 请求配置

计数请求包含 `scope`、`requestId`、`query: "count"`、字符串形式的 `epsilon` 和 `unitIds`，可设置 `maxContributions`，默认值为 1。直方图改为 `query: "histogram"`，再提供公开预设的 `categories` 和与记录一一对应的 `categoryIds`。完整结构见 `examples/release-count.json` 与 `examples/release-histogram.json`。

`scope` 是本账本负责的保护范围，例如一个调查项目中可能重叠的人群，不能仅按文件名或文件指纹划分。`requestId` 是一次发布的稳定编号。两者应使用不含个人信息的编号，以字母或数字开头，最多 128 个字符，其余可使用字母、数字、点、冒号、下划线和连字符。

同一编号会绑定数据内容及顺序、统计种类、ε、贡献上限和类别含义。改变其中任何一项后沿用原编号会被拒绝。等价的小数写法，如 `"0.1"` 和 `"0.100000"`，视为相同配置。新编号代表一次新发布，即使输入数据相同也会重新计费。

仅需要重传或下载时，使用 `export-release`，无需再次提供原始数据。发生异常且不确定上次是否成功时，应保留同一编号重试；不要先换编号。

## 程序接口

```js
import { createLedger, publishRelease, savedRelease, ledgerStatus } from './runtime/ledger.mjs';

createLedger('private-data/project.sqlite', {
  scope: 'project-october', totalEpsilon: '1',
});
const request = {
  scope: 'project-october', requestId: 'participants-v1',
  query: 'count', epsilon: '0.3', maxContributions: 1,
  unitIds: ['example-a', 'example-a', 'example-b'],
};
const result = publishRelease('private-data/project.sqlite', request);
const retry = savedRelease('private-data/project.sqlite', 'participants-v1');
const remaining = ledgerStatus('private-data/project.sqlite');
```

这些接口同步执行。返回的发布对象包含格式版本、随机发布编号、公开类别标签和上一节点的统计报告，不附带请求指纹、账本密钥、人员标识或精确计数。结果对象被冻结，可序列化保存。

普通 `runtime/client.mjs` 中的 `centralCount` 和 `centralHistogram` 仍是无持久状态的核心适配器，不会自动访问账本。需要预算约束时应通过 `publishRelease` 调用。浏览器不能直接导入 Node.js 账本模块。

## 预算规则

预算输入为十进制字符串，最多六位小数；不接受科学记数法、负数、数字类型或更多小数位，也不静默舍入。内部以 0.000001 ε 为一个整数单位，MoonBit 负责核算剩余预算和拒绝超支。`0.1 + 0.2` 会精确用尽 `0.3`。

单次发布沿用核心的 0.01 至 8 范围；账本总预算范围为 0.01 至 1000。总预算是使用者事先确定的上限，不是推荐值或“安全等级”。创建后不提供扩额或清空历史接口；已有、损坏或版本不兼容的账本都不会自动重建。

同一账本中的发布采用顺序组合，计入请求的 ε。文件重命名、数据更新、切换计数与直方图，都不应绕过仍适用的历史开销。系统无法自动判断不同账本或不同标识是否对应同一批自然人；这一判断由可信数据持有者负责。

## 并发与故障行为

MoonBit 实现精确预算规则和统计预校验，Node.js 使用内置 SQLite 保存状态。事务采用 `BEGIN IMMEDIATE`、回滚日志和 `synchronous=EXTRA`，预算检查、采样和结果写入在同一写事务中完成。并发请求需取得同一账本的写锁，最长等待 5 秒，超时后提示按原编号重试。

| 情况 | 行为 |
| --- | --- |
| 输入不合法或预算不足 | 不生成新统计结果，不扣预算 |
| 同一请求已成功保存 | 返回原结果，不重复扣预算，即使剩余预算为零 |
| 同一编号对应不同数据或配置 | 拒绝，保留已有记录 |
| 随机源或提交过程失败 | 不向调用方返回结果；按原编号重试以确认是否已提交 |
| 进程在提交前终止 | 未提交事务回滚，下次可按原编号重新执行 |
| 提交成功后、结果返回前终止 | 预算与结果保留，下次取回原结果 |
| 报告导出失败 | 已保存的结果及预算保留，可再次导出 |

预算和结果使用同一个 SQLite 文件，临时日志由 SQLite 管理。不要在程序运行时单独删除日志或复制数据库作为恢复方案。本节点实际测试了进程中断与并发行为，没有进行突然断电、损坏磁盘或网络文件系统测试。

## 本地信任边界

账本属于可信持有者的本地状态，不应公开。数据与配置通过带密钥的摘要绑定，结果也带完整性校验；这些措施用于请求识别和发现意外修改，不是对账本拥有者的防篡改承诺。密钥保存在同一个私有账本内，数据库本身没有加密。

能够删除、复制、回滚旧账本或绕过接口的人仍可绕过本地预算控制。跨设备、多副本和有管理员权限的恶意操作不在本版保证内。同一保护对象应使用同一个受控账本；恢复不得遗漏已经发生的发布，不能用空账本替代无法确认的历史。

统计保护仍依赖[中心化隐私统计](CENTRAL_PRIVACY.md)规定的人员标识、贡献限制、公开类别和可信执行环境。错误、用量信息、账本内容和请求是否冲突只供持有者处理，不能作为已受差分隐私保护的外部查询接口。

## 验证与来源

测试覆盖精确小数累计、超预算拒绝、相同编号复用、配置冲突、随机源失效、提交失败、并发竞争、提交前后终止进程、输出文件写入失败及跨进程恢复，见[验证记录](VALIDATION.md)。故障注入仅存在于测试代码中，公开接口不提供测试开关。

持久化实现使用 [Node.js 内置 SQLite 接口](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html)，事务和恢复设计参考 [SQLite 原子提交说明](https://sqlite.org/atomiccommit.html)。Node.js 22 系列可能显示 SQLite 实验性接口提示；应用无需额外安装数据库包。
