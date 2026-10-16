# 第三方组件与方法来源

本项目采用 Apache-2.0。引用现有隐私定义和协议不构成算法原创性声明。

| 组件 | 用途 | 版本与许可 |
| --- | --- | --- |
| @cloudflare/blindrsa-ts | 匿名参与凭证的 RSA 盲签名 | 0.4.6，Apache-2.0，https://github.com/cloudflare/blindrsa-ts |
| SJCL | 上述组件内部的大整数与密码辅助代码 | npm 1.0.9 及其随包实现，选择 BSD-2-Clause 许可分支，https://github.com/bitwiseshiftleft/sjcl |
| esbuild | 本地浏览器模块打包，仅构建时使用 | 0.28.2，MIT，https://github.com/evanw/esbuild |
| Playwright | 浏览器流程验证，仅开发时使用 | 1.62.1，Apache-2.0，https://github.com/microsoft/playwright |

运行依赖在 package-lock.json 固定。浏览器产物随附许可证文件，仓库中的 licenses 目录保留上游声明。MoonBit 原生计算与宿主密码组件的职责分别记载于各工具文档。

sdcTable 为 GPL 许可的 R 项目，此处仅参考其统计披露控制的问题定义，没有移植或依赖其源码。Tumult Analytics 用作按人贡献和多表关联的设计参考，没有复制其源码。Prio 用于说明多服务秘密分享聚合的研究背景；本项目有限原型不实现其恶意客户端证明体系。
