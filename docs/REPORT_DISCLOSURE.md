# 报表防反推

检查同一群体、同一统计口径下，公开合计与分项能否联合推断受保护单元格。MoonBit 核心执行整数约束传播、带剪枝的枚举和候选修复检查，输入不需要原始人员明细。

```sh
npm run build
node cli/main.mjs inspect-reports examples/disclosure.json inspection.json
```

示例中的公开总人数为 52，A 类为 35，待发布 B 类为 16。工具得出 C 类只能为 1，并验证取消发布 B 后 C 的可行范围为 0 至 17。每个受保护单元格独立设置最小范围宽度；这是用户的检查目标，不是通用匿名性阈值。

## 输入与结果

使用 `examples/disclosure.json` 的版本化格式。`cohort` 表示用户明确核对过的群体和统计口径。`cells` 中的上下界必须是允许对手知道的公开条件，不得由未发布明细推导后冒充公开信息。`equations` 只表示不同单元格的精确计数之和；`published` 为 true 的等式在所有修复候选中保留。

支持 1 至 12 个单元格、1 至 24 条等式，单元格范围 0 至 10000，每次求解最多 20000 个搜索节点。输出区分 `risk_found`、`no_risk_in_model`、`inconsistent`、`inconclusive`。搜索未完成时不输出貌似完整的数值范围，也不宣布没有风险。

`findings` 给出受保护单元格的可行最小值和最大值，以及参与检查的等式。证据集合不保证最小。候选修复最多检查 16 个单项或双项草稿撤回组合；结果经重新求解核验，不宣称全局最优，也不自动修改原文件。候选为空可能表示预算不足或该候选集未找到方案。

只检验已声明的数学模型，不能覆盖外部背景知识、未知报表、身份关联或所有攻击。带噪统计、四舍五入区间、跨群体差分和任意 SQL 尚不支持。不得把差分隐私输出当作精确约束。检查结果用于本地审查，可能含可推断的敏感数量，不自动成为可公开报告。

## 差异与来源

与 moon_scrub 的内容检测、MoonSentinel 的单批发布检查不同，本模块分析跨报表数值关系并提供推断范围和可复验修复。与 moon-privacy-budget 的预算管理不同，本模块不调用噪声机制、不消耗预算。参考 sdcTable 的统计披露控制问题定义，独立编写本模块；没有复制或依赖其 GPL 源码。

- https://github.com/yyqdbngt/moon-scrub
- https://github.com/STW135-2026/moonsentinel
- https://github.com/ppyq882/moon-privacy-budget
- https://sdctools.github.io/sdcTable/articles/sdcTable.html
