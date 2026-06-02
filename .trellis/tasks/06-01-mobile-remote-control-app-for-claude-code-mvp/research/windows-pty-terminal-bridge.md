# Research: Windows 原生持久化伪终端桥（spawn Claude Code，镜像到浏览器/手机）

- **Query**: 如何在 Windows 原生（非 WSL）构建持久化 PTY 桥，spawn `claude` 并通过 WebSocket 实时镜像到 xterm.js PWA；node-pty/ConPTY 现状与坑、会话持久不靠 tmux、可抄开源实现、ws 协议最小集、最小选型与风险。
- **Scope**: 外部（库文档 / GitHub README、issues、PR；少量内部约束映射）
- **Date**: 2026-06-01
- **项目约束映射**: 路线①终端镜像；PC 端 Node/TS bridge + node-pty(ConPTY) 在 Windows 原生 spawn `claude`；bridge 进程持长生命 PTY + scrollback 缓冲接管 tmux 的会话持久职责（断开不丢、重连补流）；客户端 xterm.js PWA；工具链 Win11 + Node(fnm) + npm/pnpm。

---

## 结论（先读这一段）

这条路**完全可行且已有多个 2026 年的活跃先例**直接做同一件事（手机远控 PC 上的 Claude Code，终端镜像）。最贴近我们架构的参考是 **`StephenTowne/open-claude-remote`**（Node/TS + xterm.js + 50K 行 scrollback、重连自动恢复、多客户端 resize 以"最近活跃端"为准）和 **`icoretech/wootty`**（Go，但有一份非常干净、可直接照搬的 WS 协议 + 重连/replay 契约）。

技术栈层面三个最关键的事实：

1. **node-pty 当前对 ConPTY 是一等支持**，`winpty` 已被移除，最低要求 Windows 10 1809 (build 18309)；最新稳定版 **v1.1.0（2025-12-22）**，并已**随包发布 NAPI 预编译产物（win32-x64，ABI 稳定）**，正常 `npm install` 不需要本地 C++ 编译，可绕开 Spectre 库这个最大的 Windows 安装坑。
2. **会话持久不靠 tmux 是标准做法**：bridge 进程常驻、PTY 不随客户端断开而退出，输出写进一个环形/字节上限的 scrollback 缓冲；重连时把缓冲一次性回放给新 xterm.js 实例（用 `@xterm/addon-attach` 收流，可选 `@xterm/addon-serialize` 做快照）。多个参考实现（open-claude-remote 50K 行、wootty 5MB 字节、ttyd/gotty 的 `--reconnect`）都是这个模式。
3. **有一个 Claude Code 专属的 Windows 致命坑必须现在就知道**：node-pty 在 Windows 上会把**批量 `write()` 自动包进 bracketed-paste 标记** (`\x1b[200~...\x1b[201~`)，Claude Code 的 TUI 把紧跟其后的 `\r` 当成粘贴内容的一部分，导致**提示词永远提交不出去**。已验证的修复是**逐字符输入 + 小延迟（~15ms）**，让 `\r` 被识别为真正的回车（来源：`JacquesGariepy/claude-pty-wrapper`，已对 Claude Code v2.1.141 / Win11 / PS / Node 22 实测）。

---

## 选型建议（对我们最合适的最小栈）

| 层 | 选型 | 理由 |
|---|---|---|
| PTY | **node-pty v1.1.0+（或 1.2.0-beta，已带 win32-x64 prebuilds）** | 官方、ConPTY 一等支持、VS Code 同款；prebuild 避开本地编译 |
| Bridge | **Node/TS 常驻进程**，持 1 个长生命 PTY/会话 + 会话注册表 | 与团队栈一致；PTY 生命周期与 WS 连接解耦 |
| 缓冲 | **字节上限的环形缓冲**（建议 2–8 MB，对标 wootty 5MB / open-claude-remote 50K 行）+ 单调递增 seq | 重连补流；字节上限比行数上限更可控内存 |
| 传输 | **原生 `ws`（WebSocket）**，文本帧传 ANSI 输出，控制帧用小 JSON | 最简单；xterm.js AttachAddon 原生支持 string/binary |
| 前端收流 | **`@xterm/xterm` + `@xterm/addon-attach`（改造版）+ `@xterm/addon-fit`** | AttachAddon 只有 ~50 行，直接 fork 加 resize/replay 语义 |
| 快照（可选） | `@xterm/addon-serialize`（仅当你想"服务端重启后仍能恢复一屏"时） | 注意 ~25MB/s 串行化上限，别每帧调用 |

**明确不建议**：MVP 阶段不要为了"省事"去包 ttyd/gotty 二进制——它们 spawn-per-connection、靠外部 tmux 做持久，正好和我们"bridge 自己接管持久"的设计冲突；而且把 Claude 的 bracketed-paste 修复塞进一个 C/Go 二进制里很别扭。自建 Node bridge 反而更短、更可控。

**推荐的 PTY spawn 形态**（Windows）：
```ts
import * as pty from 'node-pty';
const p = pty.spawn('claude.cmd', [], {   // Windows 上是 claude.cmd
  name: 'xterm-256color',
  cols, rows,
  cwd, env: process.env,
  // useConpty 已 deprecated（issue #871），不要再传；ConPTY 在 build>=18309 自动启用
});
```

---

## Findings

### 1) node-pty 在 Windows(ConPTY) 的现状与坑

**版本与构建**
- 最新稳定 **v1.1.0**，published 2025-12-22（约本研究日期前 4 个月）；另有活跃的 **1.2.0-beta.x**。来源: <https://www.npmjs.com/package/node-pty> ; <https://github.com/microsoft/node-pty/releases/tag/v1.1.0>
- **winpty 已彻底移除**，README 原文："Support for the `winpty` library has been removed. Windows 10 version 1809 (build 18309) or later is now required." 来源: <https://github.com/microsoft/node-pty/blob/main/README.md>
- **已随包发布 prebuilds**（PR #803/#804/#809：scaffolding → add prebuilds to published package → load native addons directly from prebuilds directory）。这些是 **NAPI prebuilds，ABI 跨 Node/Electron 版本稳定**，正常安装不再需要 node-gyp 编译。来源: release notes 同上；issue #46 评论确认 NAPI 化后 prebuilt 方案（`@lydell/node-pty` 用 optionalDependencies 同款思路）。
- 原生编译（仅当强制从源码构建，如 Electron `electron-rebuild -f`）需要：Python + C++ 编译器 + **Windows SDK（Desktop C++）** + **MSVC v143 Spectre-mitigated libs**（否则报 `MSB8040: Spectre-mitigated libraries are required`）。来源: npm README "Windows" 段；真实踩坑案例 <https://github.com/daintreehq/daintree/issues/4145>（"node-pty 1.2.0-beta.12 ships NAPI prebuilds in prebuilds/win32-x64/ … forced compilation isn't actually needed for node-pty anymore"）。
- **对我们的含义**：用普通 `npm/pnpm install` + 默认 prebuild 即可，**不要加 `-f` 强制重编**；只有打 Electron 包或自定义 Node ABI 时才需要装 Spectre 组件。fnm 切 Node 大版本后若用的是源码构建则需 `npm rebuild node-pty`（来源: `xdrr/ptyai` README）。

**ConPTY 选项 / DLL**
- `useConpty` **已 deprecated 且被忽略**（issue #871）；ConPTY 在 Windows build >= 18309 自动启用。来源: typings/node-pty.d.ts 注释 <https://github.com/microsoft/node-pty/blob/main/typings/node-pty.d.ts>
- 可选 `useConptyDll`（默认 false）：使用**随 node-pty 包自带的 conpty.dll / OpenConsole.exe**，而不是 Windows 内置的那份——好处是 ConPTY 行为不受用户 Windows 版本漂移影响（包里锁定 conpty 版本，如 #811 "Update conpty to 1.23.251008001"）。来源: typings + release notes（PR #694, #811, #704 "Copy right dll/exe based on npm_config_arch"）。
- `clear()`：**仅在 Windows/ConPTY 有效**，"useful if the buffer is cleared on the frontend in order to synchronize state with the backend to avoid ConPTY possibly reprinting the screen." 对**重连场景很关键**——重连回放后可能需要它来避免 ConPTY 重绘整屏造成重影。来源: typings/node-pty.d.ts。

**已知 issue（务必防御）**
- **resize-after-exit 崩溃（高危，Win + Node v22）**：PTY 退出后若仍收到 resize，node-pty 在 native 层抛 `Error: Cannot resize a pty that has already exited`，**因为是 native 异步回调里抛的同步异常，你外层的 try/catch 抓不到，直接 crash 整个进程**。Node v22 因事件循环时序更易触发。来源: issue #827 <https://github.com/microsoft/node-pty/issues/827> ; 重复 issue #892 ; 修复 PR #901 "swallow resize() errors after PTY exit on Windows and Unix" <https://github.com/microsoft/node-pty/pull/901>。
  - **缓解**：自己维护 `alive` 标志，resize 前判断；并升级到含 #901 的版本。我们这个项目恰好"PTY 长命、客户端频繁 resize"，命中概率高。
- **kill() 后进程不退出（Win）**：`ConoutConnection` worker 线程及其 socket/timeout **从未 `unref()`**，导致 `kill()` 并 await `exit` 后 Node 仍因 active handle 无法退出，consumer 被迫 `process.exit()`。来源: issue #887 <https://github.com/microsoft/node-pty/issues/887>（node-pty 1.2.0-beta.10 / Node v22.22）。
  - **缓解**：bridge 关停时显式 `process.exit()`，或 patch/等上游修；不要假设 `kill()` 能让事件循环自然 drain。
- **Ctrl+C / "Terminate batch job (Y/N)"**：Windows 历史问题（issue #168），ConPTY 已大幅改善但 `.cmd` 包装层（如 `claude.cmd`）仍可能出现，需要在 UI 上给"是/否"按钮或直接发 `y\r`。来源: PR #236 / #168 关联。
- **Powershell 8009001d**：PS 启动时缺 `SystemRoot` env 会报错——spawn 时务必透传完整 `process.env`。来源: npm README Troubleshooting。
- **保真度（ANSI/256/鼠标/CJK）**：ConPTY 路径下全 ANSI/256 色没问题；`@xterm/headless` 系实现普遍声明 VT100/VT220/xterm-256color + UTF-8 + alt-screen + 鼠标可用（来源: `xdrr/ptyai`, `JacquesGariepy/claude-pty-wrapper` 用 `@xterm/headless` 做屏幕仿真）。**CJK/宽字符**：xterm.js 端 CJK/IME 支持成熟（ttyd 明确以 "CJK and IME support" 为卖点）。**但 IME/语音听写直接打进 raw xterm.js 会重复**（iOS dictation 把字打两遍），这是已知 xterm.js IME 行为，参考实现用"独立输入框 + 发送"绕开。来源: `buckle42/claude-code-remote` README（Voice Wrapper 段）。

**Claude Code 专属、最容易被忽视的坑（高优先级）**
- node-pty 在 Windows 上把**批量 `write()` 自动包 bracketed-paste** (`\x1b[200~ … \x1b[201~`)；Claude Code 2.1 的 TUI 把紧随的 `\r` 当作粘贴内容，**提示词卡在输入框、永不提交**。修复：**逐字符写入 + ~15ms 延迟**（`CLAUDE_CHAR_DELAY_MS`），让 `\r` 成为真正的 Enter。原文："This is the single most important fix in the wrapper." 来源: `JacquesGariepy/claude-pty-wrapper` README <https://github.com/JacquesGariepy/claude-pty-wrapper>（实测 Claude Code v2.1.141 / Win11 / PowerShell / Node 22）。
  - **对我们的含义**：手机端"发送整条消息"时，bridge 侧要么逐字喂 PTY，要么显式去掉/规避 bracketed-paste 包裹后再补 `\r`。这是 MVP 必须处理、否则"看起来连上了但发不出消息"的典型 bug。

---

### 2) 会话持久不靠 tmux 怎么做

核心模式（所有参考实现一致）：**PTY 生命周期与 WS 连接解耦**——bridge 进程常驻，spawn 一次 `claude`，PTY 的 `onData` 永远往一个 scrollback 缓冲里写；客户端断开**不杀 PTY**；重连时新建 WS，把缓冲一次性回放，再开始增量推流。

**缓冲设计**
- 形态：**环形缓冲**。两种上限口径：
  - **行数上限**：`open-claude-remote` 用 `maxBufferLines` 默认 **50000 行**，"50K-line scrollback buffer, auto-restored on reconnect"。来源: <https://github.com/StephenTowne/open-claude-remote> README（Terminal Sync 段 + 配置表）。
  - **字节上限**：`wootty` 用 `WOOTTY_HISTORY_BYTES` 默认 **5 MiB（5242880）** "Buffered output bytes for replay"。来源: <https://github.com/icoretech/wootty> README。
  - **建议**：用**字节上限**（内存更可控，ANSI 输出行长差异大）；2–8MB 起步。
- 重连回放：把缓冲拼成一个大字符串/字节块，`terminal.write(buffer)` 一次写回即可（xterm.js 的 write 是高吞吐解析器，这正是它擅长的）。

**会话保留 / TTL**
- `wootty` 的"Session Retention Model"很值得抄：会话元数据 + PTY 状态**仅在内存**；进程退出则会话立即删除；进程仍活但无人 attach 时按 `WOOTTY_DETACHED_TTL_MS`（默认 24h，`0` = 永不超时）清理；**服务端重启清空所有会话**（无持久化存储）。长任务建议把 TTL 调到 72h。来源: <https://github.com/icoretech/wootty> README。
- `open-claude-remote` 同样 `sessionTtlMs` 默认 **24h**。
- **对我们的含义**：MVP 用内存会话表 + TTL 足够；"PC 重启后还能恢复"不是 MVP 必需。

**xterm.js addon 的角色（关键区分）**
- **`@xterm/addon-attach`（收流，必用）**：把 WebSocket 黏到 xterm.js——收到 server 消息就 `terminal.write()`，`terminal.onData` 就 `socket.send()`。源码只有约 50 行，string 与 binary（arraybuffer）两种模式都支持。**MIT。** 来源: <https://github.com/xtermjs/xterm.js/blob/master/addons/addon-attach/src/AttachAddon.ts>
  - 重要细节：构造时强制 `socket.binaryType = 'arraybuffer'`；binary 发送是 `charCodeAt(i) & 255` 逐字节打包（即把 xterm.js 给的"latin1 字符串"还原成字节）。
  - **局限**：官方 AttachAddon **不含 resize、不含 replay 语义**——你必须 fork 或在外面叠一层控制协议（见第 4 节）。社区常见做法是自定义二进制协议带 `MESSAGE/RESIZE/CLOSE/AUTH/PING/ATTACH` action（参考 gist `eslym/CustomAttachAddon.ts`：用 DataView 前 4 字节放 action，RESIZE 帧带 cols/rows）。来源: <https://gist.github.com/eslym/d3bd7809681aa9c1eb34913043df9bb6>
- **`@xterm/addon-serialize`（快照，可选）**：把**某个 xterm.js 实例**的当前 framebuffer（含颜色/样式/光标/scrollback）序列化成一个字符串，写回新终端即可恢复。来源: <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize>
  - **它是前端到前端的快照**（典型用途：VS Code 重载后恢复终端、tab 拖拽）。我们的"断开重连补流"其实**用服务端字节缓冲回放就够了，不一定需要 serialize**。
  - 若要在**服务端**用 serialize（例如服务端跑 `@xterm/headless` 维护一份权威屏幕、客户端重连给一屏快照而非整段历史），注意两个坑：
    - **性能**："The fastest serializer version … at ~25MB/s … doing 100k scrollbuffer in roughly ~1s。" **不要每帧 serialize**（典型反模式，会把上面的行反复重序列化）。来源: PR #3101 评论 + discussion #4467 <https://github.com/xtermjs/xterm.js/discussions/4467>
    - **尺寸**：恢复时"write the serialized data into a terminal of the same size in which it originated"，否则有重排伪影；先按原尺寸 write，再 resize。来源: addon-serialize typings 注释 + discussion #4467。
- **ConPTY 重绘 + 重连重影**：回放历史后，ConPTY 可能"reprint the screen"导致重复；node-pty 的 `pty.clear()` 就是为同步前后端 buffer、避免这个而存在。来源: typings/node-pty.d.ts。

**断点续传策略（建议）**
- 给每个输出 chunk 配**单调递增 seq / byte offset**；客户端在 `attach` 时带上"我已收到的最后 seq"；服务端只回放缺失部分（缓冲内则增量、超出缓冲则发"已截断 + 全量当前缓冲"）。wootty 即把这类逻辑沉到 `session/protocol` 与"In-memory replay buffer"。来源: <https://github.com/icoretech/wootty> README 架构图与 `features/terminal/session/protocol/*` 说明。

---

### 3) 可抄的开源实现（重点：Windows 行为 + 协议）

| 项目 | 语言 | 原生 Windows | 会话持久方案 | 协议要点 | 许可证 | 与我们的契合度 |
|---|---|---|---|---|---|---|
| **StephenTowne/open-claude-remote**（= @alipay/open-claude-remote / "Claude Code Remote"）| **Node/TS** + xterm.js | 未在 README 显式声明 Win（装 `tnpm` 包，依赖 `claude` CLI）；架构与我们一致，值得直接读其 backend | **内存** PTY + **50K 行 scrollback，重连自动恢复**；`sessionTtlMs` 24h；多实例单 daemon（端口 8866）| WS：`output`/`network_changed` 等；多客户端 resize 以"最近活跃端"为准；QR + token 鉴权 | 见仓库 LICENSE | **最高**：几乎就是我们要做的东西（手机远控 Claude、Node/TS、xterm、scrollback 重连） |
| **icoretech/wootty** | Go(后端) + React19 + xterm.js | 容器/主机；Go 跨平台 | 内存 replay buffer；`WOOTTY_HISTORY_BYTES` 5MB；`WOOTTY_DETACHED_TTL_MS` 24h(0=永久)；进程退出即删 | **协议契约写得最清楚**：inbound `ready/output/exit/error/pong`；`ready` 带 `sessionId/readOnly/version`；心跳 client 每 12s `ping`，丢 `pong` 12s 触发 close code `4103`；reconnect backoff `300ms*1.8^attempt` 上限 5000ms；close codes 4101 手动重连 / 4102 新会话 / 4103 pong 超时；resume by `sessionId` + replay | **MIT** | **高（协议直接照搬）** |
| **tsl0922/ttyd** | **C**(libwebsockets+libuv) + xterm.js | **原生支持**（`winget install tsl0922.ttyd` / scoop / 二进制）；CJK+IME | **无内建持久**——spawn-per-connection；持久靠外部 `tmux new -A`；`-P` ping interval、`disableReconnect` client option | WS 二进制：首字节是命令（`0`=output、`1`=resize-as-JSON `{cols,rows}` 等，见其源码 protocol）；`-W` 才可写 | MIT | 中（学协议/Windows 打包，不抄持久） |
| **butlerx/wetty** | **Node/TS** + xterm.js | Node 跨平台（主打 SSH/login，非原生 console 程序）| 无内建持久（靠 SSH/tmux）| Socket.io；`input`/`output`/`resize` | **MIT** | 中（Node 同栈，可看其 pty↔socket 黏合） |
| **sorenisanerd/gotty**（yudai/gotty 的活跃 fork）| **Go** + xterm.js | Go 跨平台（Windows console 兼容性弱，历史上需 winpty 包装）| 无内建持久；`--reconnect` + `--reconnect-time` 仅"断线后客户端重连"，**不保留服务端会话**；共享单进程靠 tmux | WS：output 中继 + input/resize 回传；`--ws-origin` origin 校验 | **MIT** | 中（协议简单，Windows 弱） |
| **code-server 的 terminal** | Node/TS（VS Code 内核）| VS Code 终端用 node-pty，Windows 一等 | VS Code 的 terminal persistence（reconnect across reload）正是 SerializeAddon 的主推用例（microsoft/vscode#20013）| 自有 RPC，不易单独抽取 | MIT | 低（重，不建议抄，但印证 node-pty+serialize 路线） |
| **TongilKim/ClauTunnel** | Node（Claude **Agent SDK**，非 PTY 镜像）| — | **Supabase Realtime** 中转；声称比官方 remote-control 更耐断线 | 走 Agent SDK 的结构化 `output/status/permissions/input/commands`，**不是终端字节流** | 见仓库 | **低/反例**：它走的是路线②（Agent SDK 结构化），不是我们的终端镜像；可作"另一条路"对照 |
| **amantus-ai/vibetunnel** | Swift(menubar) + web | **macOS only**（Apple-Silicon Mac menubar app）| asciinema 录制；Tailscale/ngrok/cloudflared 隧道 | `vt` 包装命令转发 stdin/stdout | 见仓库 | 低（macOS 专属，不能直接用，但 UX/隧道思路可借鉴） |
| **buckle42/claude-code-remote** | 脚本（ttyd+tmux+FastAPI）| **macOS** | **ttyd + tmux** 经典组合 | ttyd 的 WS | 见仓库 | 低（正是我们想避开的 tmux 方案，但 IME 重复坑的教训有用） |

**最该精读的两个**：`open-claude-remote`（架构同构、Node/TS）+ `wootty`（协议/重连契约最完整）。

---

### 4) ws 终端协议最小集（建议）

基于 AttachAddon 语义 + wootty 契约 + CustomAttachAddon 的二进制 action 思路，给出一个**够用又好扩展**的最小协议。原则：**高频的 PTY 输出/输入走"裸"通道（文本或二进制帧）零开销；低频控制走小 JSON**。

**传输选择**：MVP 用 `ws` 的**文本帧传 ANSI 输出**（UTF-8，xterm.js `terminal.write(string)` 直接吃）最省事；若担心二进制安全/性能再切 binary（`binaryType='arraybuffer'`，server 发 `Buffer`）。注意：要么纯 string、要么纯 binary，两端必须一致（来源: xterm.js issue #1972 jerch 的解释）。

**Server → Client**
| 消息 | 形态 | 字段 | 说明 |
|---|---|---|---|
| `ready` | JSON | `sessionId`, `cols`, `rows`, `readOnly`, `lastSeq`, `version` | 连接建立/attach 成功后首帧（对标 wootty `ready`）|
| `output` | **文本/二进制帧**（裸） | data（ANSI 字节）| 高频，零包裹；如需续传则前缀一个 seq（或单独 `output` JSON 带 `seq`+`data`）|
| `replay` | 一个大 `output` | 缓冲全量/增量 | 重连补流；客户端 write 完再进入实时（建议恢复后服务端发一次 `pty.clear()` 协调，避免 ConPTY 重绘重影）|
| `exit` | JSON | `code`, `signal` | PTY 退出（对标 wootty）|
| `error` | JSON | `message`, `code?` | 错误（对标 wootty）|
| `pong` | JSON/控制帧 | — | 心跳应答 |

**Client → Server**
| 消息 | 形态 | 字段 | 说明 |
|---|---|---|---|
| `attach` | JSON | `sessionId?`, `lastSeq?`, `cols`, `rows`, `token` | 首帧；带 `sessionId`+`lastSeq` 表示重连续传；不带表示新会话 |
| `input` | **文本/二进制帧**（裸） | data | 高频；**Windows+Claude 注意逐字符/规避 bracketed-paste**（见 §1）|
| `resize` | JSON | `cols`, `rows` | 低频；**server 侧 resize 前判 PTY alive，避免 #827 崩溃**；多端连接时以"最近活跃端"为准（对标 open-claude-remote）|
| `ping` | 控制帧 | — | 心跳 |

**重连/续传 + 心跳（抄 wootty 的数值，已被实战验证）**
- 客户端每 **12s** 发 `ping`；服务端 **12s** 没收到则关连接（close code `4103` pong timeout）触发重连。
- 重连 backoff：`reconnectDelayMs = 300ms * 1.8^attempt`，上限 `5000ms`。
- Close codes 语义：`4101` 手动重连 / `4102` 开新会话关旧连接 / `4103` pong 超时。
- 续传：`attach` 带 `lastSeq` → 服务端从缓冲发缺失片段；缓冲已滚掉则发"全量当前缓冲 + 标记 truncated"。
来源: <https://github.com/icoretech/wootty> README "Transport Lifecycle Contract"。

**鉴权（MVP）**：QR + 一次性 token（open-claude-remote / claude-code-remote 都这么做），WS 握手时校验；非 loopback 绑定强制要 token（wootty `WOOTTY_AUTH_TOKEN` 失败即拒）。

---

## 风险 / Caveats / Not Found

**主要风险**
1. **resize-after-exit 进程级崩溃（高）**：native 抛错绕过 JS try/catch（issue #827/#892）。必须：维护 alive 标志 + resize 前判断 + 升级到含 PR #901 的版本。我们"长命 PTY + 频繁 resize"高度命中。
2. **Claude Code bracketed-paste 提交失效（高）**：批量 write 导致 `\r` 失效，"看似连上但发不出"。MVP 必须逐字符喂或规避包裹（claude-pty-wrapper 已验证）。
3. **kill() 后进程不退（中）**：ConoutConnection worker 未 unref（issue #887），关停可能挂起；用显式 `process.exit()` 兜底。
4. **IME/语音听写重复（中，主要影响手机端）**：直接打进 raw xterm.js 会重复；用独立输入框 + 发送绕开（claude-code-remote 教训）。
5. **fnm 切 Node 大版本后 ABI 不匹配（低-中）**：NAPI prebuild 跨版本稳定，但若曾源码编译则需 `npm rebuild node-pty`。锁定 Node 版本可避免。
6. **serialize 性能/尺寸（低，仅当用 serialize）**：勿每帧调用（~25MB/s 上限）；恢复需同尺寸。我们用服务端字节缓冲回放可基本绕开。

**未验证 / 需要 PoC 实测**
- `open-claude-remote` / `wootty` 的 README 未逐条声明"在 Windows 原生跑得多稳"——本研究确认了 node-pty 在 Windows 一等支持与具体坑，但**这两个上层项目的 Windows 实测稳定性需要我们自己跑一遍 PoC**（尤其 resize 风暴 + Claude TUI 交互）。
- node-pty 鼠标事件（MOUSE_EVENT_RECORD）在 ConPTY 下对 Claude TUI 的完整保真度未单独验证（PR #236 评论提到鼠标支持是单独议题）；Claude Code 当前主要是键盘 TUI，风险低但未实测。
- 没有找到一个"Node/TS + node-pty + 原生 Windows + 手机镜像 Claude"四要素**全部明确打勾**的现成仓库——`open-claude-remote` 缺 Windows 明示，ttyd 缺 Node/持久，ClauTunnel 走的是 Agent SDK 而非终端镜像。**结论仍是自建 Node bridge，借鉴 open-claude-remote 架构 + wootty 协议。**

## 来源链接（核心）
- node-pty README（winpty 移除 / 1809+）: https://github.com/microsoft/node-pty/blob/main/README.md
- node-pty v1.1.0 release（prebuilds / conpty 版本）: https://github.com/microsoft/node-pty/releases/tag/v1.1.0
- node-pty npm（版本/构建/Spectre/Troubleshooting）: https://www.npmjs.com/package/node-pty
- node-pty typings（useConpty deprecated #871 / useConptyDll / clear()）: https://github.com/microsoft/node-pty/blob/main/typings/node-pty.d.ts
- resize-after-exit crash #827: https://github.com/microsoft/node-pty/issues/827 ; 修复 PR #901: https://github.com/microsoft/node-pty/pull/901 ; #892: https://github.com/microsoft/node-pty/issues/892
- kill 后不退出 #887: https://github.com/microsoft/node-pty/issues/887
- Spectre 真实踩坑 + prebuild 绕开: https://github.com/daintreehq/daintree/issues/4145
- Claude Code bracketed-paste 致命坑: https://github.com/JacquesGariepy/claude-pty-wrapper
- open-claude-remote（最贴近架构）: https://github.com/StephenTowne/open-claude-remote
- wootty（协议/重连契约最全）: https://github.com/icoretech/wootty
- ttyd（原生 Windows / CJK）: https://github.com/tsl0922/ttyd
- wetty: https://github.com/butlerx/wetty ; gotty: https://github.com/sorenisanerd/gotty
- ClauTunnel（Agent SDK 对照）: https://github.com/TongilKim/ClauTunnel ; VibeTunnel: https://github.com/amantus-ai/vibetunnel
- xterm AttachAddon 源码: https://github.com/xtermjs/xterm.js/blob/master/addons/addon-attach/src/AttachAddon.ts
- 自定义二进制协议 gist（action/RESIZE 帧）: https://gist.github.com/eslym/d3bd7809681aa9c1eb34913043df9bb6
- xterm SerializeAddon: https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize ; 性能/尺寸讨论 #4467: https://github.com/xtermjs/xterm.js/discussions/4467
- ptyai（@xterm/headless + ConPTY 跨平台声明）: https://github.com/xdrr/ptyai
