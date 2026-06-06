# mobile-ssh — 手机远程控制 PC 上的 Claude Code（真·类 moshi）

从手机实时查看并操控跑在 **Windows PC** 上的 Claude Code (cc)：看终端、发 prompt、一键审批、收完成通知，
**代码不离机**。

> **路线①（终端镜像）**：Windows 原生 **node-pty(ConPTY) bridge** 持有 `claude` 的持久伪终端 + scrollback，
> 通过 **WebSocket** 镜像给 **xterm.js PWA**；手机经 **Tailscale**（`tailscale serve` 自动 HTTPS）连入；
> 工具审批走 cc 的 **`PreToolUse` (type:http) hook**，通知用 **ntfy**。
>
> 完整需求 / 决策 / 研究：`.trellis/tasks/06-01-mobile-remote-control-app-for-claude-code-mvp/`
> （`prd.md` + `research/`）。动手前可先跑 5 分钟官方 `claude remote-control` 作 UX 基线对照。

## 架构

```
手机 PWA  (https://<host>.<tailnet>.ts.net  ← tailscale serve 拿 HTTPS = secure context)
  │  wss: output↓ / input·resize↑           │  通知: ntfy app 订阅 topic
  ▼                                          ▲
[Windows bridge: Node/TS]
  ├─ node-pty(ConPTY) spawn claude.cmd  (持久 PTY + 字节环形 scrollback)
  ├─ ws server: 终端镜像 + 重连补流 (lastSeq / replay)
  ├─ POST /hooks/pre-tool-use ← cc PreToolUse(type:http) 同步阻塞 → 推 ntfy → 等手机决定 → 回 permissionDecision
  └─ Stop hook → 推「完成」；spawn 前剔除 ANTHROPIC_API_KEY（保订阅额度）
```

## 仓库结构

- `bridge/` — Node/TS 常驻进程：node-pty 持有 PTY、ws 镜像、审批/通知 hook endpoint。
  - `src/config.ts` — env 驱动配置（端口/scrollback/字符延迟/cwd/web-dist）。
  - `src/scrollback.ts` — 字节上限环形 scrollback（带单调 seq）。
  - `src/pty-session.ts` — 持久 PTY 会话：spawn、alive 标志、逐字符写入、安全 resize、剔除 API key。
  - `src/protocol.ts` — ws 消息协议（ready / output / exit / input / resize + PR4 审批帧 approval_request/resolved/decision）。
  - `src/ws-server.ts` — 单 http.Server 同端口托管 PWA(static) + ws + PR4 HTTP API：ws 握手 `?token=` 鉴权、attach 回放 + 实时镜像 + input/resize 转发、审批帧广播。
  - `src/static-server.ts` — 服务 `web/dist` 的静态处理器（app-shell 回退、`/sw.js` no-cache、防目录穿越、未构建则 503）。
  - `src/approval.ts` — （PR4）pending 审批注册表：create→promise，多通道 resolve（ws/ntfy nonce/超时），fail-closed 默认。
  - `src/api-server.ts` — （PR4）HTTP API handler：`/hooks/pre-tool-use`（阻塞审批）、`/hooks/stop`、`/hooks/notification`、`/approvals/<id>`（ntfy 回调），在 static **之前**分发。
  - `src/ntfy.ts` — （PR4）outbound ntfy 推送（JSON publishing + http-action 按钮）；无 topic 则跳过不报错。
  - `claude-hook.example.json` — （PR4）cc hook 配置**示例**（PreToolUse/Stop[/Notification]，http + Bearer）；**不是** live settings，装进目标项目的 `.claude/settings.json`。
  - `src/index.ts` — 组装入口 + 优雅退出 + 打印 capability URL。
- `web/` — xterm.js PWA 客户端（Vite）。
  - `public/manifest.webmanifest` — PWA manifest（`display: standalone`，可加主屏/独立窗口启动）。
  - `public/sw.js` — 最小 Service Worker（缓存 app shell，installable + 离线兜底；只拦同源 GET，**不碰** POST /hooks /approvals）。
  - `public/icons/` — PWA 图标（192/512 PNG，由 `scripts/generate-icons.mjs` 生成的占位图，待美术替换）。
  - `src/protocol.ts` — 客户端侧协议镜像（与 bridge 逐帧保持同步）。
  - `src/bridge-client.ts` — 自写的 xterm.js ↔ ws 桥（不用官方 AttachAddon）；PR4 加审批帧回调 + `sendApprovalDecision`。
  - `src/input-box.ts` — 输入框纯逻辑（submit/IME 判定、发送 payload 构造），可单测无 DOM。
  - `src/approvals.ts` — （PR4）审批卡片纯状态机（add/resolve），可单测无 DOM。
  - `src/main.ts` — 挂载终端 + 连接 bridge + 注册 SW + 接独立输入框 + capability URL token 处理 + 渲染审批卡片。

## 开发

前置：**Node 18+**（本仓库用 fnm 管理）、**pnpm**。

```bash
pnpm install
pnpm --filter @mobile-ssh/web build   # 先构建 PWA，bridge 才能托管 web/dist（否则 HTTP 返回 503 提示）
pnpm dev:bridge    # 启动 bridge：spawn claude.cmd + 持久 PTY + 同端口托管 PWA + ws（默认 http://127.0.0.1:8866，PWA + ws）
pnpm dev:web       # 启动 PWA dev server (127.0.0.1:5173)；改 UI 时用，连 ws://127.0.0.1:8866
pnpm typecheck     # 全量类型检查
pnpm lint          # ESLint
pnpm test          # 运行测试（bridge 的 PTY 冒烟测试经 node-pty 真起 PTY；web 的纯逻辑单测：重连 + 输入框 submit/IME）
pnpm build         # 构建（web build 会把 manifest/sw.js/icons 拷进 web/dist）
```

### Bridge 环境变量

| 变量 | 默认 | 作用 |
|------|------|------|
| `BRIDGE_PORT` | `8866` | 监听端口（仅 `127.0.0.1`）——**同时**提供 PWA(HTTP) 与 ws，故一条 `tailscale serve --bg 8866` 即可前置整个 origin |
| `SCROLLBACK_BYTES` | `4194304`（4MB） | 字节环形 scrollback 上限 |
| `CLAUDE_CHAR_DELAY_MS` | `15` | 逐字符喂 PTY 的间隔（绕开 bracketed-paste 坑） |
| `BRIDGE_CWD` | `process.cwd()` | spawn `claude` 的工作目录 |
| `WEB_DIST` | 解析到仓库 `web/dist` | bridge 托管的已构建 PWA 目录；未构建时不崩溃（HTTP 返回 503 + 构建提示，ws 照常） |
| `BRIDGE_TOKEN` | 每次启动随机 UUID | （PR4）共享密钥：ws capability URL 的 `?token=` **与** cc hook 的 `Authorization: Bearer` 都用它。**不设则每次重启都变**，会让已保存的链接/已配的 hook 失效——**务必显式设一个固定值**以保持链接稳定 |
| `NTFY_TOPIC` | 未设（不推送） | （PR4）ntfy 订阅 topic（用长随机串当密码）。未设则只跳过推送，审批仍可在 PWA 卡片完成 |
| `NTFY_SERVER` | `https://ntfy.sh` | （PR4）ntfy 服务器地址；自托管时填你的（注意 iOS 即时性需 `upstream-base-url: https://ntfy.sh`，见研究 R3） |
| `APPROVAL_BASE_URL` | 未设（无按钮） | （PR4）手机经 tailscale serve 访问 bridge 的公网地址 `https://<host>.<tailnet>.ts.net`，用于拼 ntfy 通过/拒绝按钮的回调 URL。未设则推纯通知（无按钮），仍可用 PWA 卡片审批 |
| `APPROVAL_TIMEOUT_MS` | `280000`（280s） | （PR4）等待人类决定的上限；**必须 < cc hook 的 `timeout`（300s）**，到点 bridge 先返回 fail-closed 默认 |
| `APPROVAL_TIMEOUT_DECISION` | `deny` | （PR4）审批超时返回的决定（fail-closed，建议保持 `deny`） |

> bridge 启动时会**剔除 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`** 再 spawn `claude`，确保走订阅 OAuth 额度。
> bridge 启动日志会打印一条 **capability URL**（`https://<host>.<tailnet>.ts.net/?token=…`），把它在手机上打开即可——token 只打到本机 loopback 控制台。

### PR1 手动验证步骤

1. `pnpm dev:bridge`：bridge 在 `D:\Code`（或 `BRIDGE_CWD`）下 spawn `claude.cmd`，日志打印监听地址。
2. `pnpm dev:web`：浏览器开 `http://127.0.0.1:5173`，xterm.js 自动连 `ws://127.0.0.1:8866`，应看到 cc 的实时终端输出。
3. 在终端里**敲一条 prompt 并回车** → cc 能**正常提交**（验证 bracketed-paste 已修复：逐字符喂 + `\r` 被识别为回车）。
4. **拖动浏览器窗口 resize** → 终端跟随重排，bridge 不崩溃（PTY 存活时正常 resize；退出后 resize 被安全跳过）。
5. **刷新页面** → 重新连上后能**补回**之前的终端输出（scrollback 全量回放）。

> 自动化冒烟测试（`pnpm test`，不依赖真 `claude`）覆盖：output 流出、input 逐字符写入、resize 在 PTY 存活/退出后均不 crash、scrollback 回放顺序与 seq 单调、字节上限淘汰。

> 注：`node-pty` 自 v1.1.0 起随包发布 win32-x64 预编译产物，普通 `pnpm install` 即可，无需本地 C++ 编译。
> 若 pnpm 提示 node-pty 的 build script 被忽略，PR1 真正用到 PTY 前再 `pnpm approve-builds` 即可。

## 路线图（MVP）

| PR | 内容 | 状态 |
|----|------|------|
| PR0 | 脚手架（pnpm workspace + TS/ESLint + README） | ✅ |
| PR1 | Bridge PTY 核心（spawn + 持久 PTY + scrollback + ws + 三大坑修复） | ✅ |
| PR2 | 重连补流（lastSeq/replay + ping/pong + backoff） | ✅ |
| PR3 | PWA 化 + Tailscale（manifest/SW + bridge 同端口托管 PWA + tailscale serve + 手机连入 + 输入框） | 🟡 代码完成并经 trellis-check（PWA + 输入框 + bridge 同端口托管 web/dist）；`tailscale serve` + 手机实测留待用户环境 |
| PR4 | 审批 + 通知（PreToolUse http hook + Stop hook + ntfy + token 鉴权） | 🟡 代码完成（token 鉴权 + 三通道审批回路 + ntfy + Stop/Notification hook + 卡片）；hook 装进目标项目 + ntfy 实推留待用户环境 |
| PR5 | 加固 + 文档 | ⬜ |

## PWA / 移动端（PR3）

- **同端口托管**：bridge（`src/static-server.ts`）在**同一个端口**（默认 8866，仅 `127.0.0.1`）既服务 PWA 静态文件（`web/dist`）又服务 ws——靠 `Upgrade` 头区分。这样**一条 `tailscale serve --bg 8866`** 就把整个 origin 前置成 HTTPS，前端的同源 `wss://<host>`（`web/src/main.ts` `resolveBridgeUrl`）直接生效。先 `pnpm --filter @mobile-ssh/web build` 构建 PWA；未构建时 bridge 不崩溃，HTTP 返回 503 + 构建提示，ws 照常。`/sw.js` 以 `no-cache` 下发（保证 SW 更新生效），`/assets/*` 长缓存；并防目录穿越（越界一律 404）。
- **加到主屏**：手机浏览器打开 PWA（经下方 Tailscale HTTPS）→「分享 → 添加到主屏幕」→ 从主屏图标独立窗口（`display: standalone`）启动。iOS 上 Web Push（PR4）**必须**先加到主屏才生效（研究 R3）。
- **独立输入框**：终端下方有一个文本框 + 发送按钮，是移动端的主输入路径（直接打进 xterm.js 隐藏 textarea 在手机上别扭、且 iOS 听写/IME 会重复，见研究 R1）。
  - Enter 发送，Shift+Enter 换行；**组合输入（拼音/IME）期间 Enter 不触发发送**，只在最终合成文本上发出 → 避免重复。
  - 发送时下发 `文本 + "\r"`（`\r` 让 cc 提交），复用既有 `{type:"input"}` 通道，bridge 侧仍逐字符喂 PTY（PR1 bracketed-paste 修复）。
  - submit/IME 判定抽成纯函数 `shouldSubmit` / `buildSubmitPayload`（`src/input-box.ts`），有单测覆盖。
- **Service Worker**：`public/sw.js` 仅做 installable + app shell 离线缓存；注册在 `main.ts`，**仅在 secure context**（localhost / https）注册，裸 `http://100.x` 会跳过（不报错）。
- **图标**：`public/icons/icon-{192,512}.png` 是脚本生成的占位图（深色底 + `>_` 终端字形），`node scripts/generate-icons.mjs` 可重新生成；正式美术图标为 fast-follow。

### 真机连入 runbook（PowerShell 7）

bridge 同端口 serve PWA + ws，所以一条 `tailscale serve` 就把整个 origin 前置成 HTTPS、手机用同源 `wss://<host>` 直连。环境变量用 pwsh 的 `$env:VAR='…'`（**不是** bash 的 `VAR=val cmd` 前缀）。

```powershell
# 1) 构建 PWA（改了 web 代码后重跑）
pnpm --filter @mobile-ssh/web build            # → web/dist（含 manifest/sw.js/icons）

# 2) 起 bridge（长驻前台，这就是你的 cc 会话）
#    用 start 而非 dev:bridge——后者是 tsx watch，文件一保存就重启、连带杀掉 PTY 会话
$env:BRIDGE_CWD = 'D:\Code\要让cc干活的项目'
$env:BRIDGE_TOKEN = '一段固定的长随机串'              # PR4：固定值，链接才稳定；不设则每次重启都变
# 可选（PR4 通知/审批按钮）：
$env:NTFY_TOPIC = '你的-长随机-topic'                 # 不设则只跳过推送，仍可用 PWA 卡片审批
$env:APPROVAL_BASE_URL = 'https://<host>.<tailnet>.ts.net'  # 让 ntfy 通过/拒绝按钮能回调 bridge
pnpm --filter @mobile-ssh/bridge start          # 日志：listening on … + 一条 capability URL（含 ?token=）

# 3) 本机冒烟：PC 浏览器开日志里的 capability URL http://127.0.0.1:8866/?token=…
#    （127.0.0.1 也是 secure context，SW 一并注册；token 会被前端存进 localStorage 并从地址栏抹掉）

# 4) Tailscale fronting（另开一个 pwsh 窗口；--bg 后台持久、且独立于 bridge，可随意重启 bridge）
tailscale serve --bg 8866                       # 首次弹网页同意开 HTTPS/MagicDNS；打印 https://<host>.<tailnet>.ts.net
tailscale serve status                          # 确认挂载
```

手机装 Tailscale、登入**同一 tailnet** 并连上 → 浏览器开**日志里的 capability URL**（`https://<host>.<tailnet>.ts.net/?token=…`）→ 终端+输入框 →「分享 → 添加到主屏」独立窗口启动。token 首次随 URL 进来后存进 localStorage 并从地址栏抹掉，之后从主屏图标启动无需再带 `?token=`。

> **留待用户实测**（环境探测时本机未装 Tailscale）：步骤 4 + 手机加主屏经 wss 实连，对照验收①（发 prompt→实时输出、中文/IME 不重复）③（PWA 后台 >30s / 切网 → 重连补流、不丢不重）。
> **不要用 Funnel**（公网入站，违反「不暴露公网入站」DoD）；`tailscale serve` 仅 tailnet 内可达。Windows 下 `--bg` 重启是否自持未坐实，建议实测一次重启。`$env:` 仅当前 pwsh 会话有效，换窗口要重设。

## 审批 + 通知（PR4）

**回路（手机一次工具调用审批，点通过后 cc 继续）**：cc 跑到一个工具调用 → `PreToolUse`(type:http) hook **同步阻塞**地 POST 到 bridge `/hooks/pre-tool-use` → bridge 注册一条 pending 审批，并**三通道**同时呈现，**任一通道**点击都裁决同一条 pending：

1. **ntfy 推送**：锁屏通知带「通过 / 拒绝」两个 http-action 按钮（点击回调 `${APPROVAL_BASE_URL}/approvals/<id>?decision=…&nonce=…`）。
2. **PWA 卡片**：bridge 向已连 ws 广播 `approval_request`，PWA 在终端上方弹卡片（工具名 + input 预览 + 通过/拒绝），点击经 ws 回 `approval_decision`。
3. **打开 PWA** 后在卡片上操作（同 2）。

裁决（或超时）后 bridge 广播 `approval_resolved`，所有客户端的卡片一并消失，并把 `permissionDecision` 写进 hook 的 HTTP 响应回给 cc。`Stop` hook 推「完成」通知（取 `last_assistant_message` 摘要），永不 `decision:block`。

**鉴权（两套，刻意不同）**：
- **ws + cc hook 用同一个 `BRIDGE_TOKEN`**：ws 走 capability URL 的 `?token=`（握手时校验，缺/错拒绝；**loopback 不自动放行**，因为 tailscale serve 反代后请求在 bridge 看来都是 loopback）；cc hook 走 `Authorization: Bearer $BRIDGE_TOKEN`（缺/错 401）。
- **ntfy 按钮用每条审批的一次性 `nonce`**（不是 token）：因为 ntfy.sh 看得到按钮 URL，绝不能把可复用的 token 暴露给它。nonce 绑定单条审批、单次有效。

**超时 fail-closed**：没人点 / 手机离线时，bridge 在 `APPROVAL_TIMEOUT_MS`（默认 280s）到点返回 `APPROVAL_TIMEOUT_DECISION`（默认 `deny`），**且早于 cc hook 的 `timeout`（示例配 300s）**，绝不把 cc 卡死。

### 把 hook 装进**目标项目**（不是本仓库）

> ⚠️ **绝不要改本仓库的 `.claude/settings.json`**——它装的是 Trellis 工作流 hooks；而且你远控的 `claude` 是在 `BRIDGE_CWD`（另一个项目）下跑的，hook 要装到**那个项目**里才会触发。装到本仓库会在你自己跑 cc 时 POST 一个没起的 bridge，徒增噪音。

把 `bridge/claude-hook.example.json` 里的 `hooks` 块（PreToolUse / Stop / 可选 Notification，均 `type:"http"` + `Authorization: Bearer $BRIDGE_TOKEN` + `allowedEnvVars:["BRIDGE_TOKEN"]`）拷进**你让 cc 干活的那个项目**的 `.claude/settings.json`（或机器级 `~/.claude/settings.json`，Windows = `%USERPROFILE%\.claude\settings.json`）。URL 用 `http://127.0.0.1:8866/hooks/…`——被远控的 cc 与 bridge 同机，loopback 正确且不开公网口。`$BRIDGE_TOKEN` 必须在启动那个 cc 的 shell 里设好（pwsh：`$env:BRIDGE_TOKEN='…'`，与 bridge 同值）。

> **schema 注记**：`PreToolUse` 的 http-hook 入参/响应 schema 取自官方文档但在快速演进、尚未对本机 cc（v2.1.159）逐字核实——bridge 已**防御式解析**入参（字段缺失退化为占位），响应按文档发 `hookSpecificOutput.permissionDecision`。**正式信赖前请先用 `claude --debug` 抓一次真实往返核对**（研究 `claude-code-hooks-approval.md` Caveats）。

> **留待用户环境实测**：把 hook 装进目标项目后触发一次工具调用 → 手机收 ntfy / 看到 PWA 卡片 → 点「通过」→ cc 继续（验收②）；以及 `Stop` 完成推送、ntfy iOS 即时性（需 `upstream-base-url: https://ntfy.sh`，见研究 R3）。


## 已知必避坑（详见 `research/`）

1. **Claude bracketed-paste 提交失效**：node-pty 在 Windows 把批量 write 包成 bracketed-paste，
   cc 把 `\r` 当粘贴内容 → 提示词永远发不出。修复：逐字符喂 + ~15ms 延迟。
2. **resize-after-exit 进程级崩溃**：PTY 退出后再 resize，node-pty native 抛错绕过 JS try/catch。
   维护 `alive` 标志 + 升级到含 PR #901 的 node-pty。
3. **鉴权落点**：bridge spawn `claude` 前剔除 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`，
   否则吃 API 计费而非订阅额度（路线①交互式 cc 走订阅，不吃 2026-06-15 起的 Agent SDK credit）。

## 连通与安全（MVP）

- 仅 **tailnet 内可达** + **bridge token 鉴权**，**不开公网入站端口**（不要用 Tailscale Funnel）。
- **token 鉴权（PR4 已落地）**：ws 握手校验 capability URL 的 `?token=`、cc hook 校验 `Authorization: Bearer`，二者同用 `BRIDGE_TOKEN`；ntfy 按钮用每条审批的一次性 nonce（不外泄 token）。bridge 仍只 `listen` 在 `127.0.0.1`；ntfy 是 outbound POST。**loopback 不自动放行**——tailscale serve 反代后请求在 bridge 看来都是 loopback。
- PWA 必须经 `tailscale serve` 拿 HTTPS：裸 `http://100.x` 不是 secure context，Service Worker / Web Push / `wss://` 全失效。
- Service Worker 只拦**同源 GET** 导航/静态资源，**不碰** `POST /hooks/*` 与 `/approvals/*`；capability URL 的 token 进来后立即 `history.replaceState` 抹掉、不进 SW 缓存。
