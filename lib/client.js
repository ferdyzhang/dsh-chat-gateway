// dsh-chat-gateway 浏览器半（client half）。
//
// 注册独立的一级设置栏「消息通道」（settings.section 槽位），渲染四张通道
// 卡片（钉钉 / 飞书 / 企业微信 / QQ）加一张共享的「Agent 运行环境」卡片。
// host 半注册 im-gateway-* 五个扁平命名空间；每张卡片绑定自己的 scope，
// 只写变更字段（secret 只写不回显，留空保持不变）。
window.__ModuleLoader__.load({
  id: "dsh-chat-gateway",
  factory: (require) => {
    const React = require("react");

    const NS_DINGTALK = "im-gateway-dingtalk";
    const NS_FEISHU = "im-gateway-feishu";
    const NS_WECOM = "im-gateway-wecom";
    const NS_QQ = "im-gateway-qq";
    const NS_AGENT = "im-gateway-agent";
    const NS_BRIDGE = "im-gateway-bridge";
    const SECTION_ID = "im-gateway";
    const BRIDGE_PATH = "/chat-gateway-bridge";

    const T = {
      text: "var(--dsw-alias-label-primary, #e7e7e9)",
      textDim: "var(--dsw-alias-label-tertiary, #8b8b91)",
      border: "var(--dsw-alias-border-l2, rgba(255,255,255,0.10))",
      card: "var(--dsw-alias-bg-layer-3, #1b1b1f)",
      cardHi: "var(--dsw-alias-bg-layer-2, #232327)",
      brand: "var(--dsw-alias-brand-primary, #3b82f6)",
      ok: "#22c55e",
      off: "#8b8b91",
    };

    // 每个通道的字段定义
    const CHANNELS = [
      {
        ns: NS_DINGTALK,
        id: "dingtalk",
        icon: "📌",
        title: "钉钉",
        desc: "自定义机器人（Stream 模式），@机器人 / 单聊消息交给 agent 回复。",
        setup:
          "钉钉开放平台 → 创建机器人 → 开启 Stream 模式，把 AppKey/AppSecret 填进来即可，无需公网。",
        fields: [
          { key: "clientId", label: "AppKey", hint: "Stream 模式机器人的 AppKey", placeholder: "粘贴机器人 AppKey" },
          { key: "clientSecret", kind: "secret", label: "AppSecret", hint: "只写字段：不回显当前值，留空即保持不变", placeholder: "粘贴机器人 AppSecret" },
        ],
      },
      {
        ns: NS_FEISHU,
        id: "feishu",
        icon: "🕊️",
        title: "飞书",
        desc: "开放平台企业自建应用（长连接模式），无需公网。",
        setup:
          "飞书开放平台 → 创建企业自建应用 → 添加「机器人」能力 → 事件订阅选「使用长连接接收事件」并添加 im.message.receive_v1 事件 → 填 App ID / App Secret。",
        fields: [
          { key: "appId", label: "App ID", hint: "cli_ 开头的应用凭证", placeholder: "如 cli_xxxxxxxx" },
          { key: "appSecret", kind: "secret", label: "App Secret", hint: "只写字段：不回显当前值，留空即保持不变", placeholder: "粘贴 App Secret" },
        ],
      },
      {
        ns: NS_WECOM,
        id: "wecom",
        icon: "💼",
        title: "企业微信",
        desc: "自建应用回调，双向收消息 + 回复。需要一个公网可达的回调地址。",
        setup:
          "企业微信管理后台 → 应用管理 → 自建应用：拿到企业ID(corpid)、AgentId、Secret；「接收消息」里填回调 Token 与 EncodingAESKey，并把回调 URL 设为 http://<公网地址>/wecom（用反向代理转发到本机 127.0.0.1:<回调端口>）。",
        fields: [
          { key: "corpId", label: "企业 ID（corpid）", placeholder: "如 ww1234567890abcdef" },
          { key: "agentId", label: "AgentId", placeholder: "如 1000002" },
          { key: "secret", kind: "secret", label: "应用 Secret", hint: "只写字段：不回显当前值", placeholder: "粘贴应用 Secret" },
          { key: "token", kind: "secret", label: "回调 Token", hint: "只写字段：与后台「接收消息」配置一致", placeholder: "粘贴回调 Token" },
          { key: "encodingAesKey", kind: "secret", label: "EncodingAESKey", hint: "只写字段：43 位", placeholder: "粘贴 EncodingAESKey" },
          { key: "port", kind: "number", label: "回调监听端口", hint: "本机监听 127.0.0.1 的端口，反向代理转发到这里", placeholder: "8787" },
        ],
      },
      {
        ns: NS_QQ,
        id: "qq",
        icon: "🐧",
        title: "QQ",
        desc: "OneBot 11 协议反向 WebSocket，配合 NapCat / LLOneBot 使用。",
        setup:
          "本地启动 NapCat/LLOneBot，把「反向 WebSocket」地址配成 ws://127.0.0.1:<端口>/，插件会自动接收私聊与群里 @机器人 的消息并回复。",
        fields: [
          { key: "port", kind: "number", label: "OneBot 反向 WS 端口", hint: "NapCat 里「反向 WebSocket」填 ws://127.0.0.1:此端口/", placeholder: "6700" },
        ],
      },
    ];

    const AGENT_FIELDS = [
      { key: "workspace", label: "工作目录", hint: "agent 运行的工作区，留空用首个已注册工作区", placeholder: "如 /Users/you/project" },
      { key: "agentPreset", label: "Agent 预设", hint: "预设 id，留空用全局默认", placeholder: "如 liangshen" },
      { key: "model", label: "模型", hint: "模型 id，留空用运行时默认", placeholder: "如 deepseek-v4-pro" },
      { key: "provider", label: "Provider", hint: "provider，留空用运行时默认", placeholder: "如 deepseek-official" },
    ];

    const BRIDGE_FIELDS = [
      { key: "enabled", kind: "bool", label: "启用受信代理远程桥" },
      { key: "trustedHosts", label: "受信代理 Host（逗号分隔）", hint: "必须与浏览器访问的 Host 完全一致（含非标准端口，如 dsh.example.com:8443），多个用逗号分隔；命中且带令牌才放行", placeholder: "dsh.example.com" },
      { key: "tokenEnv", label: "令牌环境变量名", hint: "服务端存放共享令牌的环境变量名（默认 DSH_CHAT_GATEWAY_BRIDGE_TOKEN）", placeholder: "DSH_CHAT_GATEWAY_BRIDGE_TOKEN" },
    ];

    const BRIDGE_SETUP =
      "服务端配置：1) 生成一个高熵令牌并写入环境变量（如 export DSH_CHAT_GATEWAY_BRIDGE_TOKEN=随机值，启动 dsh 时注入）；2) 反向代理把路径 " +
      BRIDGE_PATH +
      "/* 转发到 127.0.0.1:<dsh端口>，并替换注入请求头。Caddy 示例：reverse_proxy 127.0.0.1:3080 { header_up X-Dsh-Chat-Gateway-Bridge-Token {$DSH_CHAT_GATEWAY_BRIDGE_TOKEN} }。令牌只存在服务端，浏览器永远拿不到；桥只接受「回环来源 + Host 命中 + 令牌匹配」的请求，且只服务本插件的命名空间。";

    const SETTINGS_TEMPLATE = [
      "im-gateway-dingtalk:",
      "  enabled: false",
      '  clientId: ""',
      '  clientSecret: ""',
      "im-gateway-feishu:",
      "  enabled: false",
      '  appId: ""',
      '  appSecret: ""',
      "im-gateway-wecom:",
      "  enabled: false",
      '  corpId: ""',
      '  agentId: ""',
      '  secret: ""',
      '  token: ""',
      '  encodingAesKey: ""',
      "  port: 8787",
      "im-gateway-qq:",
      "  enabled: false",
      "  port: 6700",
      "im-gateway-agent:",
      '  workspace: ""',
      '  agentPreset: ""',
      '  model: ""',
      '  provider: ""',
    ].join("\n");

    function useScope(scope) {
      return React.useSyncExternalStore(
        (cb) => scope.subscribe(cb),
        () => scope.getSnapshot()
      );
    }

    function Badge({ enabled, label }) {
      const color = enabled ? T.ok : T.off;
      return React.createElement(
        "span",
        {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            color,
            background: "color-mix(in srgb, " + color + " 14%, transparent)",
            border: "1px solid color-mix(in srgb, " + color + " 35%, transparent)",
            whiteSpace: "nowrap",
          },
        },
        React.createElement("span", { style: { width: 7, height: 7, borderRadius: "50%", background: color } }),
        label || (enabled ? "已启用" : "未启用")
      );
    }

    function Field({ f, value, writable, onCommit }) {
      const isSecret = f.kind === "secret";
      const isNumber = f.kind === "number";
      const current =
        isNumber
          ? typeof value === "number"
            ? String(value)
            : ""
          : typeof value === "string"
            ? value
            : "";
      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        React.createElement("label", { style: { fontSize: 13, fontWeight: 600, color: T.text } }, f.label),
        React.createElement("input", {
          type: isSecret ? "password" : "text",
          inputMode: isNumber ? "numeric" : undefined,
          defaultValue: isSecret ? "" : current,
          placeholder: f.placeholder || "",
          disabled: !writable,
          onBlur: (e) => {
            const next = e.target.value;
            if (isSecret) {
              if (next !== "") onCommit(next);
            } else if (isNumber) {
              const n = Number(next.trim());
              if (next.trim() !== "" && Number.isFinite(n) && n >= 0) onCommit(n);
            } else if (next !== current) {
              onCommit(next);
            }
          },
          style: {
            boxSizing: "border-box",
            width: "100%",
            padding: "8px 10px",
            fontSize: 13,
            color: T.text,
            background: T.cardHi,
            border: "1px solid " + T.border,
            borderRadius: 8,
            outline: "none",
          },
        }),
        f.hint
          ? React.createElement("span", { style: { fontSize: 12, color: T.textDim, lineHeight: 1.4 } }, f.hint)
          : null
      );
    }

    function ChannelCard({ ch, scope }) {
      const snap = useScope(scope);
      if (snap.status === "loading") {
        return React.createElement("div", { style: { color: T.textDim, padding: 14 } }, "加载中…");
      }
      if (snap.status === "unavailable") {
        // 区分两种成因：远程浏览器（DSH 设置只对本机 loopback 开放）与
        // 命名空间未注册（host 半没加载）。
        if (snap.mode === "memory") {
          return React.createElement(
            "div",
            { style: { color: T.textDim, padding: 14, lineHeight: 1.6 } },
            "当前页面不是本机直连，DSH 的设置存储只对本机（localhost）浏览器开放。请直接在这台运行 dsh 的机器上打开设置页编辑，或手动编辑 ~/.dsh/settings.yaml 后重启。"
          );
        }
        return React.createElement(
          "div",
          { style: { color: T.textDim, padding: 14, lineHeight: 1.6 } },
          "配置命名空间未注册（插件 host 半可能加载失败）。可编辑 ~/.dsh/settings.yaml 的 im-gateway-* 段后重启。"
        );
      }
      const value = snap.value || {};
      const writable = snap.writable !== false;
      const enabled = value.enabled === true;
      const commit = (key) => (v) => scope.set(key, v);

      return React.createElement(
        "div",
        { style: { background: T.card, border: "1px solid " + T.border, borderRadius: 12, padding: "16px 18px 8px", display: "flex", flexDirection: "column", gap: 14 } },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, paddingBottom: 14, borderBottom: "1px solid " + T.border } },
          React.createElement("span", { style: { fontSize: 18 } }, ch.icon),
          React.createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 3, flex: 1 } },
            React.createElement("span", { style: { fontSize: 15, fontWeight: 700, color: T.text } }, ch.title),
            React.createElement("span", { style: { fontSize: 12, color: T.textDim, lineHeight: 1.4 } }, ch.desc)
          ),
          React.createElement(Badge, { enabled })
        ),
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
          React.createElement("span", { style: { fontSize: 13, color: T.textDim } }, "启用通道"),
          React.createElement("input", {
            type: "checkbox",
            checked: enabled,
            disabled: !writable,
            onChange: (e) => scope.set("enabled", e.target.checked),
            style: { width: 18, height: 18, cursor: writable ? "pointer" : "default", accentColor: T.brand },
          })
        ),
        ch.fields.map((f) =>
          React.createElement(Field, { key: f.key, f, value: value[f.key], writable, onCommit: commit(f.key) })
        ),
        ch.setup
          ? React.createElement(
              "div",
              {
                style: {
                  fontSize: 12,
                  color: T.textDim,
                  lineHeight: 1.55,
                  background: T.cardHi,
                  border: "1px solid " + T.border,
                  borderRadius: 8,
                  padding: "8px 10px",
                },
              },
              ch.setup
            )
          : null,
        React.createElement("div", { style: { height: 8 } })
      );
    }

    function AgentCard({ scope }) {
      const snap = useScope(scope);
      if (snap.status === "loading" || snap.status === "unavailable") return null;
      const value = snap.value || {};
      const writable = snap.writable !== false;
      const commit = (key) => (v) => scope.set(key, v);
      return React.createElement(
        "div",
        { style: { background: T.card, border: "1px solid " + T.border, borderRadius: 12, padding: "16px 18px 8px", display: "flex", flexDirection: "column", gap: 14 } },
        React.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 3 } },
          React.createElement("span", { style: { fontSize: 15, fontWeight: 700, color: T.text } }, "🤖 Agent 运行环境"),
          React.createElement("span", { style: { fontSize: 12, color: T.textDim } }, "所有通道共用；留空则使用运行时默认值" )
        ),
        AGENT_FIELDS.map((f) =>
          React.createElement(Field, { key: f.key, f, value: value[f.key], writable, onCommit: commit(f.key) })
        ),
        React.createElement("div", { style: { height: 8 } })
      );
    }

    function BridgeCard({ scope }) {
      const snap = useScope(scope);
      if (snap.status === "loading" || snap.status === "unavailable") return null;
      const value = snap.value || {};
      const writable = snap.writable !== false;
      const commit = (key) => (v) => scope.set(key, v);
      return React.createElement(
        "div",
        { style: { background: T.card, border: "1px solid " + T.border, borderRadius: 12, padding: "16px 18px 8px", display: "flex", flexDirection: "column", gap: 14 } },
        React.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: 3 } },
          React.createElement("span", { style: { fontSize: 15, fontWeight: 700, color: T.text } }, "🌉 受信代理远程桥"),
          React.createElement("span", { style: { fontSize: 12, color: T.textDim } }, "让远程浏览器也能读写本插件的配置（本机直连时不需要开）" )
        ),
        BRIDGE_FIELDS.map((f) => {
          if (f.kind === "bool") {
            return React.createElement(
              "label",
              { key: f.key, style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
              React.createElement("span", { style: { fontSize: 13, fontWeight: 600, color: T.text } }, f.label),
              React.createElement("input", {
                type: "checkbox",
                checked: value[f.key] === true,
                disabled: !writable,
                onChange: (e) => scope.set(f.key, e.target.checked),
                style: { width: 18, height: 18, cursor: writable ? "pointer" : "default", accentColor: T.brand },
              })
            );
          }
          return React.createElement(Field, { key: f.key, f, value: value[f.key], writable, onCommit: commit(f.key) });
        }),
        React.createElement(
          "div",
          { style: { fontSize: 12, color: T.textDim, lineHeight: 1.55, background: T.cardHi, border: "1px solid " + T.border, borderRadius: 8, padding: "8px 10px" } },
          BRIDGE_SETUP
        ),
        React.createElement("div", { style: { height: 8 } })
      );
    }

    // 桥接伪 scope：对 ChannelCard/AgentCard 暴露与 settingsScope 相同的接口
    function makeBridgeScope(ns) {
      let snapshot = { status: "loading", value: undefined, writable: false, mode: "bridge" };
      const listeners = new Set();
      const notify = (next) => {
        snapshot = next;
        for (const l of listeners) l();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe: (fn) => {
          listeners.add(fn);
          return () => { listeners.delete(fn); };
        },
        accept(nsView, writable) {
          notify({ status: "ready", value: nsView || {}, writable: writable !== false, mode: "bridge" });
        },
        set: async (field, value) => {
          const res = await fetch(BRIDGE_PATH + "/mutate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ns, field, value }),
          });
          const data = await res.json();
          if (data && data.ok && data.value) {
            notify({ status: "ready", value: data.value, writable: true, mode: "bridge" });
          }
        },
      };
    }

    function BridgeMode() {
      const [state, setState] = React.useState({ phase: "loading" });
      const [scopes] = React.useState(() => {
        const map = {};
        for (const ch of CHANNELS) map[ch.id] = makeBridgeScope(ch.ns);
        map.agent = makeBridgeScope(NS_AGENT);
        return map;
      });

      React.useEffect(() => {
        let alive = true;
        fetch(BRIDGE_PATH + "/describe")
          .then((r) => r.json())
          .then((data) => {
            if (!alive) return;
            if (data && data.ok && Array.isArray(data.namespaces)) {
              const byNs = new Map(data.namespaces.map((v) => [v.ns, v]));
              for (const ch of CHANNELS) {
                const view = byNs.get(ch.ns);
                if (view) scopes[ch.id].accept(view.value, data.writable);
              }
              const agentView = byNs.get(NS_AGENT);
              if (agentView) scopes.agent.accept(agentView.value, data.writable);
              setState({ phase: "ready", enabledCount: data.namespaces.filter((v) => v.value && v.value.enabled === true).length });
            } else {
              setState({ phase: "off" });
            }
          })
          .catch(() => { if (alive) setState({ phase: "off" }); });
        return () => { alive = false; };
      }, [scopes]);

      return React.createElement(
        "div",
        { style: { maxWidth: 660, display: "flex", flexDirection: "column", gap: 18 } },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 } },
          React.createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 6 } },
            React.createElement("h2", { style: { margin: 0, fontSize: 18, fontWeight: 700, color: T.text } }, "消息通道"),
            React.createElement(
              "p",
              { style: { margin: 0, fontSize: 13, color: T.textDim, lineHeight: 1.5 } },
              "把钉钉 / 飞书 / 企业微信 / QQ 的机器人消息统一交给一个 dsh agent 处理并回复。"
            )
          ),
          state.phase === "ready"
            ? React.createElement(Badge, { enabled: state.enabledCount > 0, label: "远程桥 · 已启用 " + state.enabledCount + " / " + CHANNELS.length + " 个通道" })
            : null
        ),
        state.phase === "loading"
          ? React.createElement("div", { style: { color: T.textDim, padding: 14 } }, "正在连接受信代理桥…")
          : null,
        state.phase === "off"
          ? React.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  fontSize: 13,
                  color: T.textDim,
                  lineHeight: 1.6,
                  background: T.card,
                  border: "1px solid " + T.border,
                  borderRadius: 12,
                  padding: 16,
                },
              },
              React.createElement("span", { style: { fontWeight: 700, color: T.text } }, "🔒 远程浏览器只能查看，不能编辑配置"),
              React.createElement(
                "span",
                null,
                "这是 DSH 的全局设计（设置接口只对本机开放，官方插件也一样）。最简单的做法是 SSH 到运行 dsh 的机器上："
              ),
              React.createElement(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 4 } },
                React.createElement("span", null, "① 编辑 ~/.dsh/settings.yaml，把下面的模板按需填好并追加进去："),
                React.createElement("textarea", {
                  readOnly: true,
                  value: SETTINGS_TEMPLATE,
                  style: {
                    boxSizing: "border-box",
                    width: "100%",
                    minHeight: 220,
                    padding: "10px 12px",
                    fontSize: 12,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    color: T.text,
                    background: T.cardHi,
                    border: "1px solid " + T.border,
                    borderRadius: 8,
                    resize: "vertical",
                  },
                }),
                React.createElement("span", null, "② 重启 dsh web 生效。")
              ),
              React.createElement(
                "span",
                null,
                "也可以在服务端本机打开设置页（localhost）用图形界面配置；如果确实需要远程图形化配置，再在服务端本机开启「受信代理远程桥」（消息通道页面底部），配置反代 + 令牌即可。"
              )
            )
          : null,
        state.phase === "ready"
          ? React.createElement(
              "div",
              { style: { fontSize: 12, color: T.textDim, lineHeight: 1.5 } },
              "远程桥模式：配置通过服务端受信代理桥读写（令牌只存在服务端）。改动即时保存，保存后对应通道自动重连。"
            )
          : null,
        state.phase === "ready" ? CHANNELS.map((ch) => React.createElement(ChannelCard, { key: ch.id, ch, scope: scopes[ch.id] })) : null,
        state.phase === "ready" ? React.createElement(AgentCard, { scope: scopes.agent }) : null
      );
    }

    function Section({ scopes, bridgeScope }) {
      // 远程浏览器：settingsScope 处于 memory 模式 → 走受信代理桥
      const mode = useScope(scopes.dingtalk).mode;
      if (mode === "memory") {
        return React.createElement(BridgeMode);
      }
      const snaps = CHANNELS.map((ch) => useScope(scopes[ch.id]));
      const ready = snaps.filter((s) => s.status === "ready");
      const enabledCount = ready.filter((s) => s.value && s.value.enabled === true).length;

      return React.createElement(
        "div",
        { style: { maxWidth: 660, display: "flex", flexDirection: "column", gap: 18 } },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 } },
          React.createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 6 } },
            React.createElement("h2", { style: { margin: 0, fontSize: 18, fontWeight: 700, color: T.text } }, "消息通道"),
            React.createElement(
              "p",
              { style: { margin: 0, fontSize: 13, color: T.textDim, lineHeight: 1.5 } },
              "把钉钉 / 飞书 / 企业微信 / QQ 的机器人消息统一交给一个 dsh agent 处理并回复。"
            )
          ),
          React.createElement(Badge, { enabled: enabledCount > 0, label: "已启用 " + enabledCount + " / " + CHANNELS.length + " 个通道" })
        ),
        CHANNELS.map((ch) =>
          React.createElement(ChannelCard, { key: ch.id, ch, scope: scopes[ch.id] })
        ),
        React.createElement(AgentCard, { scope: scopes.agent }),
        React.createElement(BridgeCard, { scope: bridgeScope }),
        React.createElement(
          "div",
          { style: { fontSize: 12, color: T.textDim, lineHeight: 1.5 } },
          "改动即时保存，保存后对应通道自动重连。各通道凭据均为只写字段（不回显，留空即保持不变）。"
        )
      );
    }

    function apply(ctx) {
      const scopes = {
        dingtalk: ctx.settingsScope.bind({ namespace: NS_DINGTALK }),
        feishu: ctx.settingsScope.bind({ namespace: NS_FEISHU }),
        wecom: ctx.settingsScope.bind({ namespace: NS_WECOM }),
        qq: ctx.settingsScope.bind({ namespace: NS_QQ }),
        agent: ctx.settingsScope.bind({ namespace: NS_AGENT }),
      };
      const bridgeScope = ctx.settingsScope.bind({ namespace: NS_BRIDGE });
      ctx.slots.inject("settings.section", () => {
        const unregister = ctx.slots.register(
          { name: "settings.section", id: SECTION_ID, order: 120, label: "消息通道" },
          () => React.createElement(Section, { scopes, bridgeScope })
        );
        return unregister;
      });
    }

    return { inject: ["settingsScope", "slots"], apply };
  },
});
