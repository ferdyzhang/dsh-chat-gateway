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
    const SECTION_ID = "im-gateway";

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
        return React.createElement(
          "div",
          { style: { color: T.textDim, padding: 14 } },
          "配置命名空间未暴露。可编辑 ~/.dsh/settings.yaml 后重启。"
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

    function Section({ scopes }) {
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
      ctx.slots.inject("settings.section", () => {
        const unregister = ctx.slots.register(
          { name: "settings.section", id: SECTION_ID, order: 120, label: "消息通道" },
          () => React.createElement(Section, { scopes })
        );
        return unregister;
      });
    }

    return { inject: ["settingsScope", "slots"], apply };
  },
});
