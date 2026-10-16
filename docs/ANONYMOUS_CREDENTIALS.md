# 匿名参与凭证

资格签发方验证已登记账号，一次签发；参与者本地盲化、解盲；收卷方验证凭证，一次兑换。签发端不接收答案或解盲后的凭证，收卷端不接收账号或领证秘密。凭证绑定整份问卷配置和共同到期时间。

底层使用 @cloudflare/blindrsa-ts 0.4.6 的 RFC 9474 RSABSSA-SHA384-PSS-Randomized，RSA 3072 位。没有自写 RSA 或声称发明盲签名。MoonBit 校验公共上下文与受保护回答，JavaScript 负责标准密码库、文件、独立角色服务与 SQLite 事务。

## 文件流程

运行 `node cli/privacy.mjs --help` 查看完整命令。组织者预先核验资格，将账号名称数组交给 `init-issuer`，得到签发库、公开配置、私有资格列表。每个资格项含账号和安全随机的领证秘密；应通过已认证渠道分别交给对应参与者，不能公开整份列表。

参与者用 `prepare-credential` 生成签发请求与私有状态。仅请求交给签发方；私有状态保留在自己的设备。签发方用 `issue-credential` 验证账号与领证秘密；返回签名响应。参与者用 `finalize-credential` 得到凭证，随后用现有问卷流程生成受保护回答。收卷方用 `redeem-credential` 验证并保存，最终 `export-collected` 导出受保护回答集合。

不将 token、私有状态、领证秘密或原始答案写入普通日志。私有文件不应放入公开仓库。文件创建设置 0600，但不将此解释为跨平台完整磁盘加密或 Windows ACL 隔离。

## 独立服务

```sh
node scripts/protocol-service.mjs issuer private-data/issuer.sqlite 4191
node scripts/protocol-service.mjs collector private-data/collector.sqlite 4192
```

签发端只接受 `POST /issue`，消息为 `{account, secret, request}`。收卷端只接受 `POST /redeem`，消息为 `{token, response}`。请求使用 `Content-Type: application/json`。服务仅绑定 127.0.0.1，拒绝跨站浏览器请求，不提供远程部署或 TLS。二者可以在独立进程和独立存储中运行，测试确实通过两个进程交换消息；同机演示不能代表真实的组织与管理员隔离。

同一账号对同一个盲化请求重试返回原签名；不同请求被拒绝。同一凭证对同一回答重试返回原回执；试图替换回答被拒绝。回执与受保护回答在事务中保存；重复和并发请求不会增加有效回答数量。凭证到期后拒绝新兑换，也拒绝通过已到期凭证访问旧回执。

## 保护条件

保护签发协议与兑换凭证之间的关联。IP、时间、小群体、文件传送渠道和浏览器指纹仍可造成关联。所有参与者应核对同一份公开配置与公钥，不能接受每个人专属的公钥或上下文。客户端和资格核验方须可信，公开配置须通过可信渠道分发。

限制的是经过核验的账号与凭证，不自动证明一个自然人只有一个账号，不防凭证转让，也不防签发方违规多发。账户列表由部署方审核；这里没有实现校园 SSO 或身份提供方接入。此原型未经独立密码安全审计。

## 差异

moon_scrub 处理内容，moon-privacy-budget 管理统计查询与预算。本模块新增收集之前的资格与不可关联凭证流程：账号限领、问卷绑定、受保护回答校验、原子兑换和重试回执。它不是原有响应 ID 去重的改名，也不把仅仅不显示姓名称为匿名协议。

参考：https://www.rfc-editor.org/rfc/rfc9474.html

参考：https://www.rfc-editor.org/rfc/rfc9576.html
