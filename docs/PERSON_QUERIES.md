# 按人保护的多表统计

以同一个人在两张表中的全部记录为保护单位。MoonBit 在读取数据以前编译公开方案，计算关联行数上界、最终每人行数上限及 L1 敏感度；执行时先按人限制左右表，再按同一人员标识做内关联，最后限制每人输出数量。

首版支持 CSV／JSON、同一身份空间的内关联、计数和非负有界整数求和。人员 ID 必须是原样保留的非空字符串；跨人关联、模糊身份匹配、公开维表和任意 SQL 尚不支持。行数上限取 1 至 32，整数单行上界取 1 至 1000，下界固定为 0。负值裁剪到 0，超界值裁剪到上界；非整数和无效记录即使将被丢弃也拒绝。

## 运行

```sh
node cli/main.mjs plan-person-query examples/person-query.json explanation.json
node cli/main.mjs init-ledger person.sqlite demo-person 4
node cli/main.mjs publish-person-query person.sqlite examples/person-query.json csv members.csv csv activity.csv release-1 1 result.json
```

左表包含 `person` 列，右表包含 `person,hours`。示例方案左侧每人取 1 行、右侧取 3 行、关联后最多 3 行，每行小时数裁剪到 0 至 8。因此每人的总影响不超过 24。选择同一个人内部的前若干行，其他人的加入或删除不改变这些行；这依赖稳定的输入顺序，不是按全表前 N 行截取。

关联后的计数是裁剪后的关联记录数，只有最终每人最多 1 行时才对应参与关联的人数。求和可能重复计入右表数值，具体取决于左侧的行数，使用者必须按任务设置左侧上限。

统计发布使用现有 SQLite 账本，计划指纹与私有映射共同绑定请求编号。重试返回原结果，修改方案后不能复用同一编号；预算在结果持久化时一并提交。只导出受保护结果和公开推导，不输出人员 ID、明细或精确人数。原始表不会保存在账本中。

求和使用整数几何噪声，按 `min(left_cap * right_cap, output_cap) * value_upper` 校准。输出和目标总量均限定到 0 至 100000；误差描述的是裁剪后的统计量，不包括截断、顺序选择与关联造成的偏差。调参应先依据公开知识，不能用本地精确诊断挑选结果后忽略额外隐私消耗。

## 差异与来源

moon-privacy-budget 已提供预算、单表查询计划及机制。其 5c7ceb0 版本公开接口没有跨表人员归属传播，本模块新增按人关联语义、可执行贡献约束、敏感度推导和计划绑定。方法参考 Tumult Analytics 的 privacy ID 和受限关联，未移植其源码。基础噪声机制不列为原创算法。

https://github.com/ppyq882/moon-privacy-budget/blob/5c7ceb04b6b9f6145d3f623d546fffe0cdf876bd/src/query/pkg.generated.mbti

https://docs.tmlt.dev/analytics/v0.21/reference/api/tmlt.analytics.QueryBuilder.join_private.html
