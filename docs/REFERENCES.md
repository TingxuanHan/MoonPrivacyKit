# 参考与生态边界

## 方法参考

- [RFC 9474](https://www.rfc-editor.org/rfc/rfc9474.html)、[Cloudflare blindrsa-ts](https://github.com/cloudflare/blindrsa-ts)：匿名参与凭证的标准与实际密码组件；[RFC 9576](https://www.rfc-editor.org/rfc/rfc9576.html) 为角色分离与关联风险的背景。
- [sdcTable](https://sdctools.github.io/sdcTable/articles/sdcTable.html)：统计披露控制问题参考，GPL 源码没有复制或依赖。
- [Tumult 私有连接](https://docs.tmlt.dev/analytics/v0.21/reference/api/tmlt.analytics.QueryBuilder.join_private.html)：按人所有权与连接贡献约束的参考，未复制实现。
- [Prio](https://crypto.stanford.edu/prio/)：多服务秘密分享聚合背景；本原型没有实现其恶意输入证明，不以 Prio 安全性为自身背书。

- [OpenDP 随机响应文档](https://docs.opendp.org/en/stable/api/user-guide/measurements/randomized-response.html)：有限类别随机响应及比例估计的数学参考。
- [OpenDP 加性噪声机制](https://docs.opendp.org/en/stable/api/user-guide/measurements/additive-noise-mechanisms.html)：整数几何噪声、向量查询及 L1 敏感度的参考；本项目的保守有理数校准与采样说明见[中心化隐私统计](CENTRAL_PRIVACY.md)。
- [OpenDP](https://github.com/opendp/opendp)：MIT 许可的差分隐私库。本项目不是 OpenDP 的整库移植，当前不复制其实现代码。
- [NIST SP 800-226](https://csrc.nist.gov/pubs/sp/800/226/final)：差分隐私保证与实现风险的评估参考，用于审视保护单位、贡献约束、信任关系及发布流程。
- [NIST 隐私增强密码学与差分隐私](https://www.nist.gov/blogs/cybersecurity-insights/privacy-enhancing-cryptography-complement-differential-privacy)：区分计算过程保护与输出保护，为组合方案提供背景。
- [NIST 隐私集合求交与集合运算](https://csrc.nist.gov/projects/pec/psi)：区分交集成员、交集数量和交集聚合，为跨团队样本重叠统计选型。
- [NIST 零知识证明](https://csrc.nist.gov/projects/pec/zkproof)：说明在不揭示秘密见证的情况下证明数学关系的能力，作为后续输入范围与一致性验证的参考。
- [NIST IR 8053](https://csrc.nist.gov/pubs/ir/8053/final)：去标识化与剩余隐私风险的背景资料，用于字段处理、泛化及风险说明。
- [ARX](https://github.com/arx-deidentifier/arx)（Apache-2.0）：[候选方案探索与可用性分析](https://arx.deidentifier.org/anonymization-tool/)的方法和产品参考，用于规划有限候选比较；当前没有复制代码，也不将 k-匿名、泛化或方案搜索声称为本项目发明。
- [W3C Web Cryptography](https://www.w3.org/TR/webcrypto/)：浏览器安全随机数接口规范。

## 后续密码后端候选

以下仅为技术评估对象，尚未接入或复制代码；正式选型需再核对协议、维护状态、安全公告和具体版本许可。

- [MP-SPDZ](https://github.com/data61/MP-SPDZ)：用于比较不同安全模型下的 MPC 协议与计算成本。主体采用 BSD-3-Clause，附带组件另有条款，详见其 [License.txt](https://github.com/data61/MP-SPDZ/blob/master/License.txt)。项目明确说明其实现并不等于已通过生产级安全审查，本项目拟先用于原型与基准评估。
- [Microsoft SEAL](https://github.com/microsoft/SEAL)：MIT 许可的同态加密库，作为有界密文算术的候选后端。密钥管理、结果开放方式及密文和计算开销仍需由应用设计与验证。

原方法选型日期：2026-10-05；相邻项目与新增工具参考于 2026-10-16 补充核对。技术路线是结合项目场景作出的设计选择，不代表上述机构对本项目的背书或安全认证。

## 相邻 MoonBit 项目

- [moon-privacy-budget](https://github.com/ppyq882/moon-privacy-budget)，Apache-2.0：已有随机响应等差分隐私机制、预算策略、账本预留／提交／回滚、查询计划、批处理和审计导出。已引入 0.1.1 的 core/ledger 兼容子集，实际执行预算预留与核对；详见[上游接入](UPSTREAM_INTEGRATION.md)。
- [moon_scrub](https://github.com/yyqdbngt/moon-scrub)，Apache-2.0，模块名 `123123213weqw/moon_scrub`：已有离线敏感信息扫描、脱敏、结构化字段、JSON／日志及流式管道。已实际引入可安装的 0.5.2 并提供内容扫描与文本脱敏；不冒充已接入源码快照中的 0.9.0。
- [MoonSentinel](https://github.com/STW135-2026/moonsentinel)，Apache-2.0：已有单批次 k-匿名、l-diversity、用途／接收方核验和发布回执。作为功能对照，不将单次风险门禁另作本项目贡献。
- [MoonRedactKit](https://github.com/xvkong834/MoonRedactKit)，Apache-2.0：敏感信息识别与脱敏策略。

当前组合已有基础组件与本项目新增任务核心，不把基础机制、预算和脱敏作为独占创新。六项实现、对应反例和与相近项目的区别见[生态定位](ECOSYSTEM_POSITIONING.md)。
