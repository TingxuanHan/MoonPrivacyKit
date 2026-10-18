# 隐私合成数据

把真实分类表转换为可用于演示、流程测试和探索性分析的替代表格。用户事先声明字段类别及简单关系，工具先生成差分隐私统计，再从这些统计中抽样。导出不包含人员标识、未选字段或原始记录副本。

这是公开关系树的有限实现，不是完整的 MST、任意数据生成模型或效用保证。合成行可能偶然与真实记录的类别组合相同；隐私依据是受保护统计的差分隐私性质，不是逐行去重或“没有一行相同”。

## 使用流程

1. 进入“合成数据”，选择与同一人群其他发布共用的统计项目。更换输入文件或生成工具不会重置累计预算。
2. 根据已有问卷定义或公开业务规则填写字段名、完整类别集合和生成行数。第一字段先生成，后续每个字段选择一个前面的字段作为条件，构成关系树。不要读取真实数据后再挑类别、关系或输出行数。
3. 导入 UTF-8 CSV 或 JSON 对象数组。一人一行，人员标识为非空字符串，分类值也必须是字符串。重复人员、重复 JSON 键、缺失值和域外类别会被拒绝；工具不会自动提取私有类别补入配置。
4. 设置本次 ε 并生成。预算、受保护统计和最终合成数据在同一 SQLite 事务中保存。之后可下载 CSV 或完整 JSON 记录，也可从生成记录和“隐私统计”的历史中重新打开。
5. 若返回结果前连接中断，先“恢复待确认合成数据”。尚未保存时，用原文件和配置重试同一编号；不要创建新项目或新编号绕过未确认的发布。

工作台可下载仅含虚构记录的示例。六行示例主要展示操作，噪声可能占主导，不用于说明统计精度。公开配置可以导出和导入，不包含原表、发布编号或预算。

## 保护与计算

假设公开字段数为 `d`。测量向量由第一字段的一维计数，以及其他字段与其父字段的二维计数拼接而成。各组占用互不重叠的格子；一个人向每组贡献一次，因此在一人一行的有效数据域中，增删一个人使向量的 L1 距离恰为 `d`。

一次调用现有的 `central-geometric24-v1` 向量机制，贡献上限设为 `d`，使用请求的总 ε。不会把每张二维表各使用完整 ε 后仅扣一次费。沿用[中心化统计](CENTRAL_PRIVACY.md)的保守整数噪声校准、安全随机源和输出裁剪；已有上游预算适配仍由同一持久账本调用。

合成阶段只接收公开配置和已经加噪的计数。起始字段按其计数分布生成，后续字段按已生成父类别对应的条件计数生成。所有格子固定加 1 平滑，以定义全零条件行；使用整数权重和安全均匀抽样，避免浮点累积概率误差。此阶段及 CSV 转换均为后处理，不另增加隐私开销。生成时抽样一次并保存结果；下载和恢复不重新抽样。

可信数据持有方必须正确界定人员和公开先验。当前保护的是增删一个人的一条记录；换人邻接需按相应组合解释。输入错误是持有方内部反馈，不能将校验接口开放为面向不可信用户的私有数据探针。受保护统计及合成表可以一起发布，但原表校验结果、精确人数和未经保护的拟合质量不能混入公开文件。

## 支持范围

| 项目 | 当前范围 |
| --- | --- |
| 输入 | CSV／JSON，文本上限 2,000,000 字符，最多 10,000 人，一人一行 |
| 字段 | 1–6 个分类字段，每字段 1–8 个公开类别，字段名和类别均为单行，合计最多 256 个测量格子 |
| 关系 | 一棵有序公开树；每个非起始字段指定一个前序字段 |
| 输出 | 事先指定 1–5,000 行；JSON 含公开计划、受保护统计、合成行及稳定 CSV |
| CSV | 引号转义，公式样式字段名与值添加单引号前缀；JSON 保留原公开标签 |
| 预算 | 单次 ε 0.01–8，最多六位小数；与计数、直方图及多表统计共用账本 |

当前不自动寻找关系、不处理连续数值、不强制跨列逻辑约束、不支持多行人员。数值需要按事先公开的区间分组；标识列不能作为合成字段。低预算、小样本、稀有类别、错误的关系树和未建模的高阶依赖都会影响可用性。统计报告的误差界只针对加噪测量，不是对最终合成表或下游模型的精度承诺。

## 命令行与接口

下列输入全部为仓库中的虚构示例，输出路径须不存在：

```sh
node cli/main.mjs init-ledger synthetic-demo.sqlite demo-cohort 3
node cli/main.mjs plan-synthetic examples/synthetic-plan.json plan-explanation.json
node cli/main.mjs synthesize synthetic-demo.sqlite examples/synthetic-plan.json csv examples/synthetic-source.csv demo-release-1 1 synthetic-result.json
node cli/main.mjs export-synthetic synthetic-demo.sqlite demo-release-1 synthetic-table.csv
node cli/main.mjs export-release synthetic-demo.sqlite demo-release-1 recovered-result.json
```

`plan-synthetic` 仅检查公开配置，不读取原表或消耗预算。`synthesize` 在保存成功后才导出；若文件写入失败，后两条命令可直接恢复。所有导出拒绝覆盖现有文件。

MoonBit 的 `plan_synthetic` 和 `map_synthetic` 实现配置校验与私有测量映射；`dispatch_synthetic` 仅对受保护计数作条件抽样。Node 的 `runtime/synthetic.mjs` 提供 `parseSyntheticPlan`、`planSynthetic`、`publishSynthetic`。不要把 `map_synthetic` 返回的私有中间数组当作可公开报告。

## 来源与 MoonBit 差异

核对日期：2026-10-18。比较针对已查看的 README、接口及源码范围，不证明整个生态从未出现同类项目。

| 相近项目 | 已有能力 | 本节点的差异与关系 |
| --- | --- | --- |
| [moon-privacy-budget](https://github.com/ppyq882/moon-privacy-budget/tree/5c7ceb04b6b9f6145d3f623d546fffe0cdf876bd) | DP 机制、预算、查询与审计 | 继续复用其预算接口；新增公开关系树测量、合成模型及表格生成任务。所查接口未提供这一整条表格合成流程，不将噪声或预算称为创新。 |
| [moon_scrub](https://github.com/yyqdbngt/moon-scrub) | 内容扫描、结构化脱敏与流式处理 | 已有记录的识别和修改，与从受保护统计生成新表用途不同。复用关系仍是原有扫描/脱敏适配，不宣称由其实现合成。 |
| [moonbit-synthetic-vision](https://github.com/caassien/moonbit-synthetic-vision) | 确定性图像与视觉标注测试素材 | 本工具输入真实分类表，经按人 DP 后输出替代表格；不生成图像或复用其代码。 |
| [moon-record-linkage](https://github.com/didiLjf/moon-record-linkage) | 实体匹配、记录合并、确定性合成评测数据 | 其评测数据用于检验匹配算法；本工具学习受保护的分类关系并核算真实数据发布预算。未复用该项目实现。 |
| [SmartNoise MST](https://docs.smartnoise.org/synth/synthesizers/mst.html) | 基于私有测量和图模型的分类数据合成 | 作为方法与后续迁移参考；本节点独立实现公开树基线，使用现有纯 ε 整数机制，没有移植其自动选树、Private-PGM 推断或预处理。 |

[SmartNoise SDK](https://github.com/opendp/smartnoise-sdk) 根目录为 MIT；其 [MST 子目录许可证](https://github.com/opendp/smartnoise-sdk/blob/main/synth/snsynth/mst/LICENSE) 为 Apache-2.0。不能用根目录许可概括所有组件。当前没有复制或依赖其中代码；后续若迁移，将逐文件保留来源、许可证和改动说明。方法参考还包括 [McKenna 等的论文](https://arxiv.org/abs/2108.04978)；差异定位于 MoonBit 可用工具与实现，不宣称提出新的合成算法。

后续优先评估带隐私预算的关系选择、模型一致性拟合与公开/受保护的效用评估。它们均未在本节点实现；不能先读取真实数据选择“最好”的树，再把选择当成免费后处理。
