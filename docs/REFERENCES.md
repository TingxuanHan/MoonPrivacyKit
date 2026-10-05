# 参考与生态边界

## 方法参考

- [OpenDP 随机响应文档](https://docs.opendp.org/en/stable/api/user-guide/measurements/randomized-response.html)：有限类别随机响应及比例估计的数学参考。
- [OpenDP](https://github.com/opendp/opendp)：MIT 许可的差分隐私库。本项目不是 OpenDP 的整库移植，当前不复制其实现代码。
- [NIST SP 800-226](https://csrc.nist.gov/pubs/sp/800/226/final)：差分隐私保证与实现风险的评估参考，用于审视保护单位、贡献约束、信任关系及发布流程。
- [NIST 隐私增强密码学与差分隐私](https://www.nist.gov/blogs/cybersecurity-insights/privacy-enhancing-cryptography-complement-differential-privacy)：区分计算过程保护与输出保护，为组合方案提供背景。
- [NIST 隐私集合求交与集合运算](https://csrc.nist.gov/projects/pec/psi)：区分交集成员、交集数量和交集聚合，为跨团队样本重叠统计选型。
- [NIST 零知识证明](https://csrc.nist.gov/projects/pec/zkproof)：说明在不揭示秘密见证的情况下证明数学关系的能力，作为后续输入范围与一致性验证的参考。
- [NIST IR 8053](https://csrc.nist.gov/pubs/ir/8053/final)：去标识化与剩余隐私风险的背景资料，用于字段处理、泛化及风险说明。
- [W3C Web Cryptography](https://www.w3.org/TR/webcrypto/)：浏览器安全随机数接口规范。

## 后续密码后端候选

以下仅为技术评估对象，尚未接入或复制代码；正式选型需再核对协议、维护状态、安全公告和具体版本许可。

- [MP-SPDZ](https://github.com/data61/MP-SPDZ)：用于比较不同安全模型下的 MPC 协议与计算成本。主体采用 BSD-3-Clause，附带组件另有条款，详见其 [License.txt](https://github.com/data61/MP-SPDZ/blob/master/License.txt)。项目明确说明其实现并不等于已通过生产级安全审查，本项目拟先用于原型与基准评估。
- [Microsoft SEAL](https://github.com/microsoft/SEAL)：MIT 许可的同态加密库，作为有界密文算术的候选后端。密钥管理、结果开放方式及密文和计算开销仍需由应用设计与验证。

检索核对日期：2026-10-05。技术路线是结合项目场景作出的设计选择，不代表上述机构对本项目的背书或安全认证。

## 相邻 MoonBit 项目

- [moon-privacy-budget](https://github.com/ppyq882/moon-privacy-budget)，Apache-2.0：差分隐私机制与预算账本。
- [MoonRedactKit](https://github.com/xvkong834/MoonRedactKit)，Apache-2.0：敏感信息识别与脱敏策略。

MoonPrivacyKit 当前聚焦问卷配置、本地回答保护、结果估计与真实数据字段处理，长期扩展协同计算和受保护的统计发布。项目特色在于以任务配置连接不同保护方法，解释信任假设、输出范围与使用成本。相关基础能力已有生态实现，不把整个隐私领域描述为生态空白。当前初始核心独立实现，第三方运行时依赖以模块清单为准；后续引入代码或依赖时同步维护许可和来源。
