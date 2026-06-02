# Research: Claude Code hooks / 权限模型做 moshi 式远程审批

- **Query**: 用 Claude Code (cc) 的 hooks / 权限模型实现「手机收到推送 → 一键通过/拒绝 → 决定回传给 cc」的 moshi 式远程审批；映射到本项目路线①（node-pty 镜像 + PWA + Web Push）。
- **Scope**: external（以 `code.claude.com/docs` 官方文档为准）+ 映射到本仓库 PRD
- **Date**: 2026-06-01
- **cc 实测版本**: v2.1.159（Windows 原生 Node / fnm）

---

## TL;DR（先看这段）

1. **hook 事件远比报告时代多**。除经典 `PreToolUse`/`PostToolUse`/`Notification`/`Stop`/`SubagentStop`/`UserPromptSubmit` 外，现在新增了独立的 **`PermissionRequest`**（权限对话框出现时触发）、`PermissionDenied`、`PostToolBatch`、`Setup`、`MessageDisplay` 等一大批。**做审批应优先用 `PreToolUse` 或 `PermissionRequest`。**
2. **能阻塞并裁决**：`PreToolUse` 可返回 `permissionDecision: "allow" | "deny" | "ask" | "defer"`；`PermissionRequest` 可返回 `decision.behavior: "allow" | "deny"`。退出码 2 = 阻塞。**这就是远程审批的裁决出口。**
3. **不用自己写 HTTP 回调脚本——官方原生支持 `type: "http"` hook**：hook 直接 POST 一个 JSON（含 `tool_name`/`tool_input` 全上下文）到**你的 bridge URL**，bridge 返回的 JSON 里带 `permissionDecision: "deny"` 等就能裁决。**hook 同步阻塞 = 天然「等手机决定」机制**，`timeout` 字段（command/http 默认 600s）就是你能让用户思考的时长上限。这几乎是为本项目量身定做的接口。
4. **Notification hook 有精确 matcher**：`matcher: "permission_prompt"` 专门在「需要你审批」时触发，`idle_prompt` 在 cc 等输入闲置时触发 → 推送文案可精准区分「需审批 / 需介入 / 闲置」。
5. **Windows 配置**：hook command 默认走 **bash**；要 PowerShell 就在该 hook 上写 `"shell": "powershell"`（无需 `CLAUDE_CODE_USE_POWERSHELL_TOOL`）。强烈建议用 `command + args`（exec 形式，免 shell 转义地狱）或直接 `type: "http"`（完全无 shell）。
6. **成本（关键）**：路线①（PTY 跑**交互式** `claude`）走订阅 usage limits，**不吃** 2026-06-15 起的新 Agent SDK credit；只有 `claude -p` / Agent SDK（路线②）才吃 credit。**官方文档明确佐证了 PRD 选路线①的省钱理由。**
7. **build-vs-buy 警报**：Anthropic 已上线**官方 Remote Control**（`claude remote-control` / `/rc`），手机/浏览器驱动本地会话 + 推送 + 审批 + outbound-only 加密，正是本 MVP 想要的体验。**做之前请认真评估「直接用官方」**（详见末尾）。

---

## 1. Hook 事件全表（触发时机 / 输入 / 输出与退出码语义）

来源：`code.claude.com/docs/en/hooks`（Hooks reference，2026-06-01 fetch）。
下表只列与本项目相关 + 高频事件；完整 30+ 事件见原文。

### 1.1 与「审批 / 推送 / 感知状态」最相关的事件

| 事件 | 触发时机 | 关键输入 (stdin JSON) | 能否阻塞 | 裁决 / 输出字段 |
|---|---|---|---|---|
| **`PreToolUse`** | **工具调用执行前** | `tool_name`, `tool_input`, `tool_use_id`, `permission_mode` | **能** | `hookSpecificOutput.permissionDecision` = `allow`/`deny`/`ask`/`defer` + `permissionDecisionReason`(+可选 `updatedInput`)。退出码 2 = 阻塞 |
| **`PermissionRequest`** | **权限对话框出现时**（即 cc 真的要问用户了） | `tool_name`, `tool_input`, `tool_use_id`, `permission_suggestions` | **能** | `hookSpecificOutput.decision.behavior` = `allow`/`deny`(+`updatedInput`/`updatedPermissions`/`message`/`interrupt`)。退出码 2 = 拒绝 |
| **`PermissionDenied`** | auto-mode 分类器拒了一次调用后 | `tool_name`, `tool_input`, `reason` | 否 | `hookSpecificOutput.retry: true` 告诉模型可重试。退出码被忽略 |
| **`Notification`** | cc 发通知时 | `message`, `title`, `notification_type` | 否 | 仅副作用（推送）；可返回 `systemMessage`。matcher 见 §3 |
| **`Stop`** | Claude 答完一轮 / 停下时 | `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` | **能** | `decision: "block"` + `reason` 阻止停止。退出码 2 = 继续对话 |
| **`SubagentStop`** | 子 agent 结束 | 同 Stop + `agent_id`/`agent_type`/`last_assistant_message` | **能** | 同 Stop |
| **`UserPromptSubmit`** | 用户提交 prompt、Claude 处理前 | `prompt` | **能** | `decision: "block"`(+`reason`) 拦截并抹除 prompt；`additionalContext` 注入上下文。退出码 2 = 拦截 |
| **`SessionStart`** | 会话开始/恢复 | `source`(startup/resume/clear/compact), `model` | 否 | `additionalContext` / `sessionTitle` 等 |
| **`SessionEnd`** | 会话终止 | `reason`(clear/resume/logout/...) | 否 | 仅副作用 |
| **`PostToolUse`** | 工具调用**成功后** | `tool_name`, `tool_input`, `tool_response`, `duration_ms` | 否（工具已跑） | `decision:"block"`+`reason`、`additionalContext`、`updatedToolOutput`(改写结果给模型) |

### 1.2 退出码 / JSON 输出通用语义

- **退出码 0**：无决定，正常流程继续；stdout 行为依事件（多数仅记录）。
- **退出码 2**：**阻塞性错误**。对可阻塞事件（`PreToolUse`/`PermissionRequest`/`UserPromptSubmit`/`Stop`/...）= 阻止该动作，stderr 反馈给 Claude；对不可阻塞事件仅把 stderr 显示给用户。`Notification`/`SessionStart`/`PostToolUse` 等无法靠退出码 2 阻塞。
- **JSON 输出（更精确，推荐）**：写到 stdout。通用字段：
  - `continue`(false → Claude 完全停止，优先级最高)、`stopReason`、`suppressOutput`、`systemMessage`(给用户的提示)。
  - `terminalSequence`：让 cc 代发终端转义序列（桌面通知/标题/响铃；限 OSC 0/1/2/9/99/777 + BEL）。**hook 无法写 `/dev/tty`，要发终端通知必须用这个字段**。
  - 决定字段按事件分两类：顶层 `decision`（Stop/PostToolUse/UserPromptSubmit 等）vs `hookSpecificOutput`（PreToolUse/PermissionRequest 等，见上表）。
- **Hook handler 类型（5 种）**：`type` 可为 `command`(脚本)、**`http`(POST 到 URL)**、`mcp_tool`(调已连 MCP 工具)、`prompt`(给快模型判定)、`agent`(给子 agent 判定)。**本项目重点是 `http` 和 `command`。**

---

## 2. 远程审批可行性：`PreToolUse`/`PermissionRequest` 能否「阻塞并裁决」+ 回调 bridge 等手机决定

**结论：完全可行，且官方有原生 `type: "http"` hook，几乎是为本场景设计的。**

### 2.1 裁决字段（官方原文）

`PreToolUse` 的 `hookSpecificOutput.permissionDecision`：
- `"allow"` 跳过权限提示（自动放行）。
- `"deny"` 拦截这次工具调用（`permissionDecisionReason` 会给到 Claude）。
- `"ask"` 提示用户确认。
- `"defer"` 优雅退出，留待 headless `--resume` 时再决定（见 §2.4）。
- 可选 `updatedInput` 改写参数后再放行。
- **注意**：deny / ask 规则仍会被评估——hook 返回 `allow` **不能**覆盖一条匹配的 deny 规则。

`PermissionRequest` 的 `hookSpecificOutput.decision`：
```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
  "decision": { "behavior": "allow", "updatedInput": { "command": "npm run lint" } } } }
```
`behavior: "deny"` 时可带 `message`(给 Claude 解释) 和 `interrupt: true`(停掉 Claude)。

### 2.2 同步阻塞回调 bridge —— **用 `type: "http"`（首选）**

官方 HTTP hook 字段：`url`(必填) / `headers`(支持 `$VAR`/`${VAR}` 插值，但仅 `allowedEnvVars` 列出的变量会被解析) / `allowedEnvVars`。官方示例：

```json
{ "hooks": { "PreToolUse": [ {
  "matcher": "Bash",
  "hooks": [ {
    "type": "http",
    "url": "http://localhost:8080/hooks/pre-tool-use",
    "timeout": 30,
    "headers": { "Authorization": "Bearer $MY_TOKEN" },
    "allowedEnvVars": ["MY_TOKEN"]
  } ]
} ] } }
```

- cc 会把 **hook input JSON（含 `tool_name`/`tool_input` 全上下文）POST 到你的 bridge**，**同步等待 HTTP 响应**。
- bridge 在收到后：推 Web Push → 等手机点「通过/拒绝」→ 把决定写进 HTTP 响应体。文档明确：HTTP 响应可携带 `decision: "block"` 或 `hookSpecificOutput.permissionDecision: "deny"`（与 command hook 的 stdout JSON 同构）。
- **这一次 HTTP 请求挂起的时长 = 用户在手机上思考的时长**，上限由 `timeout` 控制。
- **本项目落地点**：你的 Node/TS bridge 本就在 `localhost` 起 ws/http，直接多挂一个 `POST /hooks/pre-tool-use` endpoint 即可，**无需写任何 shell 脚本、无 Windows 转义坑**。

### 2.3 同步阻塞的时限 / 风险

- **`timeout`（秒）**：`command`/`http`/`mcp_tool` 默认 **600s**；`prompt` 30s；`agent` 60s。`UserPromptSubmit` 会把 command/http/mcp_tool 默认降到 30s。→ **审批 hook 建议显式设 `timeout`**（如 300s），并在 bridge 侧也设一个略小的兜底超时，超时返回安全默认（建议 deny 或 ask）。
- **风险/注意**：
  - hook 阻塞期间整个 agentic loop 停住——这正是我们要的（等人），但要确保 bridge 永远会响应（即使手机离线也要在 timeout 前回一个 deny/ask），否则卡到 cc 的 600s 默认。
  - `allow` 不能覆盖 deny 规则；真要「无条件放行」需配合 permission 规则/模式。
  - hook 同步阻塞**只在交互式 / headless 单轮里有意义**；并发多工具调用时每个 PreToolUse 各自阻塞。
  - 安全：HTTP hook 的 `Authorization` 头务必用 `allowedEnvVars` + bridge 校验，防 tailnet 内他人伪造审批（呼应 PRD Q5）。

### 2.4 headless `--resume` 路线（备选，非阻塞式审批）

若将来想做「不长时间挂起」的异步审批：`PreToolUse` 返回 `permissionDecision: "defer"`，`claude -p` 会以 `stop_reason: "tool_deferred"` 退出并返回 `deferred_tool_use`；之后 `claude -p --resume <session-id>` 时再用 `PreToolUse` 返回 `allow`+`updatedInput` 注入决定。**但这属于路线②（`-p`，吃 Agent SDK credit），与本 MVP 路线①不符，仅作记录。**

---

## 3. 「cc 在等输入 / 等审批」如何感知 → Notification hook

来源同上。**`Notification` 事件带精确 matcher（按 `notification_type` 过滤）**，可精准区分推送文案：

| matcher（notification_type） | 触发条件 | 推送用途 |
|---|---|---|
| `permission_prompt` | cc 弹出权限对话框（需要你审批） | **「需要你审批 ✋」** |
| `idle_prompt` | cc 等待输入 / 闲置 | **「在等你输入 💤」** |
| `auth_success` | 鉴权成功 | 一般忽略 |
| `elicitation_dialog` / `elicitation_complete` / `elicitation_response` | MCP server 请求/完成用户输入 | MCP 表单类介入 |

Notification input 示例：
```json
{ "hook_event_name": "Notification", "message": "Claude needs your permission",
  "title": "Permission needed", "notification_type": "permission_prompt" }
```

**本项目用法**：
- `Notification[permission_prompt]` → bridge 推「需审批」。**但裁决出口不在这**（Notification 不可阻塞）；裁决要落在 `PreToolUse`/`PermissionRequest` 的 HTTP hook 上。
- `Notification[idle_prompt]` → 推「需要人介入 / 在等你」。
- 任务完成通知 → 用 **`Stop`** hook（`last_assistant_message` 可作推送正文摘要）。
- **推荐组合**：`PreToolUse`(http, 阻塞裁决) + `Stop`(http/command, 推「完成」) + 可选 `Notification[idle_prompt]`(推「在等你」)。Notification[permission_prompt] 与 PreToolUse 二选一即可（PreToolUse 已能同时推送+裁决，更省）。

---

## 4. Windows 上的 hook 配置（shell / 路径 / 转义坑）

来源：`hooks` reference 的 "Windows PowerShell tool" + "Exec form and shell form" 段，及 `settings` 页。

- **默认 shell = bash**。command hook 里 `shell` 字段接受 `"bash"`(默认) 或 `"powershell"`：
  ```json
  { "type": "command", "shell": "powershell", "command": "Write-Host 'File written'" }
  ```
  设 `"powershell"` 即在 Windows 直接用 PowerShell 跑（`pwsh.exe`→`powershell.exe`），**无需** `CLAUDE_CODE_USE_POWERSHELL_TOOL`；`shell` 在设了 `args` 时被忽略。
- **强烈推荐两条免坑路径**：
  1. **`type: "http"`** —— 完全不经 shell，无任何转义问题（本项目首选，bridge 直接收 POST）。
  2. **exec 形式 `command` + `args`** —— `command` 当可执行文件直接 spawn，`args` 是参数向量，**不经 shell**，避免反斜杠/空格/引号地狱。官方示例（跨平台）：
     ```json
     { "type": "command", "command": "node",
       "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/format.js", "--fix"] }
     ```
     Windows 上 `node` 会解析到 `node.exe`/`.cmd`/`.bat`。
- **路径**：用 `${CLAUDE_PROJECT_DIR}` / `${CLAUDE_PLUGIN_ROOT}` 等变量引脚本（如 `${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh`），别写死绝对路径。`~/.claude` 在 Windows 解析为 `%USERPROFILE%\.claude`。
- **shell 形式（`command` 不带 `args`）转义坑**：会经 `sh -c`（或 `shell` 指定的）跑，`\`、空格、`$`、引号都要按目标 shell 转义——**能用 http / exec 形式就别用 shell 形式**。
- settings 里另有 `defaultShell`（控制输入框 `!` 命令的 shell，PowerShell 需 `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`），与 hook 的 `shell` 字段是两回事，别混。

### hook 配置落点（本项目）
| 位置 | 作用域 | 备注 |
|---|---|---|
| `~/.claude/settings.json` | 该机所有项目 | Windows = `%USERPROFILE%\.claude\settings.json` |
| `<repo>/.claude/settings.json` | 单项目，可提交 | 给本仓库装 PreToolUse(http)→bridge |
| `<repo>/.claude/settings.local.json` | 单项目，gitignore | 放本机 token/URL |

调试：`claude --debug`（hook 执行日志写 `~/.claude/debug/<session-id>.txt`），或 `--debug-file <path>`；`CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose` 更详。

---

## 5. 备选方案对比：hook 深集成 vs PTY 输出正则识别 + 注入 y/n/Esc

**推荐：MVP 用 hook（首选 `PreToolUse` 的 `type:"http"`）做审批；PTY 注入仅作「兜底/补漏」。**

| 维度 | **方案 A：hook `type:"http"` 审批**（推荐） | **方案 B：PTY 正则识别 + 注入按键** |
|---|---|---|
| 可靠性 | 高。结构化 JSON，确切知道在批准什么 | 低/脆。prompt 文案会变、有 ANSI 转义、时序竞态、locale 差异、误判 |
| 语义 | 强。拿到 `tool_name`/`tool_input`/diff，能做分级（自动放行安全的、危险的转人工） | 弱。只能靠屏幕正则猜，易被 prompt-injection 骗 |
| 移动 UX | 好。结构化推送 + diff 审查 + 通过/拒绝按钮 | 差。手机常只看到一个挂着的 `[Y/n]`，要手动定位按键 |
| 安全 | 好。上下文感知 + 可加分类器/allowlist + 审计 | 风险高。可能误自动批准恶意输出；社区已知多种基于解析的权限绕过 |
| 与路线①契合 | **极契合**。bridge 已持有 PTY 又起 ws/http，多挂一个 endpoint 即可；裁决回传走 HTTP 响应，干净 | 你**已经**有 PTY（node-pty），注入 `y\r`/`n\r`/`\x1b`(Esc) 是现成能力，零额外配置 |
| MVP 省事度 | 中。需在 `.claude/settings.json` 配 1 个 http hook + bridge 加 1 个路由 | 高（只就「跑起来」而言）。但要写稳健的 VT 解析、防误触，反而更费 |
| 成熟参照 | ccpocket / Happy / 官方 RC 走的就是结构化审批方向 | `ttyd` / `yoyo`(host452b) / `expect` 是这一派；ttyd 缺结构化审批 |

**推荐理由（结合本项目）**：
- 路线①的 bridge 本就 `localhost` 起 http/ws，**`type:"http"` hook 与之天然咬合**：cc POST 过来 → 推 Web Push → 手机点按钮 → HTTP 响应回 `permissionDecision`。一条路打通「推送 + 一键审批 + 决定回传」三件事，正是 PRD 验收点②要的。
- PTY 注入**不要丢**：它是路线①的**兜底**——hook 覆盖不到的交互（如 cc 的纯文本 `(y/N)` 旧式提示、`ExitPlanMode`、`AskUserQuestion` 的菜单选择、或 hook 未配置时），手机仍可直接注入 `y`/`n`/`Esc`/方向键+回车。**两者并存**：hook 管「工具权限审批」这条主路，PTY 注入管「其余一切终端交互」这条通路（本就是路线①必备）。
- **落地建议**：MVP 先把 PTY 镜像 + 按键注入跑通（验收点①③天然需要）；审批这条**优先接 `PreToolUse`(http)**，把主力权限请求变成结构化推送；剩余边角交互留给 PTY 注入。

---

## 6. 路线①鉴权/成本核对：复用订阅登录、不吃 Agent SDK credit？

**结论：核对属实，且官方文档明确佐证。** 路线①（bridge 用 node-pty spawn **交互式** `claude`，非 `-p`）复用 PC 上 `/login` 的订阅 OAuth 凭证，走**订阅 usage limits**，**不消耗** 2026-06-15 起的新 Agent SDK credit。

来源 A — `code.claude.com/docs/en/iam`（Authentication）凭证优先级（高→低）：
1. Cloud provider（Bedrock/Vertex/Foundry，需对应 env）
2. `ANTHROPIC_AUTH_TOKEN`（Bearer 头，走 gateway）
3. `ANTHROPIC_API_KEY`（X-Api-Key 头；**交互模式下首次会问你是否启用并记住；`-p` 非交互模式下只要存在就一定用**）
4. `apiKeyHelper` 脚本输出
5. `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token` 生成的长期 token，CI 用）
6. **订阅 OAuth 凭证（来自 `/login`）—— Pro/Max/Team/Enterprise 默认走这条**
   - Windows 凭证存 `%USERPROFILE%\.claude\.credentials.json`，由 `/login`/`/logout` 管理。
   - ⚠️ **路线①的坑**：若 PC 上设了 `ANTHROPIC_API_KEY` 环境变量，bridge spawn 的 `claude` 会优先用 API key（吃 API 计费）而非订阅。**bridge 启动 `claude` 时应确保不带 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`**，让它落到第 6 条订阅 OAuth。

来源 B — 支持文章《Use the Claude Agent SDK with your Claude plan》（2026-06-01 fetch）逐字佐证：
- 「Starting **June 15, 2026**, Claude Agent SDK and **`claude -p`** usage no longer counts toward your Claude plan's usage limits ... reserved for **interactive use of Claude Code**, Claude Cowork, and Claude.」
- 「The credit doesn't apply to: **Interactive Claude Code in the terminal or IDE**.」
- 「**Interactive Claude Code.** Using Claude Code in the terminal or your IDE continues to use your subscription usage limits exactly as before.」
- credit 额度：Pro $20 / Max 5x $100 / Max 20x $200 / Team Standard $20 / Team Premium $100（per-user，不可池化，月度刷新不滚存，需一次性 opt-in）。

**对决策的含义（强化 PRD ADR-lite）**：
- **路线①（交互式 `claude` over PTY）→ 走 usage limits，不吃 credit**。✅ 正是 PRD 选路线①的省钱依据，已被官方文档坐实。
- **路线②（`claude -p` / Agent SDK / stream-json）→ 2026-06-15 起吃 Agent SDK monthly credit**（用完且开了 usage credits 才按 API 价继续，否则停到下月）。这是路线②此前没被量化的新成本，**进一步反衬路线①更适合「个人自用、跑满额度」的 MVP**。
- 今天是 2026-06-01，距政策生效 14 天——若 MVP 期间做任何 `-p` 实验，注意 6-15 后计费口径切换。

---

## 7. ⚠️ Build-vs-Buy 警报：官方 Remote Control 已能做到本 MVP 的核心体验

来源：`code.claude.com/docs/en/remote-control`（2026-06-01 fetch）。Anthropic 已上线 **Remote Control**：

- 启动：`claude remote-control`（或会话内 `/remote-control` / `/rc`，或 `--remote-control`）。
- 能力：从 **claude.ai/code 或 Claude 手机 App** 驱动**本地正在跑的会话**；**mobile push notifications**（文档示例 `notify me when the tests finish`）；手机上审批；会话续接；**代码不离开你的机器**、**outbound-only 加密**。
- `--spawn` 支持 `same-dir`/`worktree`/`session`；`--sandbox`；`--capacity`。
- **限制**：需 **claude.ai 订阅**（Pro/Max/Team；troubleshooting 明确「Remote Control requires a claude.ai subscription」，且**不能用 `ANTHROPIC_API_KEY`**、需 full-scope login token）；部分 slash 命令（`/mcp` `/plugin` `/resume` `/compact` 等）在 RC 下不可用；移动端偶有 prompt 渲染问题；可被组织策略 `disableRemoteControl` 关闭。
- 官方还有 **Dispatch**（手机 App 派活给桌面跑）、**Channels**（Telegram/Discord/自建 server 推事件驱动 cc）等相邻能力，Channels 甚至支持「build your own」。

**这对本项目意味着什么（务必和用户确认）**：
- 用户要的「手机看 cc + 一键审批 + 收通知 + 代码留本地 + outbound-only」——**官方 Remote Control 基本已现成**。若可接受「装 Claude 官方 App + 订阅」，自建 PWA+bridge 的**核心差异化所剩不多**。
- 但自建仍有理由：① **完全自定义 UX / 路线①保真终端镜像**；② 不依赖 Anthropic App、可跨 cc/cx；③ 学习/可控/可改。这些正是 PRD 已写的「真·类 moshi」诉求。
- **建议**：把官方 RC 当作 **(a) 竞品基准 / 验收对照**，**(b) 可借鉴的架构范式**（outbound-only、push、phone 审批都被官方验证可行），**(c) MVP 前的一次「要不要自己造」复核点**。

---

## Related Specs / Repo 映射

- `.trellis/tasks/06-01-.../prd.md` — ADR-lite Q1（选路线①终端镜像）、Q3（Windows 原生 node-pty 桥）、验收点②「触发一次权限请求，手机弹审批，点通过后 cc 继续」。本研究为该验收点给出**官方实现路径**：`PreToolUse` 的 `type:"http"` hook → bridge → Web Push → HTTP 响应回 `permissionDecision`。
- 关联研究：`research/windows-pty-terminal-bridge.md`（PTY 桥/重连，承载方案 B 的按键注入兜底）、`research/pwa-tailscale-webpush.md`（Web Push 安全上下文，承载推送落地）。
- bridge 落地清单（MVP 审批回路）：
  1. `<repo>/.claude/settings.json` 配 `PreToolUse` http hook → `http://localhost:<port>/hooks/pre-tool-use`，带 `Authorization: Bearer $BRIDGE_TOKEN` + `allowedEnvVars:["BRIDGE_TOKEN"]`，`timeout: 300`。
  2. bridge 新增 `POST /hooks/pre-tool-use`：收 cc 上下文 → 推 Web Push → 挂起等手机决定 → 返回 `{ "hookSpecificOutput": { "hookEventName":"PreToolUse", "permissionDecision":"deny|allow|ask", "permissionDecisionReason":"..." } }`；超时兜底返回 `ask`/`deny`。
  3. `Stop` hook（http 或 command）→ 推「任务完成」（正文取 `last_assistant_message`）。
  4. bridge spawn `claude` 时**剔除 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`**，确保走订阅 OAuth（§6 坑）。
  5. PTY 按键注入保留，覆盖 `AskUserQuestion`/`ExitPlanMode`/旧式 `(y/N)` 等 hook 之外的交互。

---

## Caveats / Not Found

- **文档版本漂移**：hooks reference 字段极多且明显在快速迭代（出现 `PostToolBatch`/`MessageDisplay`/`defer`/agent teams 等新概念）。本机 cc 为 v2.1.159，**落地前请以本机 `claude --debug` 实测 hook 实际收发的 JSON 为准**（文档可能领先/落后本机版本）。
- **`type:"http"` 响应体的精确 schema 未在文档中逐字给出完整范例**：文档说 HTTP 响应「可携带 `decision:"block"` / `hookSpecificOutput.permissionDecision:"deny"`」，与 command hook stdout JSON 同构，但 HTTP 特有的 header/状态码约定（"HTTP response handling" 段在抓取的 markdown 中标题存在、正文偏薄）。**实现时务必先用 `--debug` 抓一次真实 http hook 往返**确认响应格式与 Content-Type。
- **Remote Control 的「approval」细节**未逐条展开（文档该页正文多为锚点、细节偏少）；其与 hooks 的关系、能否同时用，未在官方页明确，需实测。
- 成本数字（$20/$100/$200）来自支持文章，**以 claude.com/pricing 与账户实际为准**；政策 2026-06-15 才生效。
- PTY 注入派工具（yoyo / agentdeck / Shelly）来自社区仓库（GitHub），非官方，仅作方案 B 生态佐证，未逐个核验其代码质量。

---

## 来源链接（均 2026-06-01 fetch）

官方（code.claude.com / support.claude.com）：
- Hooks reference（事件表/输入输出/退出码/http hook/Windows shell/调试）：https://code.claude.com/docs/en/hooks
- Hooks guide：https://code.claude.com/docs/en/hooks-guide
- Settings（hook 位置/defaultShell/Windows 路径）：https://code.claude.com/docs/en/settings
- Headless（`claude -p` / `--allowedTools` / `--output-format stream-json` / `--permission-mode` / `apiKeyHelper`）：https://code.claude.com/docs/en/headless
- Authentication / IAM（凭证优先级、订阅 OAuth、`ANTHROPIC_API_KEY` 行为）：https://code.claude.com/docs/en/iam
- **Remote Control（官方手机审批/推送）**：https://code.claude.com/docs/en/remote-control
- **Agent SDK credit 政策（2026-06-15）**：https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

社区/对照（方案 B 与生态，未深核）：
- ccpocket（bridge + 结构化审批参照）：https://github.com/K9i-0/ccpocket
- yoyo（PTY 代理 + 按键注入/安全护栏）：https://github.com/host452b/yoyo
- Remote Control 第三方指南：https://www.nxcode.io/resources/news/claude-code-remote-control-mobile-terminal-handoff-guide-2026

证据落盘（可复现）：`C:\tmp\smart-search-evidence\cc-hooks\`（01 hooks-reference / 03 settings / 04 headless / 05 iam / 06 auth-exa / 07 pty-vs-hooks / 08 remote-control / 09 agent-sdk-credit）。
