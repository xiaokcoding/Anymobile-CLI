# Mobile remote control app for Claude Code (MVP)

## Goal

做一个移动端 App，让我能从手机远程控制跑在 PC（Windows 11）上的 Claude Code (cc)，
体验「类似 moshi」——随时随地看到 agent 在干什么、需要审批时一键通过/拒绝、收到完成通知。
PC 端用我自己的真实开发环境（不是云沙箱），手机只是窗口/遥控器。

## What I already know

* 已有一份深度调研报告（`移动端远程控制CC-CX方案探索报告.md`，2026-05-31，smart-search Deep Research），
  把整个赛道收敛成 5 个决策轴 + 3 套可照搬架构 + 核心接口速查。**研究阶段基本不用重做**。
* 报告核心结论：别从零写桥接，fork 一个 MIT 项目当骨架（首推 **ccpocket** Flutter，备选 **Happy** Expo/RN）。
* 报告主推**路线②（结构化 SDK 流）**：Bridge 用 `claude -p --output-format stream-json` / Claude Agent SDK
  拿结构化事件，手机画原生聊天 UI + 按钮审批 + diff，移动体验最好。
* 用户这次明确说「**类似 moshi**」——而 moshi 在报告里属于**路线①（终端镜像）**：
  Tailscale + mosh + tmux + 原生 iOS 终端 App + `moshi-hook`（审批/Live Activities/Apple Watch）。
  目录名 `mobile-ssh` 也指向终端/SSH 路线。**→ 这是 MVP 第一个要拍板的轴（见 Open Questions Q1）。**
* 运行环境：PC = Windows 11（host 跑 cc）。Shell 当前是 bash（可能是 WSL/Git-Bash，待确认）。
  → 影响很大：mosh/tmux 是 Unix 工具，Windows 原生下需 WSL；Node/TS Bridge 在 Windows 原生即可跑。
* 仓库现状：全新，仅有报告 + Trellis 脚手架（spec 分层是通用 backend/frontend，还空着），**尚未 git init**。

## Assumptions (temporary)

* 个人自用起步（非面向公众产品），MVP 阶段连通用 **Tailscale + wss**，不做 E2EE / 自托管 relay。
* 主目标是 **cc**；cx（Codex）作为后续扩展，不进 MVP。
* 鉴权 key 来源未定（订阅 `/login` vs `ANTHROPIC_API_KEY`）——受 2026-06-15 Agent SDK credit 政策影响，待确认。

## Decision (ADR-lite) — Q1 架构路线

**Context**: moshi 是路线①(终端镜像)，报告主推路线②(结构化 SDK)，需先定方向。
**Decision**: **选路线①（终端镜像，真·类 moshi）**——把 cc 终端流到手机，再加 hook 层做推送/一键审批。
**Consequences**: 任何 CLI 通吃、最保真、走订阅额度不额外吃 Agent SDK credit；
但手机终端交互弱(需精心设计输入)、审批靠 hook 补。

## Decision (ADR-lite) — Q3 PC 运行端 / 终端持久与镜像

**Context**: cc 现为 Windows 原生(fnm)、项目在 D: 盘；mosh/tmux 非现成；WSL 存在但访问 D: 走 /mnt 慢。
**Decision**: **选 A — Windows 原生 PTY 桥**。Node/TS bridge 用 node-pty(ConPTY) 原生 spawn `claude`；
bridge 进程持有长生命 PTY + scrollback 缓冲，接管 tmux 的「会话持久」职责；ws 推 PTY 流给手机、回传按键/resize。
**Consequences**: 不碰 WSL、直接操作 D: 项目、只用现有 node 工具链；
断线恢复需自己用 scrollback + ws 重连实现(即 ttyd/ClauTunnel 的做法)，不靠 mosh/tmux。

## Open Questions

* ~~Q6 Build-vs-Buy~~ ✅ **决定自建**（先跑 5 分钟官方 RC 作基线对照）。
* Q4：MVP 连通——Tailscale + `tailscale serve --bg`(自动 HTTPS) 起步 OK？（Windows + 手机各装 Tailscale；用 ntfy 通知则手机另装 ntfy app）
* ~~Q5 鉴权/成本~~ ✅ 研究坐实：路线①走订阅额度、不吃 Agent SDK credit；坑=spawn 前剔除 `ANTHROPIC_API_KEY`。

## Decision (ADR-lite) — Q2 客户端形态/平台

**Context**: 开发机 Windows、未见 Mac；MVP 要最快验证「手机看 cc + 一键审批 + 收通知」核心回路。
**Decision**: **选 PWA / 移动网页端**——bridge serve 一个 xterm.js 网页，手机浏览器经 Tailscale 打开、加到主屏；Web Push 做通知。
**Consequences**: 零 app store / 零 Mac / iOS+Android 通吃，最快跑通；原生 App(Live Activities/Watch)作为 fast-follow。
注意：Service Worker + Web Push 需安全上下文(HTTPS)，裸 `http://100.x` tailscale IP 不算 → 需 `tailscale serve` 自动 HTTPS(见研究 R3)。

## Research (dispatched 2026-06-01)

* R1 [`research/windows-pty-terminal-bridge.md`](research/windows-pty-terminal-bridge.md) — Windows 原生 PTY 桥(node-pty/ConPTY)+ 持久会话 + scrollback 重连。
* R2 [`research/claude-code-hooks-approval.md`](research/claude-code-hooks-approval.md) — cc hooks/权限模型做 moshi 式远程审批。
* R3 [`research/pwa-tailscale-webpush.md`](research/pwa-tailscale-webpush.md) — PWA over Tailscale 的 HTTPS 安全上下文 + Web Push。

## 技术方案 (post-research 收敛)

**整体数据流**：
```
手机 PWA (https://<host>.<tailnet>.ts.net ← tailscale serve 拿 HTTPS=secure context)
  │  wss (xterm.js attach: output↓ / input·resize↑)     │  通知: ntfy app 订阅 topic
  ▼                                                       ▲
[Windows bridge: Node/TS]  ── node-pty(ConPTY) spawn claude.cmd (持久 PTY + 字节环形 scrollback)
  ├─ ws server: 终端镜像 + 重连补流(lastSeq/replay, 抄 wootty 契约)
  ├─ POST /hooks/pre-tool-use ← cc PreToolUse(type:http) 同步阻塞 → 推 ntfy → 等手机决定 → 回 permissionDecision
  └─ Stop hook → 推「完成」；启动 claude 前剔除 ANTHROPIC_API_KEY 确保走订阅额度
```

**选型锁定**：node-pty v1.1.0+(自带 win32-x64 prebuild) · 原生 ws + @xterm/addon-attach(fork 加 resize/replay) ·
协议数值抄 wootty(12s ping / 4103 超时 / 300ms*1.8^n backoff) · 审批走 cc `PreToolUse` 的 `type:"http"` hook ·
HTTPS 用 `tailscale serve --bg` · 通知用 ntfy(iOS 配 `upstream-base-url: https://ntfy.sh`)。
**可抄实现**：`StephenTowne/open-claude-remote`(架构同构) + `icoretech/wootty`(协议契约最全)。

**🔴 三个 load-bearing 坑（动手前必须知道，详见 research/）**：
1. **Claude bracketed-paste 提交失效**：node-pty 在 Windows 把批量 write 包成 bracketed-paste，cc 把 `\r` 当粘贴内容→提示词永远发不出。修复：逐字符喂 + ~15ms 延迟。
2. **resize-after-exit 进程级崩溃**：PTY 退出后再 resize，native 抛错绕过 JS try/catch→直接 crash。需 alive 标志 + 升级含 PR #901 的 node-pty。
3. **鉴权落点**：bridge spawn claude 前剔除 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`，否则吃 API 计费而非订阅额度。

**🟠 成本（官方坐实，Q5 关闭）**：路线①交互式 `claude` 走订阅 usage limits，不吃 2026-06-15 起的 Agent SDK credit。

## ⚠️ Build-vs-Buy 复核点（Q6，动手前必答）

研究发现 Anthropic 已上线**官方 Remote Control**（`claude remote-control` / `/rc`）：手机/浏览器驱动本地会话 +
推送 + 审批 + 代码不离机 + outbound-only，几乎覆盖本 MVP 核心体验（需 claude.ai 订阅、**不能用 API key**、
部分 slash 命令在 RC 下不可用、移动端偶有渲染问题）。
- **自建仍有的差异化**：路线①**真·终端镜像**(RC 是结构化、非裸终端) · 完全自定义 UX · 不依赖官方 App · 可扩到 cx · 学习/可控。
- **建议**：把官方 RC 当 (a) 竞品基准/验收对照 (b) 架构范式佐证(outbound-only/push/手机审批官方已验证可行) (c) 动手前一次复核。

**Decision (Q6)**: **自建**——按既定路线①方案造 PWA+bridge；动手前先跑 5 分钟官方 RC 作 UX 基线对照。
理由：真终端镜像 RC 给不了、要完全可定制、将来接 cx、学习可控。

## Requirements

* 手机能连上 PC 上的 cc 并**实时看到其终端输出**（ANSI 全保真）。
* 手机能向 cc **发送 prompt / 按键**（独立输入框，逐字符发以绕开 bracketed-paste & IME 重复坑）。
* cc 需要工具权限/审批时，手机能**收到推送并一键通过/拒绝**，决定回传给 cc（`PreToolUse` http hook）。
* agent **完成或需要人介入**时，手机收到推送通知（`Stop` / `Notification[idle_prompt]`）。
* **断网/切后台后自动重连并补回**中间发生的输出（scrollback + lastSeq replay；移动端刚需，报告 §8 重点坑）。
* 仅 **tailnet 内可达 + bridge token 鉴权**，防 tailnet 内他人驱动你的 cc；**不开公网入站端口**。

## Acceptance Criteria (evolving)

* [ ] 手机 App 发起一个 prompt，PC 上的 cc 执行，过程实时显示在手机上。
* [ ] cc 触发一次权限请求，手机弹出审批，点「通过」后 cc 继续。
* [ ] 手机切后台再回前台，会话不丢、能补回期间的输出。

## Definition of Done (team quality bar)

* 关键路径有测试（连接/重连、审批往返、流式解析）。
* Lint / typecheck 通过。
* README/部署说明（PC 端如何起 Bridge、手机如何配对连接）。
* 不暴露公网入站端口（照抄 outbound-only / Tailscale；报告 §8 安全坑）。

## 实施计划 (PR0–PR5，小步可独立验证)

| PR | 内容 | 验证 |
|----|------|------|
| **PR0** | 脚手架：git init + pnpm workspace（`bridge/` Node-TS、`web/` PWA）+ lint/tsc + README 骨架 | 装得上、跑得起 |
| **PR1** | Bridge PTY 核心：spawn `claude.cmd` + 持久 PTY + 字节环形 scrollback + ws(output/input/resize) + **三大坑修复**（逐字符喂/resize-alive/剔除 API key）；桌面浏览器 xterm.js 能驱动 cc | 验收① (本地) |
| **PR2** | 重连补流：lastSeq/replay + 12s ping/pong + backoff（抄 wootty 契约）；切后台/断网能补回 | 验收③ |
| **PR3** | PWA 化 + Tailscale：manifest/SW + 加主屏 + `tailscale serve --bg`；手机经 wss 连上、独立输入框发 prompt | 手机能用 |
| **PR4** | 审批+通知：`.claude/settings.json` 配 `PreToolUse`(http)+`Stop` hook；bridge `/hooks/pre-tool-use` → ntfy(http action 通过/拒绝) → 回 `permissionDecision`；token 鉴权 + 超时安全默认 | 验收② |
| **PR5** | 加固+文档：退出/崩溃处理、完整 README（PC：tailscale serve/ntfy topic/hook 配置；手机：加主屏+ntfy app） | 可交付 |

> 动手前先跑 5 分钟官方 `claude remote-control` 作 UX 基线对照（Q6 决议）。

> **进度（2026-06-02）**：PR0–PR3 代码完成并经 `trellis-check`——含 bridge 在**同端口**（`127.0.0.1:8866`）serve PWA(`web/dist`) + ws（一条 `tailscale serve --bg 8866` 即可 front 单一 origin，契约见 `.trellis/spec/backend/bridge-serving.md`）、PWA manifest/SW + 加主屏、独立输入框（IME 守卫 / `\r` 提交）。bridge 27 + web 13 测试 + lint/typecheck/build 全绿。**PR3 的 `tailscale serve` + 手机实连**（验收①③）留用户环境实测（环境探测时本机未装 Tailscale）；PR4（审批+通知）、PR5（加固+文档）未开始。

## Out of Scope (explicit, MVP — 均为 fast-follow)

* **移动输入工具条**（按键栏 Esc/Ctrl/方向键）、**多会话/多项目切换**、**bridge 开机自启**(Windows 服务)——本次 defer。
* **原生 App**（Live Activities / Apple Watch，真 moshi 手感）。
* **自托管 Web Push**（收进 PWA、甩掉 ntfy app）——MVP 先用 ntfy。
* **cx (Codex) 支持**（bridge 同样 spawn `codex`，后续扩展）。
* 云端 microVM 沙箱（报告架构三）；E2EE / 自托管 relay（报告架构二，做产品再上）；多用户 / 商业化。

## Technical Notes

* **环境探测结果（2026-06-01，Git-Bash MINGW64）**：
  - cc = **v2.1.159，Windows 原生 Node（fnm 管理）**，不在 WSL；用户项目在 Windows 盘 `D:\Code`。
  - Git-Bash 里 **无 tmux / 无 mosh**；有 `ssh` 客户端，无 sshd；**Tailscale 未安装**；node/npm/pnpm/python3.13 均在。
  - **WSL Ubuntu 存在但 Stopped**（另有 docker-desktop）。开发机是 Windows，未见 Mac。
  - 含义：字面 moshi 栈(mosh+tmux)非现成，需 Unix 环境(WSL) 或改用 Windows 原生 PTY 桥(node-pty/ConPTY)。
* 决策地图与可抄项目清单：见 `移动端远程控制CC-CX方案探索报告.md`（5 轴 §1 / 架构 §4 / 接口 §5 / 坑 §8）。
* 证据目录（可复现）：`C:\tmp\smart-search-evidence\mobile-cc-cx\`（01–36）。
* 核心接口：cc 走 Agent SDK / `claude -p stream-json`；cx 走 `codex app-server`。
* 候选骨架许可证：ccpocket / Happy = MIT（可闭源商用）；Paseo = AGPL-3.0（慎 fork）。

## Research References

* [`../../../移动端远程控制CC-CX方案探索报告.md`](../../../移动端远程控制CC-CX方案探索报告.md)
  — 全赛道决策地图；5 决策轴、3 套可照搬架构、cc/cx 接口、坑与法务。
