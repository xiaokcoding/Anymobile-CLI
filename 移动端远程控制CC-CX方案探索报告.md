# 移动端远程控制 PC 上 cc(Claude Code)/ cx(Codex)——自建参考报告

> 用途：为「自己 vibe-code 一个远程 cc 手机 App」提供**架构思路、可抄的开源件、关键接口与坑**。不是产品测评，而是**造轮子前的地图**。
> 调研日期：2026-05-31　|　方法：smart-search CLI（Deep Research，fetch_before_claim）
> 证据目录：`C:\tmp\smart-search-evidence\mobile-cc-cx\`（01–36 号 JSON/MD，关键断言均有 fetched 原文）

---

## 0. 一句话结论

这个赛道已经**很卷**（官方 + 至少 5 个成熟产品 + 十几个 DIY repo），所以**别从零写桥接**——直接 fork 一个 **MIT 协议、文档清晰、协议已设计好**的项目当骨架（首推 **ccpocket**，备选 **Happy**），把精力花在你的差异化 UX 上。核心技术决策收敛成 **5 个轴**（见 §1），核心接口就是 **`claude -p --output-format stream-json` / Claude Agent SDK** 和 **`codex app-server`**（见 §5）。

---

## 1. 自建前必须拍板的 5 个轴（第一性原理）

任何一个"远程 cc App"都是这 5 个轴的组合，所有现存项目都能套进这张表：

| 轴 | 选项 A | 选项 B | 选项 C | 对你的建议 |
|---|---|---|---|---|
| **A. 会话跑在哪** | **同步本地会话**：agent 跑在你真实开发机，手机是窗口（Happy/Paseo/ccpocket/官方 RC） | **云端沙箱化**：每会话开一个 microVM/容器，手机派活（Netclode/Claude Code web/Codex Cloud） | — | **A**：vibe-code 起步最简单，且"用我自己的环境"正是卖点 |
| **B. 怎么接住 agent** | **裸 PTY 终端镜像**：把 `claude` 的伪终端流到手机渲染（ttyd/VibeTunnel/ClauTunnel） | **结构化 SDK/headless 流**：用 `claude -p stream-json`/Agent SDK 拿结构化事件，自己画原生 UI（Happy/ccpocket/Paseo） | **官方 relay**：直接挂 `claude remote-control` | **B**：原生聊天 UI + 审批 + diff 才是好移动体验；A 路线手机上敲终端很难受 |
| **C. 手机怎么连到 PC** | **厂商 relay**（官方 RC/Codex，零配置但过厂商云） | **自托管 relay**（StealthRelay/happy-server，公网可达不开端口） | **mesh VPN / 局域网**（Tailscale / mDNS，最私密） | 起步用 **Tailscale**（最快）；要公网分发再加**自托管 relay** |
| **D. 信任/加密模型** | **TLS-only**（传输加密，服务端理论可见明文） | **端到端 E2EE**（零知识 relay 只见密文 blob，Happy/StealthRelay） | — | MVP 用 TLS/wss + Tailscale 即可；要做产品再上 **E2EE** |
| **E. 移动端技术栈** | **Expo / React Native**（TS，Happy/Paseo/gldc 用） | **Flutter / Dart**（ccpocket 用） | **原生 Swift/Kotlin**（Netclode/CcCompanion/krzemienski 用） | 看你顺手；想一套代码多端 + 抄现成依赖 → **Flutter(抄 ccpocket)** 或 **Expo(抄 Happy)** |

> **最关键的洞察**：B 轴的"结构化 SDK 流"是现代移动客户端的主流（Happy/Paseo/ccpocket 都走这条），因为它能在手机上做**原生聊天、按钮审批、git diff 视图、推送**——而不是逼用户在 6 寸屏上操作 ANSI 终端。

---

## 2. 参考产品全景（按"可借鉴度"分层，含技术栈）

### 2.1 官方一方（决定了"基线体验"，但不可 fork）

| 方案 | 语言/形态 | 架构要点 | 可借鉴点 / 注意 |
|---|---|---|---|
| **cc Remote Control** | Claude Code CLI（Node/TS） | `claude remote-control` 或 `/rc`；**仅 outbound HTTPS、不开入站端口**，进程注册到 Anthropic API 后**轮询取活**；多份短时凭据各自过期；文件/MCP 不离机，只有消息/工具结果过加密桥 | 安全模型范本：**outbound-only + 短时凭据**值得照抄；研究预览，iOS 后台会断连、crash 后需重开会话 |
| **cx in ChatGPT App**（2026-05-14） | Codex CLI（**Rust**）+ 原生 App | **secure relay** 让受信机器跨设备可达不暴露公网；**Remote SSH GA**（Desktop 自动读 SSH config）；Codex Cloud 后台任务 | relay + Remote SSH 的"多 host 发现"思路；Windows host 连手机"coming soon" |

### 2.2 成熟可 fork 项目（你的候选骨架）⭐

| 项目 | ★ | 语言/框架 | 架构 | 许可证 | 为什么值得抄 |
|---|---|---|---|---|---|
| **ccpocket**（K9i-0） | 639 | **Flutter/Dart** + **TS Bridge** | `App ↔ JSON-WS 协议 ↔ Bridge(@ccpocket/bridge) ↔ cc/cx`，Claude 走 **Agent SDK**、Codex 走 **app-server transport** | **MIT** | **首推**：协议、依赖、目录、Fork 指南全公开（§4.1）；多端一套码；自带审批/diff/worktree/断网重发 |
| **Happy**（slopus） | 20.3k | **Expo/RN(TS 95%)** + happy-server(TS+Prisma+PG) | 四件套 `happy-app/cli/agent/server`，`happy claude`/`happy codex` 包裹原命令；**E2EE**（master secret 不离手机→DEK） | **MIT** | 最成熟、双支持；**E2EE 设计可直接照抄**（§4.2） |
| **Paseo**（getpaseo） | 6.9k | **TS 98.6%** monorepo | `daemon(WS API + MCP server) ↔ Expo app / Electron / CLI / relay 包`；多 provider（cc/cx/Copilot/OpenCode/Pi）统一接口 | **AGPL-3.0 ⚠️** | 架构最完整（daemon+relay 分包）；**但 AGPL 有网络传染性**，商用/闭源前要想清楚，可借思路勿直接抄码 |
| **Omnara**（YC S25） | ~2.6k | **TS + Python** | sessions/workspaces/providers 抽象 + Apple Watch/语音/远程沙箱 | ⚠️ 开源版**已标弃用** | 看产品形态即可，别基于其 OSS 版开发 |
| **VibeTunnel**（amantus-ai） | 4.5k | **TS + Swift + Zig** | macOS 原生把终端代理进浏览器（PTY→web，B 轴选项 A 的代表） | — | 想走"裸终端镜像"路线时的参考 |
| **CcCompanion** | 38 | **Swift（原生 iOS）** | 自托管 relay + local-first chat | MIT | 原生 iOS + 自托管 relay 的小而全样本 |
| **Moshi**（getmoshi） | — | 原生 iOS | Tailscale+mosh+tmux 之上的终端 App + `moshi-hook`（审批/Live Activities/Apple Watch） | 闭源 | "终端栈 + 原生事件层"的体验天花板参考 |

### 2.3 全栈"云沙箱"参考（重型，A 轴选项 B 的范本）

**Netclode**（angristan）— 自托管云端编码 agent，技术栈极具参考价值：

| 层 | 技术 | 作用 |
|---|---|---|
| 编排 | **k3s**（轻量 k8s） | 单节点友好 |
| 隔离 | **Kata Containers + Cloud Hypervisor** | 每会话一个 **microVM**（可给 agent 全 sudo + docker） |
| 存储 | **JuiceFS → S3** | POSIX 文件系统挂对象存储，支持**暂停/恢复会话(0 算力)** + 回合快照 |
| 状态 | **Redis Streams** | 实时流式会话状态 |
| 网络 | **Tailscale Operator** | VPN、ingress、沙箱预览端口 |
| API | **Protobuf + Connect RPC** | 类型安全、类 gRPC、支持流 |
| 控制面 | **Go** | 会话/沙箱编排 |
| Agent runner | **TS/Node** | 在沙箱内跑 cc/Codex/OpenCode 的 **SDK runner** |
| 客户端 | **SwiftUI (iOS 26)** 原生 | — |

> Netclode 作者实测吐槽（很有参考价值的"效果"）：Copilot Agent **每个 prompt 都强制建 PR**（无法关）；Codex web **很懒**、iOS 只给摘要；**Claude Code web 体验最好**但默认 root 跑会有权限坑。

### 2.4 DIY 小项目群（11 个，看"最小实现"长什么样）

| 项目 | 语言 | 一句话 |
|---|---|---|
| K9i-0/ccpocket | Dart/Flutter | （见上，最成熟）|
| gldc/claude-code-remote-app | TS/**Expo** | 管理 cc Remote 会话的极简 Expo App |
| CyberSealNull/CcCompanion | **Swift** | 自托管 relay + 本地优先 iOS |
| krzemienski/claude-code-ios-ui | **Swift + Express.js 后端** | 赛博朋克 UI 原生 iOS |
| soliblue/cloude | **Swift** | 手机变任意机器的远程终端 |
| TongilKim/ClauTunnel | TS | iOS&Android 实时终端镜像 |
| Norio691/claude-conduit | TS | iPhone 实时终端 + 会话管理 |
| StephenTowne/open-claude-remote | TS | — |
| cducote/remoteCC | JS | 手机审批改动 |
| tomstetson/idle | TS | **Happy 的 fork**（说明 Happy 适合做基底）|
| anthropics/claude-code#29726 | — | 官方 RC「iOS 后台断连、不自动重连」的 issue（坑预警）|

### 2.5 基础设施件（直接拿来用，别自己写）

- **自托管 relay**：**StealthRelay**（Rust，MIT）— 零知识 WS relay，**Noise NK(双 X25519 DH)+ChaCha20-Poly1305**，Ed25519 host 鉴权、自适应 PoW、限流、Docker/Cloudflare Tunnel；只转发密文 blob。`paseo-relay`（Go）是 Paseo 社区版。
- **mesh VPN**：**Tailscale**（零配置）/ **Headscale**（自托管控制面，国内/主权场景）。
- **Web 终端**（若走 B 轴选项 A）：**ttyd**（C，libuv+WebGL2，CJK/IME）、**sshx**（Rust，多人协作）。
- **会话持久**：tmux / zellij（抗断线，所有终端路线必备）。

---

## 3. 两种界面哲学（B 轴展开，决定你 App 长什么样）

```
路线①  裸终端镜像 (PTY mirroring)            路线②  结构化 SDK 流 (推荐)
┌────────────┐                              ┌────────────┐
│  手机      │  xterm.js/SwiftTerm 渲染ANSI │  手机      │  原生聊天气泡+审批按钮+diff视图
│  (终端模拟)│                              │ (原生 UI)  │
└─────┬──────┘                              └─────┬──────┘
      │ keystroke/resize (WS)                     │ JSON 消息 start/input/approve (WS)
┌─────▼──────┐                              ┌─────▼──────┐
│ Bridge:PTY │ node-pty/portable-pty        │ Bridge:SDK │ claude -p --output-format stream-json
│ 包裹 claude│                              │ 解析事件流 │ 或 @anthropic-ai/claude-agent-sdk
└────────────┘                              └────────────┘
优点: 任何CLI通吃, 全保真                    优点: 原生体验/推送/审批/diff, 移动友好
缺点: 手机敲终端难受, 难做按钮审批            缺点: 要按 provider 写适配器, 跟 SDK 版本走
代表: ttyd/VibeTunnel/ClauTunnel             代表: Happy/Paseo/ccpocket/Omnara
```

**给你的建议**：走**路线②**。它正是 ccpocket/Happy/Paseo 的选择，移动端能做出"像 App 而不像 SSH"的体验。可保留一个"原始终端"标签页兜底（很多项目两者都给）。

---

## 4. 三套可直接照搬的参考架构

### 4.1 架构一：Bridge + JSON-WS 结构化协议（**首推起点，来自 ccpocket，MIT**）

```
┌─────────────────────────────────────────────────────────────┐
│ 手机/桌面 App (Flutter 或 Expo)                              │
│   features: chat / claude_session / codex_session /          │
│             git(diff) / explore(文件) / prompt_history       │
└───────────────┬─────────────────────────────────────────────┘
                │  JSON over WebSocket（wss / ws）
                │  C→S: start, input, approve/reject, answer,
                │       list_sessions, stop_session, get_history, get_diff
                │  S→C: system, assistant, stream_delta, tool_result,
                │       permission_request, status, history, session_list,
                │       diff_result, error
┌───────────────▼─────────────────────────────────────────────┐
│ Bridge Server（你机器上，Node18+/TS，ws 库）                 │
│   session.ts(多会话生命周期) parser.ts(协议) websocket.ts(路由)│
│   sdk-process.ts ── Claude: @anthropic-ai/claude-agent-sdk    │
│   codex-process/transport.ts ── Codex: CLI / app-server       │
│   git-operations.ts / worktree.ts / prompt-history-store.ts   │
│   setup-launchd.ts(mac) setup-systemd.ts(linux) 常驻服务      │
└───────────────┬─────────────────────────────────────────────┘
                │ 本地进程
        ┌───────▼────────┐   连通: 局域网 QR / mDNS(bonjour) / 手填 ws:// / Tailscale
        │  cc / cx CLI   │   推送: Firebase Cloud Functions 中转
        │  + shell/git/fs│
        └────────────────┘
```
**为什么是它**：MIT 可商用、多端一套 Dart 码、协议/依赖/Fork 指南全公开、自带审批/diff/worktree/断网重发。**fork 后改 UI 即可有可用产品**。
**它给你的现成依赖清单**（Flutter）：状态 `flutter_bloc`+`provider`+`flutter_hooks`、路由 `auto_route`、模型 `freezed`+`json_serializable`、WS `web_socket_channel`、存储 `flutter_secure_storage`/`sqflite`、Markdown/高亮 `flutter_markdown`/`syntax_highlight`、扫码 `mobile_scanner`、mDNS `bonsoir`、SSH `dartssh2`、推送 Firebase Messaging、内购 RevenueCat、热更 Shorebird。

### 4.2 架构二：零知识 relay + E2EE（**隐私优先，来自 Happy + StealthRelay**）

```
┌──────────┐  ① master secret 32B 仅存手机, 永不外发, base32 可备份
│  手机     │  ② HKDF 派生 → Content KeyPair(X25519): 私钥不出手机
│ (持密钥)  │     公钥在 QR 配对时发给 CLI
└────┬─────┘  ③ 每会话 DEK(对称) 加密真实内容; DEK 用公钥加密后存服务器
     │ 密文 blob (wss)
┌────▼───────────────┐   relay 只见密文 + 元数据(由配对密钥派生, 等于失明)
│ 自托管 Relay        │   StealthRelay: Rust, Noise NK + ChaCha20-Poly1305,
│ (零知识转发)        │   Ed25519 host 鉴权, 自适应 PoW, 限流, Cloudflare Tunnel
└────┬───────────────┘
     │ 密文 blob (wss, outbound-only)
┌────▼───────────────┐
│ Bridge on PC        │  解密 → 喂给 cc/cx; 出站连接, 不开入站端口
└─────────────────────┘
```
**适用**：要做面向公众、过公网、"连你自己都看不到用户代码"的产品时。MVP 阶段可先跳过，用架构一 + Tailscale 顶上。

### 4.3 架构三：云端 microVM 沙箱（**重型/多并发，来自 Netclode**）
见 §2.3 表。适用：要给团队/多人开"即开即用、强隔离、可暂停恢复"的云会话——但工程量大（k3s+Kata+JuiceFS+Connect RPC），**不建议作为个人 vibe-code 的起点**。

---

## 5. 核心接口速查：cc / cx 的"可编程控制面"

### 5.1 Claude（cc）— Agent SDK / headless（你的主力接口）
```bash
# 结构化流式（移动端核心：逐事件渲染）
claude -p "实现登录功能" \
  --output-format stream-json --input-format stream-json \
  --include-partial-messages --verbose \
  --allowedTools "Read,Edit,Bash" \
  --permission-mode acceptEdits        # 或 dontAsk(锁死) / 交互审批
# 会话续接
claude -p "继续，聚焦数据库查询" --resume "$SESSION_ID"
# 结构化 JSON（带 schema 校验）
claude -p "..." --output-format json --json-schema '{...}'   # 结果在 structured_output
# 提速：跳过 hooks/skills/MCP/CLAUDE.md 自动发现（SDK/脚本推荐, 将成 -p 默认）
claude --bare -p "..." --allowedTools "Read"
```
- **事件流**：`system/init`(模型/工具/MCP/插件) → `assistant` / `stream_event`(text_delta) → `tool_result` → 失败时 `system/api_retry`(可做退避/进度)。这些正是你 App 要渲染的东西。
- **SDK 包**：TS `npm i @anthropic-ai/claude-agent-sdk`；Py `pip install claude-agent-sdk`（带工具审批回调、原生消息对象）。
- **鉴权**：`ANTHROPIC_API_KEY` 或 `apiKeyHelper`；也支持 Bedrock/Vertex/Foundry。

### 5.2 Codex（cx）— exec / app-server
- `codex exec "..."` —— 非交互模式（脚本/CI，无 TUI）。
- **`codex app-server`** —— 驱动富客户端的开源接口（VS Code 扩展就用它）：**鉴权、会话历史、审批、流式 agent 事件**，正是做"原生 cx 客户端"该接的层。在 `codex-rs/app-server/`（Rust）。ccpocket 的 Codex 集成就走这条 transport。

### 5.3 协议设计直接抄 ccpocket（§4.1 的消息名）
`start / input / approve / reject / answer / get_diff` ↔ `system / assistant / stream_delta / tool_result / permission_request / status / diff_result`。**新功能用新消息类型 + "不支持消息优雅降级"**，保证新 App 能连旧 Bridge。

---

## 6. 移动端技术栈选型（E 轴展开）

| 方案 | 代表项目 | 优点 | 代价 | 适合你如果… |
|---|---|---|---|---|
| **Flutter/Dart** | **ccpocket** | 一套码 iOS/Android/桌面；ccpocket 依赖清单可整套抄 | 学 Dart | 想要最完整的"可 fork 起点" |
| **Expo / React Native(TS)** | **Happy / Paseo / gldc** | JS/TS 生态、与 Bridge 同语言、Happy/Paseo 均此栈 | RN 原生模块偶尔折腾 | 你 TS 更熟、想前后端同语言 |
| **原生 SwiftUI(+Kotlin)** | Netclode/CcCompanion/krzemienski | 体验/性能/系统集成(Live Activities/Watch)最佳 | 双端各写一遍 | 只做 iOS 且追求极致体验 |

> Bridge 端几乎都是 **Node/TS + `ws`**（ccpocket、happy-server、krzemienski 的 Express 后端）。除非要极致性能/安全（StealthRelay 选 Rust），否则 **Bridge 用 TS 最省事**。

---

## 7. 自建 MVP 推荐路线（分阶段，每阶段都站在巨人肩上）

1. **跑通最小回路（1 天）**：本机起 `claude -p --output-format stream-json`，用 Node 起一个 `ws` server 把事件转发到一个网页 → 验证"结构化流 → UI"。
2. **Fork ccpocket 或 Happy（首选 ccpocket，MIT）**：删掉你不要的界面，跑通 `App ↔ Bridge ↔ cc`，扫 QR 连本机。
3. **连通性**：先 **Tailscale**（`ws://<tailnet-ip>:port`，最快），局域网加 **mDNS** 自动发现。
4. **补移动刚需**：**审批按钮**（permission_request）、**git diff 视图**、**推送**（agent 要权限/完成时）、**断网重发/补流**。
5. **接 cx**：Bridge 加一个 `codex app-server` transport（抄 ccpocket 的 `codex-transport.ts` 思路），UI 复用同一套聊天组件。
6. **要做产品再上**：自托管 relay（StealthRelay）+ **E2EE**（抄 Happy 的 master-secret→DEK 模型）+ 公网分发。

---

## 8. 必须知道的坑 / 风险 / 法务

- 🔴 **2026-06-15 起**（就在两周后）：**订阅版 `claude -p` / Agent SDK 用量改走独立的"月度 Agent SDK credit"**，与交互额度分开计。也就是说你 App 跑的每次 SDK 调用会吃这份额度——要么接受，要么走 `ANTHROPIC_API_KEY` 按量付费。**这直接影响你 App 的成本模型，务必先读** `support.claude.com/en/articles/15036540`。
- 🔴 **认证**：ccpocket 新版 Bridge **要 `ANTHROPIC_API_KEY`，不支持订阅 `/login`**；官方 RC 则用订阅。你得想清楚用户拿什么 key。
- 🟠 **后台断连**：官方 RC 的 iOS 都有"切后台掉线、不自动重连"问题（issue #29726）；ccpocket 专门做了"补流+离线队列+自动重发"——**移动端的重连/补流必须从第一天就设计**。
- 🟠 **不要暴露公网端口**：照抄"outbound-only + relay"或"Tailscale"，别图省事开入站端口（OpenClaw 因 WS 暴露吃过 **CVE-2026-25253 RCE，波及 5 万+ 实例**）。
- 🟠 **沙箱/权限**：`--permission-mode dontAsk` 锁死 + 白名单工具；给 agent root 会有坑（Netclode 经验）。要重隔离就上 microVM/worktree。
- ⚖️ **许可证**：**Happy / ccpocket = MIT（可闭源商用）**；**Paseo = AGPL-3.0（网络传染，联网服务也要开源，慎 fork）**；StealthRelay = MIT。**抄码前先看 LICENSE**。

---

## 9. 给你的最小决策建议

> 目标＝个人 vibe-code 一个远程 cc（兼顾 cx）手机 App：
- **骨架**：fork **ccpocket**（MIT、Flutter 多端、协议/依赖/Fork 指南齐全）。嫌 Dart 重就 fork **Happy**（MIT、Expo/TS）。
- **接口**：Claude 走 **Agent SDK / `claude -p stream-json`**；Codex 走 **`codex app-server`**。
- **连通**：起步 **Tailscale + wss**；要公网再加 **StealthRelay**。
- **加密**：MVP 用 wss+Tailscale；做产品再抄 **Happy 的 E2EE**。
- **先确认成本**：6-15 的 Agent SDK credit 政策 + key 来源。

---

## 10. 证据与链接清单（可复现）

**关键 fetched 原文（高可信）**：
- cc headless/Agent SDK：`code.claude.com/docs/en/headless`（34）
- cc Remote Control 官方文档 + 安全模型解读：`code.claude.com/docs/en/remote-control`（08）、`claudefa.st/.../remote-control-guide`（25）
- cx 官方："Work with Codex from anywhere" `openai.com/index/work-with-codex-from-anywhere`（09）；`developers.openai.com/codex/noninteractive`、`/codex/app-server`（32）
- **ccpocket 参考栈**：`k9i-0.github.io/ccpocket/architecture/stack.md`（35）、README（31）
- **Happy E2EE 模型**：`happy.engineering/docs/security`（36）、README（10）
- **Paseo 架构**：`raw.githubusercontent.com/getpaseo/paseo/main/README.md`（20）
- **StealthRelay relay**：`raw.githubusercontent.com/Olib-AI/StealthRelay/main/README.md`（26）
- **Netclode 全栈**：`stanislas.blog/2026/02/netclode-self-hosted-cloud-coding-agent`（27）

**项目仓库**：getpaseo/paseo · slopus/happy · omnara-ai/omnara · amantus-ai/vibetunnel · K9i-0/ccpocket · angristan/netclode · Olib-AI/StealthRelay · CyberSealNull/CcCompanion · krzemienski/claude-code-ios-ui · TongilKim/ClauTunnel · gldc/claude-code-remote-app · openai/codex

**可复现命令**（节选，全部存于证据目录 01–36）：
```powershell
smart-search exa-search "Claude Code SDK headless stream-json" --include-domains code.claude.com --include-text --format json   # 30
smart-search fetch "https://code.claude.com/docs/en/headless.md" --format markdown                                             # 34
smart-search fetch "https://k9i-0.github.io/ccpocket/architecture/stack.md" --format markdown                                  # 35
smart-search fetch "https://happy.engineering/docs/security/" --format markdown                                                # 36
smart-search exa-search "Codex CLI exec app-server" --include-domains developers.openai.com github.com --include-text          # 32
smart-search fetch "https://raw.githubusercontent.com/getpaseo/paseo/main/README.md" --format markdown                         # 20
smart-search fetch "https://raw.githubusercontent.com/Olib-AI/StealthRelay/main/README.md" --format markdown                   # 26
```

**软结论 / 待核**：各项目 star 数为抓取时点快照；cc 所需精确 CLI 版本号未逐页核验；Paseo `packages/relay` 内部协议细节、Codex app-server 消息 schema 未逐字段抓取（需要时我可再深挖）。
