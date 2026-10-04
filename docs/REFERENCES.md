# 参考与生态边界

## 方法参考

- [OpenDP 随机响应文档](https://docs.opendp.org/en/stable/api/user-guide/measurements/randomized-response.html)：有限类别随机响应及比例估计的数学参考。
- [OpenDP](https://github.com/opendp/opendp)：MIT 许可的差分隐私库。本项目不是 OpenDP 的整库移植，当前不复制其实现代码。
- [W3C Web Cryptography](https://www.w3.org/TR/webcrypto/)：浏览器安全随机数接口规范。

## 相邻 MoonBit 项目

- [moon-privacy-budget](https://github.com/ppyq882/moon-privacy-budget)，Apache-2.0：差分隐私机制与预算账本。
- [MoonRedactKit](https://github.com/xvkong834/MoonRedactKit)，Apache-2.0：敏感信息识别与脱敏策略。

MoonPrivacyKit 聚焦问卷配置、本地回答处理、结果估计与文件分享的完整使用流程。相关基础能力已有生态实现，不把整个隐私领域描述为生态空白。当前初始核心独立实现，第三方运行时依赖以模块清单为准；后续引入代码或依赖时同步维护许可和来源。
