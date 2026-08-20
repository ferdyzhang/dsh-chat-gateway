// dsh-chat-gateway 主机半（host half）。
//
// 一个共享 agent 驱动器 + 四条消息通道适配器：
//   - 钉钉：Stream 模式（WebSocket 长连接，clientId/clientSecret）
//   - 飞书：开放平台企业自建应用·长连接（WebSocket，appId/appSecret）
//   - 企业微信：自建应用回调（本地 HTTP 回调服务，corpId/agentId/secret/token/encodingAesKey）
//   - QQ：OneBot 11 协议反向 WebSocket（本地 WS 服务端，NapCat/LLOneBot 接入）
//
// 配置：每通道一个扁平命名空间（im-gateway-<channel>），另加 im-gateway-agent
// 存放共享的 agent 运行环境。用扁平命名空间是因为 DSH 设置客户端 API 只能
// 单层 set(field, value)：嵌套对象会被整体替换，从而冲掉只写 secret。
import z from "schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const GUIDANCE = "本机已安装 dsh-chat-gateway 插件（多通道消息机器人）：在 Web 设置页「消息通道」一栏配置钉钉 / 飞书 / 企业微信 / QQ 任一通道后，对应 IM 里的 @机器人 或单聊消息会交给一个 dsh agent 处理并回复。能力：真实 agent 对话，每个会话（群聊 / 单聊）各自独立维护历史（按 conversationId / chat_id / ChatId / group_id 隔离，空闲 30 分钟释放）；可配工作区 / agent 预设 / 模型。配置存设置页（namespace im-gateway-*，secret 走 role('secret') 只写不回显）。限制：钉钉需机器人开启 Stream 模式；飞书需企业自建应用并订阅 im.message.receive_v1 长连接事件；企业微信需自建应用回调并暴露公网回调 URL；QQ 走 OneBot 11 反向 WebSocket（如 NapCat/LLOneBot）。用户提到「消息通道 / IM 机器人 / 钉钉机器人 / 飞书机器人 / 企业微信机器人 / QQ 机器人」时即指本插件，请据此协作。";

const NS_DINGTALK = settingsNamespace("im-gateway-dingtalk");
const NS_FEISHU = settingsNamespace("im-gateway-feishu");
const NS_WECOM = settingsNamespace("im-gateway-wecom");
const NS_QQ = settingsNamespace("im-gateway-qq");
const NS_AGENT = settingsNamespace("im-gateway-agent");
const SECTION_ORDER = 200;

const DingtalkConfig = z.object({
  enabled: z.boolean().default(false).description("启用钉钉通道"),
  clientId: z.string().default("").description("机器人 AppKey（Stream 模式）"),
  clientSecret: z.string().role("secret").default("").description("机器人 AppSecret（Stream 模式）"),
});

const FeishuConfig = z.object({
  enabled: z.boolean().default(false).description("启用飞书通道"),
  appId: z.string().default("").description("App ID（cli_ 开头）"),
  appSecret: z.string().role("secret").default("").description("App Secret"),
});

const WecomConfig = z.object({
  enabled: z.boolean().default(false).description("启用企业微信通道"),
  corpId: z.string().default("").description("企业 ID（corpid）"),
  agentId: z.string().default("").description("自建应用 AgentId"),
  secret: z.string().role("secret").default("").description("自建应用 Secret"),
  token: z.string().role("secret").default("").description("回调 Token（管理后台自填）"),
  encodingAesKey: z.string().role("secret").default("").description("回调 EncodingAESKey（43 位）"),
  port: z.number().default(8787).description("回调监听端口（本机）"),
});

const QqConfig = z.object({
  enabled: z.boolean().default(false).description("启用 QQ 通道"),
  port: z.number().default(6700).description("OneBot 反向 WebSocket 服务端口"),
});

const AgentConfig = z.object({
  workspace: z.string().default("").description("agent 工作目录（留空用首个已注册工作区）"),
  agentPreset: z.string().default("").description("agent preset id（留空用全局）"),
  model: z.string().default("").description("模型 id（留空用运行时默认）"),
  provider: z.string().default("").description("provider（留空用运行时默认）"),
});

// 行级 Config（cordis.patch.yml 的行不携带 config，仅作占位）
const Config = z.object({});

const inject = ["agents", "systemPrompt"];

function apply(ctx, config) {
  const agents = ctx.agents;
  const agentPresets = ctx.get("agentPresets");
  const workspaceRegistry = ctx.get("workspaceRegistry");

  const sources = {};

  const current = () => ({
    dingtalk: sources[NS_DINGTALK]?.() || {},
    feishu: sources[NS_FEISHU]?.() || {},
    wecom: sources[NS_WECOM]?.() || {},
    qq: sources[NS_QQ]?.() || {},
    agent: sources[NS_AGENT]?.() || {},
  });

  function log(msg) {
    ctx.logger?.info?.("[dsh-chat-gateway] " + msg);
  }
  function warn(msg) {
    ctx.logger?.warn?.("[dsh-chat-gateway] " + msg);
  }

  function defaultWorkspace() {
    try {
      if (workspaceRegistry && typeof workspaceRegistry.list === "function") {
        const ws = workspaceRegistry.list();
        if (ws && ws.length && typeof ws[0].path === "string") return ws[0].path;
      }
    } catch (e) { /* ignore */ }
    return process.cwd();
  }

  function cfg() {
    const c = current();
    return {
      agent: {
        workspace: (c.agent && c.agent.workspace) || defaultWorkspace(),
        agentPreset: (c.agent && c.agent.agentPreset) || "",
        model: (c.agent && c.agent.model) || "",
        provider: (c.agent && c.agent.provider) || "",
      },
      dingtalk: {
        enabled: c.dingtalk.enabled === true,
        clientId: c.dingtalk.clientId || "",
        clientSecret: c.dingtalk.clientSecret || "",
      },
      feishu: {
        enabled: c.feishu.enabled === true,
        appId: c.feishu.appId || "",
        appSecret: c.feishu.appSecret || "",
      },
      wecom: {
        enabled: c.wecom.enabled === true,
        corpId: c.wecom.corpId || "",
        agentId: c.wecom.agentId || "",
        secret: c.wecom.secret || "",
        token: c.wecom.token || "",
        encodingAesKey: c.wecom.encodingAesKey || "",
        port: Number.isFinite(c.wecom.port) ? c.wecom.port : 8787,
      },
      qq: {
        enabled: c.qq.enabled === true,
        port: Number.isFinite(c.qq.port) ? c.qq.port : 6700,
      },
    };
  }

  // ================= 共享 agent 驱动器（按会话隔离） =================
  // 每个会话键（钉钉 conversationId / 飞书 chat_id / 企业微信 ChatId 或
  // FromUserName / QQ group_id 或 user_id）对应一个独立 agent session，
  // 群聊与单聊互不串历史。会话空闲 TTL 后释放，总数超上限时淘汰最久未用的。
  const sessions = new Map(); // convId -> { agent, handle, lastUsed }
  const queues = new Map();   // convId -> Promise（同会话消息排队，异会话并行）
  let messageSeq = 0;
  let sessionSeq = 0;
  const MAX_SESSIONS = 20;
  const SESSION_TTL_MS = 30 * 60 * 1000;

  function disposeSessionEntry(entry) {
    if (!entry) return;
    try { entry.handle?.dispose(); } catch (e) { /* ignore */ }
  }

  function makeUserMessage(text) {
    messageSeq++;
    return {
      id: "im-gateway-" + Date.now() + "-" + messageSeq,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    };
  }

  function extractReply(msgs, start) {
    let out = "";
    for (let i = start; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m || m.role !== "assistant") continue;
      let parts = "";
      for (const b of m.content || []) {
        if (b && b.type === "text" && b.text) parts += b.text;
      }
      if (parts) out = parts;
    }
    return out;
  }

  async function createAgent(convId) {
    const c = cfg().agent;
    const defaultModel = ctx.get("agentDefaultModel");

    // 可变模型选择：优先用插件配置的模型，否则回退到全局「默认模型」。
    // 必须绑定，否则引用了 {{model}} 的 persona 提示段装配会报
    // "prompt variable {{model}} has no value"。
    let picked;
    const selection = {
      get current() {
        if (picked !== undefined) return picked;
        if (c.provider && c.model) return { provider: c.provider, model: c.model };
        if (defaultModel && typeof defaultModel.currentSelection === "function") {
          try { return defaultModel.currentSelection(); } catch (e) { /* ignore */ }
        }
        return undefined;
      },
      set current(next) { picked = next; },
      assembled: undefined,
    };

    const sel = selection.current;
    const safe = String(convId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "x";
    sessionSeq++;
    const sessionId = "im-gateway-" + safe + "-" + sessionSeq.toString(36) + "-" + Date.now().toString(36);
    const meta = { cwd: c.workspace };
    if (c.agentPreset) meta.agentPreset = c.agentPreset;
    const agentOptions = {};
    if (sel && sel.provider) agentOptions.provider = sel.provider;
    if (sel && sel.model) agentOptions.model = sel.model;
    if (!agentOptions.model) warn("im-gateway: no model selection (plugin config and default model are both unset); persona variables may fail");

    const setup = async (agentCtx) => {
      // 与官方 Web 会话一致：先装模型选择，再挂 agent 预设。
      installModelSelection(agentCtx, selection);
      if (c.agentPreset && agentPresets && typeof agentPresets.mount === "function") {
        await agentPresets.mount(agentCtx, c.agentPreset);
      }
    };
    const handle = await agents.create({ sessionId, meta, agentOptions, setup });
    log("im-gateway: session created for conversation \"" + safe + "\" (" + sessionId + ")");
    return handle;
  }

  async function getAgentFor(convId) {
    const now = Date.now();
    // 清理空闲过期的会话
    for (const [key, entry] of sessions) {
      if (now - entry.lastUsed > SESSION_TTL_MS) {
        disposeSessionEntry(entry);
        sessions.delete(key);
        queues.delete(key);
      }
    }
    const existing = sessions.get(convId);
    if (existing) {
      existing.lastUsed = now;
      return existing.agent;
    }
    // 超上限时淘汰最久未用的会话
    if (sessions.size >= MAX_SESSIONS) {
      let oldestKey;
      let oldestTime = Infinity;
      for (const [key, entry] of sessions) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) {
        disposeSessionEntry(sessions.get(oldestKey));
        sessions.delete(oldestKey);
        queues.delete(oldestKey);
      }
    }
    const handle = await createAgent(convId);
    sessions.set(convId, { agent: handle.agent, handle, lastUsed: Date.now() });
    return handle.agent;
  }

  async function chatOnce(convId, msg) {
    const a = await getAgentFor(convId);
    const start = a.session.deriveMessages().length;
    a.followup(makeUserMessage(msg.text));
    await a.whenIdle();
    const msgs = a.session.deriveMessages();
    let reply = extractReply(msgs, start);
    if (!reply) reply = "(未生成回复)";
    try {
      await msg.reply(reply);
    } catch (e) {
      warn("reply failed: " + (e?.message || String(e)));
    }
  }

  function enqueue(convId, msg) {
    const prev = queues.get(convId) || Promise.resolve();
    const next = prev.then(() => chatOnce(convId, msg).catch((e) => {
      warn("chat failed [" + convId + "]: " + (e?.message || String(e)));
      msg.reply("(处理出错)").catch(() => {});
    }));
    queues.set(convId, next);
  }

  /** 通道统一入口：onMessage({ convId, text, senderNick, reply }) */
  const inbound = (m) => enqueue(String(m.convId ?? "default"), {
    text: String(m.text ?? ""),
    senderNick: String(m.senderNick ?? ""),
    reply: m.reply,
  });

  // ================= 钉钉（Stream 模式） =================
  function createDingtalkChannel() {
    const GATEWAY = "https://api.dingtalk.com/v1.0/gateway/connections/open";
    const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";
    let socket = null;
    let reconnectTimer = null;
    let reconnectDelay = 1000;
    let closed = true;

    function teardown() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (socket) { try { socket.close(); } catch (e) { /* ignore */ } socket = null; }
    }

    function scheduleReconnect(startFn) {
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startFn().catch(() => {});
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    }

    async function connect(cfg, onMessage) {
      const res = await fetch(GATEWAY, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
          ua: "dsh-chat-gateway/0.1.0",
          subscriptions: [
            { type: "EVENT", topic: "*" },
            { type: "CALLBACK", topic: TOPIC_ROBOT },
          ],
        }),
      });
      if (!res.ok) throw new Error("dingtalk gateway register http " + res.status);
      const ep = await res.json();
      if (!ep.endpoint || !ep.ticket) throw new Error("dingtalk gateway returned no endpoint/ticket");

      await new Promise((resolve, reject) => {
        let s;
        try {
          s = new WebSocket(ep.endpoint + "?ticket=" + encodeURIComponent(ep.ticket));
        } catch (e) {
          reject(e);
          return;
        }
        socket = s;
        let opened = false;
        s.onopen = () => {
          opened = true;
          reconnectDelay = 1000;
          log("dingtalk: connected");
          resolve();
        };
        s.onmessage = (ev) => {
          let raw = "";
          if (typeof ev.data === "string") raw = ev.data;
          else if (ev.data && typeof ev.data.toString === "function") raw = ev.data.toString();
          if (!raw) return;
          let msg;
          try { msg = JSON.parse(raw); } catch (e) { return; }
          if (!msg || typeof msg !== "object") return;
          const headers = msg.headers || {};
          const topic = headers.topic || "";
          const ack = (dataObj) => {
            if (socket && socket.readyState === 1) {
              try {
                socket.send(JSON.stringify({
                  code: 200,
                  message: "OK",
                  headers: { contentType: "application/json", messageId: headers.messageId },
                  data: JSON.stringify(dataObj),
                }));
              } catch (e) { /* ignore */ }
            }
          };
          if (msg.type === "SYSTEM") {
            if (topic === "ping" || topic === "disconnect") {
              let d = {};
              try { if (msg.data) d = JSON.parse(msg.data); } catch (e) { /* ignore */ }
              ack(d);
            }
            return;
          }
          if (msg.type === "CALLBACK" && topic === TOPIC_ROBOT) {
            ack({ response: null });
            let data;
            try { data = JSON.parse(msg.data); } catch (e) { return; }
            if (data && data.msgtype === "text" && data.text && data.text.content) {
              onMessage({
                // 群聊与单聊的 conversationId 不同 → 各自独立 agent session
                convId: "dingtalk:" + (data.conversationId || data.sessionWebhook || "unknown"),
                text: data.text.content,
                senderNick: data.senderNick || "",
                reply: (text) => sendDingtalkReply(data.sessionWebhook, text),
              });
            }
            return;
          }
          if (msg.type === "EVENT") {
            ack({ status: "SUCCESS" });
          }
        };
        s.onclose = () => {
          if (socket === s) socket = null;
          if (opened) scheduleReconnect(() => start(cfg, onMessage));
          else reject(new Error("dingtalk ws closed before open"));
        };
        s.onerror = (err) => {
          if (!opened) reject(err || new Error("dingtalk ws error"));
        };
      });
    }

    async function sendDingtalkReply(webhook, text) {
      if (!webhook) return;
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
      });
      if (!res.ok) warn("dingtalk reply http " + res.status);
    }

    return {
      start(cfg, onMessage) {
        closed = false;
        connect(cfg, onMessage).catch((e) => {
          warn("dingtalk connect failed: " + (e?.message || String(e)));
          scheduleReconnect(() => start(cfg, onMessage));
        });
      },
      stop: teardown,
    };
  }

  // ================= 飞书（开放平台长连接） =================
  function createFeishuChannel() {
    const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
    const WS_URL = "wss://open.feishu.cn/event";
    let socket = null;
    let reconnectTimer = null;
    let reconnectDelay = 1000;
    let closed = true;

    function teardown() {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (socket) { try { socket.close(); } catch (e) { /* ignore */ } socket = null; }
    }

    function scheduleReconnect(startFn) {
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startFn().catch(() => {});
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    }

    async function getToken(cfg) {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
      });
      const data = await res.json();
      if (!data || data.code !== 0 || !data.tenant_access_token) {
        throw new Error("feishu tenant_access_token failed: " + ((data && data.msg) || res.status));
      }
      return data.tenant_access_token;
    }

    async function sendFeishuReply(token, messageId, text) {
      const res = await fetch("https://open.feishu.cn/open-apis/im/v1/messages/" + encodeURIComponent(messageId) + "/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) }),
      });
      if (!res.ok) warn("feishu reply http " + res.status);
    }

    async function connect(cfg, onMessage) {
      const token = await getToken(cfg);
      await new Promise((resolve, reject) => {
        let s;
        try {
          s = new WebSocket(WS_URL);
        } catch (e) {
          reject(e);
          return;
        }
        socket = s;
        let opened = false;
        s.onopen = () => {
          opened = true;
          reconnectDelay = 1000;
          // 长连接登录帧：携带 tenant_access_token
          s.send(JSON.stringify({ type: "login", data: { tenant_access_token: token } }));
          log("feishu: connected");
          resolve();
        };
        s.onmessage = (ev) => {
          let frame;
          try { frame = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch (e) { return; }
          if (!frame || typeof frame !== "object") return;
          if (frame.type === "ping") {
            try { s.send(JSON.stringify({ type: "pong" })); } catch (e) { /* ignore */ }
            return;
          }
          if (frame.type === "event") {
            const header = frame.data?.header || {};
            if (header.event_type !== "im.message.receive_v1") return;
            const message = frame.data?.event?.message;
            if (!message || message.msg_type !== "text") return;
            let text = "";
            try { text = JSON.parse(message.content).text || ""; } catch (e) { return; }
            if (!text) return;
            onMessage({
              // chat_id 全局唯一：p2p 与群聊各不相同 → 独立 agent session
              convId: "feishu:" + (message.chat_id || "unknown"),
              text,
              senderNick: "",
              reply: (replyText) => sendFeishuReply(token, message.message_id, replyText),
            });
          }
        };
        s.onclose = () => {
          if (socket === s) socket = null;
          if (opened) scheduleReconnect(() => start(cfg, onMessage));
          else reject(new Error("feishu ws closed before open"));
        };
        s.onerror = (err) => {
          if (!opened) reject(err || new Error("feishu ws error"));
        };
      });
    }

    return {
      start(cfg, onMessage) {
        closed = false;
        connect(cfg, onMessage).catch((e) => {
          warn("feishu connect failed: " + (e?.message || String(e)));
          scheduleReconnect(() => start(cfg, onMessage));
        });
      },
      stop: teardown,
    };
  }

  // ================= 企业微信（自建应用回调） =================
  function createWecomChannel() {
    let server = null;
    let tokenCache = null;

    const aesKey = (enc) => Buffer.from(String(enc) + "=", "base64");

    function wecomSignature(token, timestamp, nonce, encrypt) {
      return crypto.createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
    }

    function decrypt(encrypted, key) {
      const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.slice(0, 16));
      decipher.setAutoPadding(false);
      let buf = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
      const pad = buf[buf.length - 1];
      if (pad > 0 && pad <= 32) buf = buf.slice(0, buf.length - pad);
      if (buf.length < 20) throw new Error("wecom decrypt: payload too short");
      const msgLen = buf.readUInt32BE(16);
      if (20 + msgLen > buf.length) throw new Error("wecom decrypt: bad length");
      return buf.slice(20, 20 + msgLen).toString("utf8");
    }

    async function getAccessToken(cfg) {
      if (tokenCache && tokenCache.expires > Date.now()) return tokenCache.token;
      const res = await fetch("https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=" + encodeURIComponent(cfg.corpId) + "&corpsecret=" + encodeURIComponent(cfg.secret));
      const data = await res.json();
      if (!data || !data.access_token) throw new Error("wecom gettoken failed: " + ((data && data.errmsg) || res.status));
      tokenCache = { token: data.access_token, expires: Date.now() + ((data.expires_in || 7200) - 300) * 1000 };
      return data.access_token;
    }

    async function sendWecomReply(cfg, userId, text) {
      const token = await getAccessToken(cfg);
      const res = await fetch("https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: userId,
          msgtype: "text",
          agentid: Number(cfg.agentId) || 0,
          text: { content: text },
        }),
      });
      const data = await res.json();
      if (!data || data.errcode !== 0) warn("wecom reply failed: " + ((data && data.errmsg) || res.status));
    }

    function start(cfg, onMessage) {
      const port = cfg.port || 8787;
      server = http.createServer((req, res) => {
        let path;
        try { path = new URL(req.url, "http://127.0.0.1").pathname; } catch (e) { path = "/"; }
        if (path !== "/wecom" && path !== "/") {
          res.writeHead(404).end();
          return;
        }
        const params = Object.fromEntries(new URL(req.url, "http://127.0.0.1").searchParams);
        const key = aesKey(cfg.encodingAesKey);

        if (req.method === "GET") {
          const { msg_signature, timestamp, nonce, echostr } = params;
          if (!msg_signature || !timestamp || !nonce || !echostr) { res.writeHead(400).end(); return; }
          if (wecomSignature(cfg.token, timestamp, nonce, echostr) !== msg_signature) { res.writeHead(403).end(); return; }
          try {
            res.writeHead(200, { "Content-Type": "text/plain" }).end(decrypt(echostr, key));
          } catch (e) {
            warn("wecom url verify failed: " + e.message);
            res.writeHead(500).end();
          }
          return;
        }

        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1048576) req.destroy();
          });
          req.on("end", () => {
            try {
              const m = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
              if (!m) { res.writeHead(400).end(); return; }
              const encrypt = m[1];
              if (params.msg_signature && wecomSignature(cfg.token, params.timestamp, params.nonce, encrypt) !== params.msg_signature) {
                res.writeHead(403).end();
                return;
              }
              const plain = decrypt(encrypt, key);
              // 先应答，避免企业微信重试
              res.writeHead(200).end("");
              const fromUser = (plain.match(/<FromUserName><!\[CDATA\[(.*?)\]\]><\/FromUserName>/) || [])[1];
              const chatId = (plain.match(/<ChatId><!\[CDATA\[(.*?)\]\]><\/ChatId>/) || [])[1];
              const msgType = (plain.match(/<MsgType><!\[CDATA\[(.*?)\]\]><\/MsgType>/) || [])[1];
              const content = (plain.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/) || [])[1];
              if (msgType === "text" && content && fromUser) {
                onMessage({
                  // 群聊消息带 ChatId → 按群建会话；单聊无 ChatId → 按用户建会话
                  convId: "wecom:" + (chatId || fromUser),
                  text: content,
                  senderNick: fromUser,
                  reply: (text) => sendWecomReply(cfg, fromUser, text),
                });
              }
            } catch (e) {
              warn("wecom callback failed: " + (e?.message || String(e)));
              if (!res.headersSent) res.writeHead(200).end("");
            }
          });
          return;
        }

        res.writeHead(405).end();
      });
      server.on("error", (e) => warn("wecom callback server error: " + (e?.message || String(e))));
      server.listen(port, "127.0.0.1", () => log("wecom: callback listening on http://127.0.0.1:" + port + "/wecom"));
    }

    function stop() {
      if (server) { try { server.close(); } catch (e) { /* ignore */ } server = null; }
      tokenCache = null;
    }

    return { start, stop };
  }

  // ================= QQ（OneBot 11 反向 WebSocket） =================
  function createQqChannel() {
    let wss = null;
    const pending = new Map();

    function start(cfg, onMessage) {
      const port = cfg.port || 6700;
      wss = new WebSocketServer({ host: "127.0.0.1", port }, () => {
        log("qq: onebot ws server on ws://127.0.0.1:" + port + "/");
      });
      wss.on("error", (e) => warn("qq ws server error: " + (e?.message || String(e))));
      wss.on("connection", (socket) => {
        log("qq: onebot client connected");
        socket.on("message", (data) => {
          let payload;
          try { payload = JSON.parse(data.toString()); } catch (e) { return; }
          if (payload && payload.post_type === "message") {
            const isGroup = payload.message_type === "group";
            let text = "";
            if (typeof payload.raw_message === "string") text = payload.raw_message.trim();
            if (!text && Array.isArray(payload.message)) {
              text = payload.message.filter((s) => s && s.type === "text").map((s) => (s.data && s.data.text) || "").join("").trim();
            }
            if (!text) return;
            onMessage({
              // 群聊按 group_id、私聊按 user_id 建独立 agent session
              convId: (isGroup ? "qq-group:" : "qq-private:") + (isGroup ? payload.group_id : payload.user_id),
              text,
              senderNick: (payload.sender && (payload.sender.nickname || payload.sender.user_id)) || "",
              reply: (replyText) => new Promise((resolve, reject) => {
                const echo = "dsh-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
                const timeout = setTimeout(() => {
                  pending.delete(echo);
                  reject(new Error("onebot send_msg timeout"));
                }, 15000);
                pending.set(echo, (resp) => {
                  clearTimeout(timeout);
                  resolve(resp);
                });
                try {
                  socket.send(JSON.stringify({
                    action: "send_msg",
                    params: {
                      message_type: isGroup ? "group" : "private",
                      ...(isGroup ? { group_id: payload.group_id } : { user_id: payload.user_id }),
                      message: [{ type: "text", data: { text: replyText } }],
                    },
                    echo,
                  }));
                } catch (e) {
                  clearTimeout(timeout);
                  pending.delete(echo);
                  reject(e);
                }
              }),
            });
            return;
          }
          if (payload && payload.echo && pending.has(payload.echo)) {
            pending.get(payload.echo)(payload);
            pending.delete(payload.echo);
          }
        });
        socket.on("close", () => log("qq: onebot client disconnected"));
        socket.on("error", (e) => warn("qq socket error: " + (e?.message || String(e))));
      });
    }

    function stop() {
      if (wss) { try { wss.close(); } catch (e) { /* ignore */ } wss = null; }
      pending.clear();
    }

    return { start, stop };
  }

  // ================= 通道实例 + 同步 =================
  const dingtalk = createDingtalkChannel();
  const feishu = createFeishuChannel();
  const wecom = createWecomChannel();
  const qq = createQqChannel();

  let disposeSection;
  const sync = () => {
    dingtalk.stop();
    feishu.stop();
    wecom.stop();
    qq.stop();
    disposeSection?.();
    disposeSection = undefined;

    const c = cfg();
    let anyEnabled = false;

    if (c.dingtalk.enabled && c.dingtalk.clientId && c.dingtalk.clientSecret) {
      anyEnabled = true;
      dingtalk.start(c.dingtalk, inbound);
    }
    if (c.feishu.enabled && c.feishu.appId && c.feishu.appSecret) {
      anyEnabled = true;
      feishu.start(c.feishu, inbound);
    }
    if (c.wecom.enabled && c.wecom.corpId && c.wecom.secret && c.wecom.encodingAesKey) {
      anyEnabled = true;
      wecom.start(c.wecom, inbound);
    }
    if (c.qq.enabled) {
      anyEnabled = true;
      qq.start(c.qq, inbound);
    }

    if (anyEnabled) {
      disposeSection = ctx.systemPrompt.section({
        name: "plugin:im-gateway",
        order: SECTION_ORDER,
        text: GUIDANCE,
      });
    }
  };

  const registrations = [
    [NS_DINGTALK, DingtalkConfig],
    [NS_FEISHU, FeishuConfig],
    [NS_WECOM, WecomConfig],
    [NS_QQ, QqConfig],
    [NS_AGENT, AgentConfig],
  ];
  for (const [ns, schema] of registrations) {
    installSettingsSection(ctx, ns, schema, {}, {
      setSource: (src) => { sources[ns] = src; },
      onChange: sync,
    });
  }
  sync();

  ctx.effect(() => () => {
    dingtalk.stop();
    feishu.stop();
    wecom.stop();
    qq.stop();
    disposeSection?.();
    disposeSection = undefined;
    for (const entry of sessions.values()) disposeSessionEntry(entry);
    sessions.clear();
    queues.clear();
  });
}

export { Config, apply, inject };
