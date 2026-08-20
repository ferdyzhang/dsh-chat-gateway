# dsh-chat-gateway

[![npm version](https://img.shields.io/npm/v/dsh-chat-gateway)](https://www.npmjs.com/package/dsh-chat-gateway)

DSH 多通道消息网关插件：把 钉钉 / 飞书 / 企业微信 / QQ 的机器人消息统一交给一个 dsh agent 处理并回复。配置全部在 Web 设置页独立的一级栏目「消息通道」里完成。

## 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-chat-gateway

# 本地开发：直接用本包路径
dsh plugin --profile web add /path/to/dsh-chat-gateway

# 重启
dsh web
```

## 通道与配置

| 通道 | 接入方式 | 需要公网 | 凭据 |
|---|---|---|---|
| 钉钉 | 自定义机器人 Stream 模式（WebSocket） | 否 | AppKey / AppSecret |
| 飞书 | 开放平台企业自建应用·长连接（WebSocket） | 否 | App ID / App Secret |
| 企业微信 | 自建应用回调（本地 HTTP 服务） | 是（回调 URL） | corpid / AgentId / Secret / Token / EncodingAESKey |
| QQ | OneBot 11 反向 WebSocket（NapCat/LLOneBot） | 否 | 无（只配端口；可选 access token） |

所有通道共享同一组 agent 运行环境设置（工作区 / 预设 / 模型 / provider）。

## 企业微信回调说明

插件在本机监听 `127.0.0.1:<回调端口>/wecom`，你需要用反向代理把公网地址转发过来，并在企业微信管理后台把回调 URL 填为 `http://<公网地址>/wecom`。GET 用于 URL 验证（echostr），POST 用于接收消息（AES 解密后交给 agent，回复走 message/send API）。

## 受信代理远程桥（远程浏览器配置）

DSH 的设置存储默认只对本机（localhost）浏览器开放：远程打开设置页时，「消息通道」一栏会自动进入「远程桥」模式。要让远程浏览器也能读写本插件配置，在**本机**打开设置页 → 消息通道 → 「受信代理远程桥」卡片：

1. 生成一个高熵令牌并写入环境变量，启动 dsh 时注入：
   ```bash
   export DSH_CHAT_GATEWAY_BRIDGE_TOKEN='<随机长字符串>'
   dsh web
   ```
2. 反向代理把 `/chat-gateway-bridge/*` 转发到 `127.0.0.1:<dsh端口>`，并替换注入令牌头。Caddy 示例：
   ```caddyfile
   dsh.example.com {
       reverse_proxy 127.0.0.1:3080 {
           header_up Host dsh.example.com
           header_up X-Dsh-Chat-Gateway-Bridge-Token {$DSH_CHAT_GATEWAY_BRIDGE_TOKEN}
       }
   }
   ```
3. 在桥卡片里填「受信代理 Host」（`dsh.example.com`）、「令牌环境变量名」，勾选启用。

安全模型：桥只接受「回环来源 + Host 命中 + 令牌匹配」的请求，且只服务本插件的 `im-gateway-*` 命名空间（不含桥自身的开关——桥只能在本机改）；令牌只存在服务端环境变量，浏览器永远拿不到；设置读回时所有 secret 字段被剥离，写回时才允许更新。

## 安全说明

- 所有凭据以 `role('secret')` 存储：设置页不回显，界面留空即保持不变。
- 企业微信回调仅监听本机回环地址；公网暴露由你自己的反向代理负责。回调强制校验 msg_signature（缺失或错误直接拒绝）。
- QQ 反向 WS 仅监听本机回环地址，且拒绝带非回环 Origin 的连接（防浏览器跨域 WS 注入）；配置 access token 后还会校验 OneBot 11 标准的 `Authorization: Bearer` / `?access_token=`。
