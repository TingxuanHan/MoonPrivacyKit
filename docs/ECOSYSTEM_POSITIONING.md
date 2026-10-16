# 既有项目关系与差异化贡献

核对日期：2026-10-16。本文与[申报书](APPLICATION.md)一起说明实际复用、已完成扩展及边界。比较基于已核对的公开源码和接口，不是对其他项目功能的穷尽审计，也不构成全生态唯一性或算法首创声明。

## 实际复用关系

当前已在 [moon.mod](../moon.mod) 引入两个 MoonBit 依赖；不是上游仓库的分支或整库移植。应用扩展调用上游公开接口，其实现和检测规则归属上游。具体兼容范围见[适配说明](UPSTREAM_INTEGRATION.md)。

| 项目 | 已有能力与重叠 | 当前实际关系 |
| --- | --- | --- |
| [ppyq882/moon-privacy-budget](https://github.com/ppyq882/moon-privacy-budget/tree/5c7ceb04b6b9f6145d3f623d546fffe0cdf876bd)，Apache-2.0 | 多种 DP 机制、随机响应、预算策略、预留/提交/回滚、查询计划、批处理、审计和联邦协调。预算、查询和报告均非空白。 | 安装 Mooncakes 0.1.1，复用 core/ledger 的预算、预留、回滚、提交与核对。适配层在 SQLite 原子事务内对精确剩余预算作无状态准入核验；没有第二个独立扣费账本。原有随机机制保留，并未整体改用上游噪声实现。 |
| [moon_scrub](https://github.com/yyqdbngt/moon-scrub/tree/bc282d3a247ff45ecf37795d662b81bd90e68f44)，Apache-2.0 | 敏感内容检测、脱敏、结构化字段、JSON/日志管道、流式扫描与规则解释。不是仅能删除字段的简单函数。 | 实际安装可获取的 0.5.2；源码快照声明的 0.9.0 在本次包仓库中无法解析。复用顶层字符串扫描和文本脱敏。工作台显示命中类别与数量，不回显值。 |
| [Cloudflare blindrsa-ts](https://github.com/cloudflare/blindrsa-ts)，Apache-2.0 | RFC 9474 RSA 盲签名 | 实际依赖 npm 0.4.6；项目新增调查上下文、资格限额、角色存储、原子兑换、重试绑定及文件流程，不将密码原语称为原创。 |

依赖版本、许可证及构建产物声明见 [THIRD_PARTY.md](../THIRD_PARTY.md)。基础 DP、预算、脱敏、k-匿名、秘密分享与盲签名均不作为本项目独创技术。

## 已经实现的任务能力

| 工具与可运行反例 | 与相近 MoonBit 功能的差别 | 实现与验证证据 |
| --- | --- | --- |
| 报表防反推：总数 52、A=35、草稿 B=16 推出 C=1；撤回草稿 B 后 C 可为 0–17 | 与内容扫描、单表分组或预算累计不同，分析多张精确报表的整数关系，给出范围与依据，候选修复保留全部已公开关系并重新求解。 | [约束核心](../disclosure.mbt)、[独立枚举对照](../tests/disclosure.test.mjs)、[工具说明](REPORT_DISCLOSURE.md) |
| 匿名参与凭证：核验资格后只能签发一次，收卷不含账号；同一包重试返回原回执 | LDP 保护回答内容，不解决资格与重复兑换。本工具把身份核验和收卷分开，并实现盲签发、调查绑定、过期检查、一次兑换与并发原子性。 | [资格/收卷实现](../runtime/credentials.mjs)、[独立进程测试](../tests/credentials.test.mjs)、[信任模型](ANONYMOUS_CREDENTIALS.md) |
| 按人保护的多表统计：同一人左右各多行，连接前后均裁剪；整数和按公开上界推导敏感度 | 上游 [QueryPlan 接口](https://github.com/ppyq882/moon-privacy-budget/blob/5c7ceb04b6b9f6145d3f623d546fffe0cdf876bd/src/query/pkg.generated.mbti) 以单 Table 筛选和分组为主；本模块明确跨两表的同人邻接、连接放大、贡献约束，并接入可恢复发布。 | [MoonBit 计划/映射](../person_query.mbt)、[邻接及预算测试](../tests/person-query.test.mjs)、[范围](PERSON_QUERIES.md) |
| 分开保管数据的联合统计：客户端拆分向量，分别加密给 A/B，固定全员交齐才签名合计 | 上游该快照的 [noisy_secure_aggregate](https://github.com/ppyq882/moon-privacy-budget/blob/5c7ceb04b6b9f6145d3f623d546fffe0cdf876bd/src/federated/secure_aggregation.mbt) 为明文数组聚合模拟；本项目有真正加密包、参与方认证、独立服务/密钥与签名核验。此比较只针对该函数，不否定上游其他能力。 | [协议实现](../runtime/secure-aggregation.mjs)、[双服务测试](../tests/secure-aggregation.test.mjs)、[模型与限制](JOINT_STATISTICS.md) |
| 处理方案比较：同一表按有限候选比较分组风险、规则损失、字段保留与约束可行性，再明确导出副本 | [MoonSentinel](https://github.com/STW135-2026/moonsentinel/tree/f85a56d3800b5864cd0c6e579d12647e7c27e62b) 已有单批 k/l、用途/接收方核验及发布回执；本工具重点是多个候选的取舍和未被同时改善的可行集合，单次 k 检查不是新增算法。 | [分析核心](../planning_tools.mbt)、[手算与失败路径](../tests/planning-tools.test.mjs)、[设计](PRIVACY_PLANNING_TOOLS.md) |
| 两版数据联合检查：两版最小组都为 2，关联后最小组为 1 | 检查同一群体跨版本可见信息的交叉细分，要求一人一行与可靠私有对应；不把无法对应当作通过，不建立原表备份。 | [分析核心](../planning_tools.mbt)、[四行反例](../planning_tools_wbtest.mbt)、[浏览器流程](../tests/advanced-ui.test.mjs) |
| 隐私流程检查：先限贡献再删标识可保留约束，反过来则定位阻断；两个新发布累计预算，图表复用同一发布 | 上游预算库已检查计划与预算，MoonSentinel 已核验单批发布。此模块检查跨步骤的数据状态、参数来源、人员约束和发布身份；精确联合合计不能伪装成受保护结果，未知操作不放行。通用编排和 DP 组合均不是新发明。 | [MoonBit 检查核心](../workflow.mbt)、[分支与失败用例](../tests/workflow.test.mjs)、[专门比较与边界](PRIVACY_WORKFLOWS.md) |

以上七项均可在工作台或命令行使用；这比入口统一多了一层可单独验证的分析或协议行为。统一交付本身只是可用性贡献，不能代替上述核心能力。

流程检查另与 [workflows.mbt](https://github.com/f4ah6o/workflows.mbt/tree/dac416614f892e91a48b94b35444bdefe5ee5a36) 对照：该项目是持久工作流兼容运行时，本模块是有限的隐私条件检查器，不调度或执行任务，也未复用其代码。其他语言的 [OpenDP Chaining](https://docs.opendp.org/en/stable/api/user-guide/combinators/chaining.html) 已有类型/度量匹配与机制组合；本模块针对本工具箱的跨工具声明及非 DP 输出边界，不能等同于 OpenDP 的证明体系。详细重叠与引用版本见[流程检查说明](PRIVACY_WORKFLOWS.md)。

补充边界：[moonveil](https://github.com/wangjiale6036-dotcom/moonveil) 已提供稳定 HMAC 假名、作用域与可复现处理；[moonlogfmt-lens](https://github.com/sqhyyy/moonlogfmt-lens) 已有日志合同、脱敏与漂移分析；[moonredact](https://github.com/chenliyi-cly/moonredact) 已有检测、策略比较和残留扫描。故本项目不把“稳定标识”“策略比较”这一宽泛词语或“重试可复现”本身作为独占差异。具体差别是表格候选的分组/信息损失指标、可靠跨版本对应下的组合分组变化，以及上述完整发布与协议约束。

## 不夸大的范围

- 报表检查只处理输入模型内的精确整数加法；有计算上限，无结论时不判安全。
- 方案比较是预设有限候选，损失指标公开可解释，不是全球最优匿名化算法；两版检查依赖正确可关联假设。结果均为内部私有分析，不自动公开。
- 多表查询仅支持同人内连接和有界整数和/计数，不是任意 SQL 的自动隐私证明。
- 凭证不隐藏 IP/时间等元数据；资格核验方必须实际验证账号资格，公共配置分发也需可信。
- 联合统计要求参与方遵守协议且至少一个聚合方不串通；签名不等于恶意输入范围证明，精确输出不等于 DP。未实现 Prio 的证明体系。
- 本地原型和多进程测试不是生产级网络部署、安全审计或监管认证。
- 流程检查只验证所声明的有限步骤；来源真实性、人员对应和预算快照不由它核实。它不执行发布，不改变实际账本，不是外部文件的可信证书。

其他语言中的 ARX、sdcTable、Tumult、RFC 9474 和 Prio 提供已知方法或问题参考，详见[来源](REFERENCES.md)。参赛差异定位于 MoonBit 中可审阅的任务实现及其约束组合，不声称发明这些方法。
