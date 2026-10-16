# 已有组件的实际适配

2026-10-16 已完成两个 MoonBit 依赖的可运行适配，不再仅为拟接入计划。声明见 moon.mod，调用见 upstream_adapters.mbt，测试见 budget_wbtest.mbt、planning_tools_wbtest.mbt 和 tests/planning-tools.test.mjs。Apache-2.0 文本保留于 licenses/，构建时复制至 dist/licenses/。

## moon-privacy-budget 0.1.1

复用 core.PrivacyBudget、ledger.PrivacyLedger 和 PrivacyAccount，实际执行注册、预留、回滚、再次预留、提交与核对。兼容子集是纯 ε（δ=0）、加法组合、单次预算 0.01–8、项目预算 0.01–1000。原始整数微单位仍是精确判定依据，持久化仍由 SQLite 事务控制。

每次新发布在已有事务内，用整数差值得到剩余预算后创建临时上游账户进行准入核验。临时对象不持久化，不与项目账本分别扣费；它的浮点余额也不回写项目。上游异常拒绝发布。重试先找到已有结果，不重新核验扣费。现有预算用尽、并发、回滚和响应中断测试覆盖真实发布路径。

这不等于完整后端迁移，不支持 RDP/zCDP/δ 的自动转换，也不导入另一个历史账本。上游全部噪声机制尚未接入。

## moon_scrub 0.5.2

本次源码快照声明 0.9.0，但包仓库无法解析；实际安装版本为 0.5.2。复用 ScanConfig::standard、scan_with_config 和 redact_with_config。构建检查已安装版本，若解析变化须复核适配。

内容扫描对 CSV/JSON 顶层字符串逐项执行，输出列名、受影响行数与命中类别，不返回原值、命中片段或身份。数值型、嵌套对象不会自动当作文本扫描；漏报、误报以及列名自身敏感性仍需持有者复核。扫描建议不会自动改写字段，更不会授予后续发布权限。文本脱敏的输出仍可能有未识别信息。

工作台入口：发布检查 → 处理方案比较 → 扫描可能敏感的内容。CLI：

```sh
node cli/main.mjs scan-fields json input.json private-scan.json
node cli/main.mjs scrub-text input.txt scrubbed.json
```

扫描结果属于内部资料。字段处理模板继续记录用户的逐列决策，人员标识是否保持原样仍由原有衔接校验约束。
