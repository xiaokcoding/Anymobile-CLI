# Journal - xiaokcoding (Part 1)

> AI development session journal
> Started: 2026-06-01

---

## 2026-06-01 — 启动 06-01-mobile-remote-control-app-for-claude-code-mvp

**目标**：手机远控 PC(Windows) 上的 Claude Code，真·类 moshi（看终端/一键审批/收通知，代码不离机）。

**Brainstorm 决策（详见 task prd.md 的 ADR-lite）**：
- Q1 路线①终端镜像（非报告主推的路线②结构化 SDK）。
- Q3 PC 端 = Windows 原生 **node-pty(ConPTY) bridge**（持久 PTY + scrollback 接管 tmux 职责），不碰 WSL。
- Q2 客户端 = **xterm.js PWA**（tailscale serve HTTPS + ntfy 通知），原生 App 留 fast-follow。
- Q5 走订阅额度（官方坐实，不吃 6-15 起的 Agent SDK credit）；Q6 决定自建（先试 5 分钟官方 RC 作基线）。
- 范围 = 核心回路 PR0–PR5；cx/原生App/多会话/自托管Push/输入工具条全部 defer。

**研究落盘**（已挂 implement/check.jsonl）：`research/{windows-pty-terminal-bridge, claude-code-hooks-approval, pwa-tailscale-webpush}.md`。
关键发现：审批有官方 `PreToolUse` type:http hook 现成接口；三大坑（bracketed-paste 提交失效 / resize-after-exit 崩溃 / 剔除 ANTHROPIC_API_KEY）；可抄 open-claude-remote + wootty。

**PR0（脚手架）= 完成 ✅**：git init(main) + pnpm workspace(bridge/ Node-TS, web/ xterm.js PWA) + TS/ESLint + README。
验证：install/typecheck/lint 全过；bridge 经 tsx 跑通；web 经 vite 构建通过；**node-pty 在 win32-x64/Node24 原生加载 OK，自带 conpty.dll 已铺好**。尚未 commit（等用户指示）。

**下一步**：PR1 — Bridge PTY 核心（spawn claude.cmd + 持久 PTY + 字节环形 scrollback + ws output/input/resize + 三大坑修复）。

## 2026-06-01 — PR1（Bridge PTY 核心）完成 ✅

**实现**（trellis-implement）：`bridge/src/{config,scrollback,pty-session,protocol,ws-server,index}.ts` + `pty-session.test.ts`；`web/src/{protocol,bridge-client,vite-env.d,main}.ts`。
- 持久 PTY（node-pty spawn `claude.cmd`，cwd/cols/rows 可配）+ 字节环形 scrollback（4MB，单调 seq）+ ws(127.0.0.1:8866) attach 全量回放→实时镜像 + input/resize 转发 + exit 广播。
- 三大坑全落实：input 逐**码点**写入+15ms 延迟（绕 bracketed-paste，CJK 不切碎）｜resize 前判 alive（防 #827 native crash）｜spawn 前删 ANTHROPIC_API_KEY/AUTH_TOKEN（保订阅额度，保留 SystemRoot/PATH）。另处理 #887（kill 后显式 exit）。
- web 自写 ws 客户端（不用官方 AttachAddon），URL 经 VITE_BRIDGE_WS_URL/DEV 解析。

**核查**（trellis-check）：0 缺陷需修；三大坑「真修对」、attach 回放与实时流在 PR1 同步路径下无丢/重帧、scrollback 按整 chunk 淘汰不切碎 UTF-8、两份 protocol 一致、ESM/build 正确、未越界未 commit。typecheck/lint/web build/test(7/7) 全绿。

**留给 PR2 的交接项**：① `BridgeClient.connect()` 里注册的 onData/resize 监听器需移到构造器或 close 时 dispose，否则重连会重复注册；② 引入 lastSeq/增量回放后，snapshot→live 边界要按 seq 显式去重（seq 字段已铺好）。

**状态**：未 commit（用户指示先不提交）。下一步候选：PR2 重连补流。

## 2026-06-02 — PR2（重连补流）完成 ✅

**实现**（trellis-implement）：在 PR1 协议骨架（`ready` 已带 lastSeq/alive、`output` 已带 seq）上增量开发。
- 协议扩展（两份 protocol.ts 严格同步）：新增 `attach{lastSeq}`/`ping`（client→server）、`pong`（server→client）、`ready.truncated`；共享常量 `CloseCode`(4101/4102/**4103**)、`Heartbeat`(ping **12s**/看门狗 **24s**)、`Backoff`(**300·1.8^n** 上限 **5000ms**) —— 全取自 research 的 wootty「Transport Lifecycle Contract」。
- `scrollback.ts`：`firstSeq` + `since(seq)→{chunks,truncated}` 增量切片 + gap 检测；`pty-session.ts` 透传。
- `ws-server.ts` 重写连接生命周期：**等客户端 `attach{lastSeq}` 帧再 `ready`+只回放 seq>lastSeq**→挂 live；`ping`→`pong`；24s 心跳看门狗超时关 4103；统一 `cleanup` 清所有 timer/listener。裸探针 1s `graceTimer` 兜底全量（`attached` 幂等守卫，不与真 attach 竞争）。
- web：新增 `reconnect.ts`（纯逻辑 `backoffDelayMs()` + `SeqCursor` seq 去重/reset）；`bridge-client.ts` 加自动重连+backoff+12s ping/pong+`attach{lastSeq}`续传+`truncated`时 `term.reset()`。

**PR1 两个交接坑均修复**：① `onData`/`onResize`/`window resize` 移到**构造器注册一次**（存 disposables），重连只重建 socket 不叠加 handler，`destroy()` 真 dispose；② snapshot→live 边界靠 bridge 同一单调 seq + 客户端 `SeqCursor` 严格递增双重保证「不丢帧、不重帧」。gap（lastSeq 落入已淘汰区）→`truncated=true`+全量+客户端 reset，不静默假装连续。

**核查**（trellis-check）：**0 缺陷需修**。逐项确认：增量回放无丢/重帧、坑①只注册一次、握手重排不破坏首连全量/裸探针兜底/PTY 已退仍补发 exit、gap 降级正确、心跳 timer 在 cleanup/exit 均清除、backoff 数值对、两份 protocol.ts 逐字段一致、PR1 三大坑未回退。两处仅知悉项：看门狗 24s（≈2×间隔，有意防误杀，非缺陷）；attach 前 PTY 退出的微秒窗口可能多打印一行 `[claude exited]`（纯视觉、不在验收③路径、修复收益低于风险，未改）。
测试：bridge **19/19**（since 全量/增量/追平/seq 反超/gap、firstSeq 跨淘汰、ws-server 真 WebSocket+FakePTY 集成覆盖断连重连精确补回+ping/pong=**验收③**）、web **6/6**；lint/typecheck/`vite build` 全绿；lockfile 无漂移。

**留给 PR3 的交接项**：PR3 = PWA 化（manifest/SW + 加主屏）+ Tailscale（`tailscale serve --bg` 自动 HTTPS）→ 手机经 wss 连上、独立输入框发 prompt。**有外部依赖**：用户需装 Tailscale（环境探测时未装）、用手机实测、PR4 还要 ntfy app。纯代码部分（PWA manifest/SW/输入框）可先做，连通验证须用户环境。

**状态**：未 commit。⚠️ 注意：仓库**至今零 commit**，PR0–PR2 全部 untracked（git log 为空），3 个已验证 PR 未入库，较脆弱。

## 2026-06-02 — PR3 纯代码部分（PWA + 独立输入框）完成 ✅

**范围**：用户选定「只做 PR3 纯代码部分」。`tailscale serve --bg` 实测、手机 wss 连通留到用户环境就绪（环境探测时 Tailscale 未装）；Web Push/ntfy(PR4)、移动按键工具条(Out of Scope)、原生 App 均 defer。

**实现**（trellis-implement）：
- **PWA 化（手写 minimal，不引 vite-plugin-pwa，合本项目少依赖取向）**：`web/public/manifest.webmanifest`（`display:standalone`、name "Claude Remote"、`theme/background #1e1e1e`、192+512 图标、`purpose:any maskable`）+ `web/public/sw.js`（precache app shell；导航 network-first、静态 cache-first；**只处理同源 GET，绝不拦 ws/wss**；**无 Web Push**=留 PR4）+ `main.ts` 注册 SW（`isSecureContext` 守卫、`.catch` 非致命）+ `index.html` 加 manifest/theme-color/apple-touch metas。图标由零依赖脚本 `web/scripts/generate-icons.mjs`（Node zlib）确定性生成，占位待美术。
- **独立输入框（移动核心 UX）**：`index.html` 改 flex 列布局（`#terminal` flex:1 + `#input-bar` 吸底，`env(safe-area-inset-bottom)`，textarea `font-size:16px` 防 iOS 缩放，`100dvh`）；`web/src/input-box.ts` 抽纯逻辑 `shouldSubmit(event,composing)`/`buildSubmitPayload(text)`；`main.ts` 用 `compositionstart`/`compositionend` 状态机喂纯逻辑——**组合输入（拼音/IME）进行中绝不提交**，只在点发送或非组合态 Enter 发最终合成文本（发 `text+"\r"`），Shift+Enter 换行；`bridge-client.sendInput()` 复用既有 `{type:"input"}` 帧（**协议未动**）。textarea 与 xterm 隐藏 textarea 隔离 → **不双发**，桌面 `term.onData` 仍可用。
- `eslint.config.js` 加 globals（`web/public/**` serviceworker/browser、`scripts/**` node）；`package.json` 加 `globals` devDep（lockfile 已同步）；README 更新。

**核查**（trellis-check）：**0 缺陷需修**。四重点全过：① IME 守卫逻辑正确（拼音回车归 IME 不提交 / Shift+Enter 换行 / 纯 Enter 提交，组合期字符不进 PTY）；② 不双发（同一输入仅一帧 wire send）；③ SW 不拦 ws/wss、`isSecureContext` 守卫、注册失败非致命、无 Web Push；④ `pnpm install --frozen-lockfile` 通过、lockfile 一致。manifest installable（合法 8-bit RGBA PNG 192/512）；PR1 三大坑 + PR2 重连补流无回归。**一个非阻塞观察**：`index.html` 顶部未设 `env(safe-area-inset-top)`，iOS standalone 下首行可能压刘海/状态栏——纯视觉，建议 PR5 加固时一并处理。
测试：web **13**（6 reconnect + 7 input-box）、bridge **19**；lint/typecheck/`vite build`(dist 含 manifest/sw/icons)/frozen-lockfile 全绿。

**留给用户环境 / 后续 PR**：① 装 Tailscale + `tailscale serve --bg` + 手机加主屏经 wss 实测（验收①③ 真机验证）；② PR4 审批+通知（`PreToolUse` http hook + ntfy，需 ntfy app + 改 `.claude/settings.json` + 手机）；③ PWA 图标美术替换；④ PR5 iOS 顶部 safe-area 加固。

**状态**：未 commit。⚠️ 仓库**仍零 commit**，现已积压 PR0–PR3 四个已验证 PR 全 untracked。

## 2026-06-02 — PR3 bridge serve 静态页（方案A，真机 runbook 的承重半）已实现并正式核查 ✅

**背景**：出真机 runbook 时读代码发现——bridge **已经**在同端口 serve 静态 PWA + ws 了（`static-server.ts` 在、`ws-server.ts` 已是 `http.createServer + WebSocketServer({server})`、`config.webDist`/`index.ts` 全接好、还配了 8 条测试）。这块是上一段被 **compact 掉的对话**里实现的：**有测试、但没落 journal、也无正式 check 记录**。而它正是 prd「bridge serve 一个 xterm.js 网页」那一半 + 「不暴露公网入站」DoD 的网络边界，故补一次正式核查收口（此前 summary 还停在「bridge 只跑 ws、不 serve 静态」的旧状态，已纠正）。

**实现内容**（同端口单一 origin → 一条 `tailscale serve --bg 8866` front 全部，web 同源 `wss://<host>` 直接生效）：
- `bridge/src/static-server.ts`（新）：纯 Node 内置静态 handler。MIME 表 / SPA 导航回退 `index.html` / `/sw.js` `no-cache`（防卡旧 SW）/ `/assets/*` `immutable` 长缓存 / **路径穿越防护**（WHATWG URL 折叠 + `path.resolve` 容器校验，`%2e%2e` 逃不出 root）/ 仅 GET·HEAD（否则 405）/ dist 缺失返 **503** + build 提示不崩 / `defaultWebDist()`→`../../web/dist`。
- `bridge/src/ws-server.ts`（改）：独立 `WebSocketServer({port})` → `http.createServer(staticHandler)` + `WebSocketServer({ server })` 同端口共存（Upgrade 被 ws 接走、普通 GET 进 static）；`close()` 先关 wss 再关 http 释放监听 socket。**仍绑死 127.0.0.1**。
- `bridge/src/config.ts`（改）：`webDist`（env `WEB_DIST`，默认 `defaultWebDist()`）。`index.ts`（改）：传 `webDist`、日志打印 `front with: tailscale serve --bg <port>`、dist 缺失 warn（非致命，ws 照跑）。
- `bridge/src/ws-server.test.ts`（改）：+8 条 PR3 静态测试（app shell / SPA 回退 / sw no-cache / assets immutable / 路径穿越 404 / 非 GET 405 / dist 缺失 503 / **ws Upgrade 与静态 GET 同端口共存**）。

**核查**（trellis-check）：**0 问题需修**（代码本就对，未改一行）。7 承重点全 PASS——① DoD 不暴露公网（唯一 `listen` 绑 127.0.0.1，无 0.0.0.0/LAN/Funnel，`host` 未接 env/CLI）；② 零新运行时依赖（仅 Node 内置 + 既有 `ws`，`--frozen-lockfile` 无漂移）；③ 路径穿越 win32 实测拦死；④ 三大坑无回退（未触及 pty-session）；⑤ PR2 重连补流（attach→ready→delta→live / lastSeq / ping·pong / 24s 看门狗 / truncated→reset）套进 http.Server 后行为不变；⑥ SW 不拦 ws/wss、`/sw.js` no-cache；⑦ ws Upgrade 与静态 GET 同端口共存。
测试：**bridge 27/27**（PR2 的 19 + PR3 静态 8）、**web 13/13**；typecheck/lint/`vite build`(dist 含 index.html/assets/icons/manifest/sw.js)/frozen-install 全绿。`web/dist` 已确认含全部 PWA 资源；bridge 默认 `webDist` 解析正是 build 输出目录。
**非阻塞观察**：bridge `protocol.ts` 头注释「byte-for-byte 同步」措辞不准（两份是镜像、wire 契约一致），属 PR1/PR2 文件，留 PR5 文档 pass 收紧。

**真机 runbook（方案A·一条命令版）已就绪**：`pnpm --filter @mobile-ssh/web build` → `BRIDGE_CWD=… pnpm --filter @mobile-ssh/bridge start`（serve dist + ws @127.0.0.1:8866）→ `tailscale serve --bg 8866` → 手机开 `https://<host>.<tailnet>.ts.net`。用户环境为 **Windows Terminal + PowerShell 7**，已据此给 pwsh7 env 语法（`$env:VAR='…'`，非 bash 前缀）。

**留给用户环境 / 后续**：① 用户实跑 runbook：本机 `http://127.0.0.1:8866` 冒烟 → 装/起 Tailscale `serve --bg` → 手机加主屏，验收①（输入框发 prompt→实时输出）③（后台>30s/切网→重连补流不丢不重）；② Windows 下 `tailscale serve --bg` 重启是否自持需实测；③ PR4 审批+通知（PreToolUse http hook + ntfy + token 鉴权，挂同一 origin）。

**状态**：未 commit。⚠️ 仓库**仍零 commit**，PR0–PR3（含本 bridge-serve 半）全 untracked。

