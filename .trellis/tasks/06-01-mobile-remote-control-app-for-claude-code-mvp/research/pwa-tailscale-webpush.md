# Research: PWA over Tailscale — Secure Context (HTTPS) + Web Push

- **Query**: 把 xterm.js PWA 经 Tailscale 推给手机，拿到 Service Worker + Web Push 所需的安全上下文(HTTPS)；iOS/Android Web Push 真实可用性；自托管推送 vs ntfy 兜底。
- **Scope**: external (Tailscale 官方文档 / MDN / WebKit / caniuse / web-push npm / ntfy 文档)
- **Date**: 2026-06-01
- **映射到本项目**: MVP = bridge(Windows, Node) serve 的 xterm.js PWA，手机浏览器经 Tailscale 打开、加到主屏，cc 需审批/完成时推送通知；不开公网端口、不接 FCM/APNs 那套重的（见 `prd.md` Q2/Q4 决策）。

---

## TL;DR 结论（先看这段）

- **裸 `http://100.x.x.x`(Tailscale IP) 不是 secure context** → Service Worker / Push API / Notification 直接拿不到。**localhost 例外不适用**（100.x 不是回环地址）。**必须有真 HTTPS。**
- **拿 HTTPS 最简办法 = `tailscale serve`**：一条命令 `tailscale serve 3000` 自动开 Let's Encrypt 证书 + 反代到本地 bridge，给你 `https://<host>.<tailnet>.ts.net`，浏览器认这是合法 HTTPS（secure context 成立）。完胜自签证书（自签在手机上要手动装根证书、还会被部分 API 拒）。
- **Web Push 在 2026 已全平台可用，但 iOS 有硬限制**：iOS 16.4+ 仅对**“加到主屏”的 PWA** 开放 Web Push，且必须**用户手势**触发订阅；**iOS 不支持通知 action 按钮**（只有一个 "View"）。Android Chrome / 桌面 Chrome/Firefox/Edge 完整可用。
- **自托管 Web Push 可行且不碰 FCM/APNs**：bridge 用 `web-push`(npm) + 自己的 VAPID 密钥直接 POST 到浏览器给的 endpoint（payload 走 RFC8291 aes128gcm 加密）。**但**：推送 endpoint 仍是 FCM(Android)/Mozilla(Firefox)/Apple APNs(iOS) 的 URL——你不用注册它们的项目/账号，只是流量经过它们。
- **「通过/拒绝」按钮**：notification action 按钮**只有 Android Chrome/Opera 支持**，iOS 完全不支持、桌面 Firefox 支持度差。→ 一键审批不能只靠通知按钮，得点开 PWA 再操作（或 iOS 用通知点击直达审批页）。
- **MVP 兜底推荐**：**通知用 ntfy 自托管 + 手机装 ntfy app 订阅 topic**，比自己折腾 iOS Web Push 省事得多——但 **iOS 即时送达必须把 `upstream-base-url` 指向 `https://ntfy.sh`**（自托管 ntfy 自己无法绕过 iOS 后台限制）。详见 §5/§6。

---

## Findings

### 1. 安全上下文问题：为什么裸 Tailscale IP 不行

**核心规则（MDN「Secure Contexts」）**：很多强力 Web API（Service Worker、Push、部分 Notification 行为）**只在 secure context 可用**，目的是防 MITM 攻击者拿到这些 API。
来源: <https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts>

判定为「potentially trustworthy / secure」的来源，**精确列表**（MDN 原文）：

> Locally-delivered resources such as those with `http://127.0.0.1`, `http://localhost`, and `http://*.localhost` URLs ... are not delivered using HTTPS, but they can be considered to have been delivered securely because they are on the same device as the browser.

- ✅ `https://` （任意主机）
- ✅ `http://127.0.0.1`、`http://localhost`、`http://*.localhost`（**仅回环地址**，因为「在同一台设备上」）
- ✅ `file://`
- ✅ `wss://`（Secure WebSocket）
- ❌ **`http://100.x.x.x`（Tailscale CGNAT IP）**——这是**普通 IP，不是回环地址**，浏览器无从判断它是否安全 → **不是 secure context**。
- ❌ `http://<host>.<tailnet>.ts.net`（MagicDNS 名 + 明文 http）——同理，名字不等于 TLS。

**后果（对本项目）**：
- `navigator.serviceWorker.register(...)` 直接 fail（MDN「Using Service Workers」明确：SW 限制在 HTTPS 运行；localhost 是开发例外）。来源: <https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers>
- `PushManager.subscribe()` 标注 **"Secure context: This feature is available only in secure contexts (HTTPS)"**。来源: <https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe>
- `ServiceWorkerRegistration.showNotification()` 同样标 secure-context-only。来源: <https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification>
- 没有 SW 就没有 `push` 事件入口（Push 必须挂在活跃 SW 上）。来源: <https://developer.mozilla.org/en-US/docs/Web/API/Push_API>

**Tailscale 官方也确认这一点**（为什么明文 http over tailnet 会触发浏览器警告 / 限制）：

> Every Tailscale connection is an encrypted and authenticated WireGuard connection under the hood, **but your browser doesn't know that, and some browser features are restricted without TLS.**
来源: <https://tailscale.com/blog/four-ways-tailscale-service>

> ...your tailnet's connections use WireGuard, which provides end-to-end encryption at the network layer, **your browser isn't aware of that encryption—so it looks for a valid TLS certificate** for that domain.
来源: <https://tailscale.com/blog/caddy>

**自检手段**：页面里 `window.isSecureContext`（boolean）能判断当前是否安全上下文，MDN 给的就是用它来 gate `serviceWorker.register`。来源: <https://developer.mozilla.org/en-US/docs/Web/API/Window/isSecureContext>

> 注意：WireGuard 加密 ≠ secure context。安全上下文是「浏览器层」的判定，只认 TLS 证书，不认底层 VPN 隧道加密。这正是为什么必须给 bridge 套真 HTTPS。

---

### 2. 拿 HTTPS 的最简办法：`tailscale serve`（强烈推荐）

**一句话**：在 Windows bridge 机上跑 `tailscale serve <本地端口>`，Tailscale 自动从 Let's Encrypt 取证书、反代到你的本地 bridge，并给一个 `https://<host>.<tailnet>.ts.net` 地址。手机浏览器访问这个地址 = 合法 HTTPS = secure context 成立。

#### 2.1 基本用法（官方文档原文示例）

```shell
# 把本地 http://127.0.0.1:3000 反代出来，监听 tailnet 内 443
tailscale serve 3000
```

输出（官方文档）：
```
Available within your tailnet:
https://amelie-workstation.pango-lin.ts.net

|-- / proxy http://127.0.0.1:3000

Press Ctrl+C to exit.
```
来源: <https://tailscale.com/docs/features/tailscale-serve>

等价写法（都可）：
```shell
tailscale serve 3000
tailscale serve http://localhost:3000
tailscale serve http://127.0.0.1:3000
```
来源: <https://tailscale.com/blog/reintroducing-serve-funnel>

#### 2.2 关键 flag

- **`--bg`（后台持久化，本项目需要）**：默认 `tailscale serve` 是**前台 session**，Ctrl+C 或关终端就停。要让配置在终端关闭后仍存活，加 `--bg`：
  ```shell
  tailscale serve --bg 3000
  ```
  来源: <https://tailscale.com/blog/reintroducing-serve-funnel>
- **换监听端口**：`tailscale serve --https=8443 3000`（默认 443，不用在浏览器里写端口）。
- **多挂载点**：`tailscale serve --set-path=/ --bg 3000`（同一 host 多路径并存）。
- ⚠️ **CLI 在 1.52 版本大改过**，旧版语法（`tailscale serve https / http://localhost:3000`）和新版不同；以 `tailscale serve --help` 为准。来源: <https://tailscale.com/docs/features/tailscale-serve>

#### 2.3 是否需要 `tailscale cert`？—— 大多数情况 **不需要**

- **`tailscale serve` 会自动开 HTTPS / 自动取证书**。官方：
  > Tailscale Serve requires that you enable HTTPS in your tailnet to automatically provision TLS certificates ... **If you use the interactive CLI flow ... Tailscale automatically enables HTTPS if it is not already enabled.**
  来源: <https://tailscale.com/docs/features/tailscale-serve>
  > If you don't have HTTPS enabled in your tailnet, the `tailscale serve` command provides an interactive web UI that prompts you to allow Tailscale to enable HTTPS on your behalf.

  即：**第一次跑 `tailscale serve` 时，若 tailnet 没开 HTTPS，它会弹一个 consent 网页让你一键开启**，之后 serve 自己管证书 + 续期。**你不必手动跑 `tailscale cert`。**

- **`tailscale cert` 是「手动拿证书文件」的低层命令**，给你想自己用 nginx/Caddy/自家 server 做 TLS 终止的场景。本项目用 `tailscale serve` 让 Tailscale 直接做反代 + TLS，**就不用碰它**。
  > go to the Settings page ... Select "Configure HTTPS" ... then run `tailscale cert` (with `sudo` as needed) on the nodes you're obtaining a certificate for.
  来源: <https://tailscale.com/blog/tls-certs>

- 前置：MagicDNS（默认对新 tailnet 已开）+ 在 admin console 开 HTTPS。tailnet 会拿到形如 `<words>.ts.net` 的名字（如 `tail-scale.ts.net`），证书就为 `<host>.<tailnet>.ts.net` 签发。来源: <https://tailscale.com/blog/magicdns>

#### 2.4 反代到本地 bridge 端口的「姿势」（映射本项目）

```
手机 PWA (https://<host>.<tailnet>.ts.net)
        │  HTTPS (Let's Encrypt cert, secure context ✅)
        ▼
[Windows bridge 机] tailscale serve --bg 3000  ← TLS 终止 + 反代
        │  http://127.0.0.1:3000  (本机回环, 明文 OK)
        ▼
   Node bridge (xterm.js PWA + WebSocket + Web Push 订阅 API)
```

- bridge 自己**只需监听 `127.0.0.1:3000` 明文 HTTP/WS**——TLS 由 Tailscale 终止，省掉证书管理。
- **WebSocket 也自动升级**：因为外部是 `https://...ts.net`，浏览器侧用 `wss://...ts.net`，Tailscale serve 反代到本地 `ws://127.0.0.1:3000`。`wss://` 本身也是 potentially-trustworthy（见 §1）。
- 不开任何公网入站端口（serve 只对 tailnet 内可见；Funnel 才是公网，本项目**不要**用 Funnel）。符合 `prd.md` DoD「不暴露公网入站端口」。

#### 2.5 `tailscale serve` vs 自签证书 —— 优劣对比

| 维度 | `tailscale serve`（Let's Encrypt + MagicDNS） | 自签证书 (self-signed) |
|---|---|---|
| **手机端是否信任** | ✅ 公共 CA 签发，iOS/Android 浏览器**开箱信任** | ❌ 必须在**每台手机手动安装+信任根证书**（iOS 还要去「设置→通用→关于→证书信任设置」二次开启） |
| **secure context 是否成立** | ✅ 成立（SW/Push 可用） | ⚠️ 即便装了根证书，部分浏览器对私有 CA 仍有额外限制；坑多 |
| **证书续期** | ✅ Tailscale 自动续 | ❌ 自己续、自己重分发 |
| **配置量** | ✅ 一条命令 | ❌ 生成 CA、签 leaf、装根证书、配 server TLS |
| **隐私（DNS 名暴露）** | ⚠️ `<host>.<tailnet>.ts.net` 会进**公共 Certificate Transparency 日志**（名字公开可查，但 100.x IP 仍只 tailnet 内可达，相对无害）来源: <https://tailscale.com/blog/tailscale-funnel-beta> | ✅ 不进 CT 日志 |
| **结论** | **MVP 首选** | 仅在不想暴露 ts.net 名 / 离线无法 ACME 时考虑 |

> CT 日志说明（来自 Tailscale Funnel 文档，对 serve 同样适用——证书都来自 Let's Encrypt）：ts.net 子域证书会出现在公共 CT 日志，意味着「你有这么个名字」是可公开查询的；但因为 Tailscale IP 不可公网路由，攻击者知道名字也连不上。对个人自用 MVP 可接受。

---

### 3. Web Push 支持矩阵（2025–2026 现状）

#### 3.1 总表（基于 caniuse Push API + 各子 API，2026 数据）

| 平台 / 浏览器 | Web Push 可用性 | 关键约束 |
|---|---|---|
| **Android Chrome** | ✅ 完整可用 | 推送经 FCM endpoint（无需你注册 FCM 项目，用 VAPID 即可）；支持通知 action 按钮 |
| **Android Firefox** | ✅ 可用 | 经 Mozilla autopush endpoint |
| **桌面 Chrome / Edge** | ✅ 完整可用 | `userVisibleOnly:true` 必填；支持 action 按钮、inline reply |
| **桌面 Firefox** | ✅ 可用 | action 按钮支持有限（与 Chrome 有差异） |
| **桌面 Safari (macOS 13 Ventura / Safari 16.1+)** | ✅ 可用 | 同 W3C 标准 Web Push，经 APNs |
| **iOS / iPadOS Safari** | ⚠️ **16.4+ 才有，且仅限“加到主屏”的 PWA** | 见 §3.2，坑最多；caniuse 标 **"Partial support"** 即源于此 |

caniuse Push API 原始数据（节选，确认 iOS 的 partial 状态）：
- Chrome 50+：Supported
- Firefox 44+：Supported
- **Safari on iOS：3.2–16.3 Not supported；16.4+ Partial support**（partial = 仅 home-screen PWA）
来源: <https://caniuse.com/push-api>

子 API（`push` event / PushSubscription / PushManager）：iOS Safari 均从 **16.4** 起 Supported（PushEvent.notification 等更细特性 18.4 起）。
来源: <https://caniuse.com/mdn-api_serviceworkerglobalscope_push_event> , <https://caniuse.com/mdn-api_pushsubscription_endpoint>

#### 3.2 iOS Web Push 的硬限制与坑（**最重要**）

官方来源 = WebKit 博客「Web Push for Web Apps on iOS and iPadOS」(iOS 16.4)。

**(a) 只对“加到主屏”的 PWA 开放，Safari 标签页内不行**：
> Now with iOS and iPadOS 16.4, we are adding support for Web Push to **Home Screen web apps**.
来源: <https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>
Apple Developer Forums 官方回复确认：
> As of iOS 16.4 ... Web Push is supported in web apps added to the Home Screen ... **Web Push is not supported inside Safari on iOS**.
来源: <https://developer.apple.com/forums/thread/732594>

→ **对本项目**：用户必须先「Safari → 分享 → 添加到主屏幕」，再从主屏图标打开（standalone 模式），才能订阅推送。这步无法跳过，是 iOS 用户的 UX 摩擦点。

**(b) 必须 PWA 合规（manifest `display: standalone`/`fullscreen` + HTTPS）**：
> iOS relies on the `display: standalone` or `fullscreen` setting to classify your site as a launchable web app ... Be served over HTTPS. Function as a PWA. Open in standalone mode.
来源: <https://academy.insiderone.com/docs/web-push-support-for-mobile-safari>

**(c) 订阅必须由用户手势触发**：
> A web app that has been added to the Home Screen can request permission to receive push notifications **as long as that request is in response to direct user interaction — such as tapping on a 'subscribe' button**.
来源: <https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>

**(d) 通知 action 按钮在 iOS 不支持（一键审批的痛点）**：Apple Developer Forums 多人确认，iOS 上自定义 `actions` 不显示，只有一个 "View" 按钮；`notificationclick` 里拿不到 `action` 字段。
> When I look at the notification on iOS, I only see the "View" action. My self-defined actions ... are ignored and not displayed.
> ...in the lower-right-hand corner ... instead of a drop-down of different user actions, there's just a button called "View".
来源: <https://developer.apple.com/forums/thread/726793>

**(e) `notificationclick` → `clients.openWindow(url)` 在 iOS 不可靠**：多个 iOS 版本（17.x、18.1）报告点通知打不开指定页，社区 workaround 是 `event.preventDefault()` + `clients.matchAll().navigate()`，或把目标 URL 塞进 `notification.tag` 里再处理。
来源: <https://developer.apple.com/forums/thread/733604>

**(f) feature detection 的坑**：iOS 未加到主屏时，`"PushManager" in window` / `"showNotification" in ServiceWorkerRegistration.prototype` 都会 false，无法区分「不支持」vs「需加到主屏」。workaround：检测 `navigator.userActivation`（16.4 新增）来判断是否该提示「请加到主屏」。
来源: <https://developer.apple.com/forums/thread/732594>

**(g) 后台限制**：iOS 严格限制后台处理（这也是 §5 ntfy 自托管 iOS 即时送达难的根因）。Web Push 本身经 APNs 推送（系统级），所以推送送达 OK；但「app 在后台跑逻辑」不行——对本项目影响是**断线重连/补历史得在前台/打开 PWA 时做**（已在 `prd.md` R1 scrollback 重连里覆盖）。

#### 3.3 通知 action 按钮（「通过/拒绝」）跨平台支持

- web.dev 官方：
  > **At the time of writing only Chrome and Opera for Android support actions.**
  来源: <https://web.dev/articles/push-notifications-display-a-notification>
- 机制：`showNotification(title, { actions: [{action:'approve',title:'通过'},{action:'reject',title:'拒绝'}] })`，用户点按钮后在 `notificationclick` 里读 `event.action` 区分。来源: <https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification>
- 可用 `window.Notification?.maxActions` 探测能显示几个按钮；`'actions' in Notification.prototype` 探测是否支持。
- **结论**：通知里的「通过/拒绝」按钮**只在 Android Chrome/Opera 稳定**；iOS 完全不支持、桌面 Firefox 不稳。→ 一键审批的可靠实现 = **点通知 → 打开 PWA → 在页面里点通过/拒绝**（PWA 内通过 WS 回传给 bridge），而不是依赖通知按钮本身。Android 上可锦上添花地加按钮。

---

### 4. 自托管 Web Push（不靠 FCM/APNs 账号）：bridge 直接发

**可行**。bridge(Node) 用 `web-push`(npm) + 自己生成的一对 VAPID 密钥，直接向浏览器订阅时返回的 `endpoint` POST 加密推送。**不需要注册 FCM/APNs 项目或付 Apple 开发者费**——你只是把请求发到各浏览器厂商的 push service endpoint（Android→FCM、Firefox→Mozilla、iOS/Safari→APNs），VAPID 用来向这些 endpoint 证明「是同一个应用服务器」。

WebKit 明确（iOS 也是这套，无需 Apple Developer Program）：
> Web Push on iOS and iPadOS uses the same Apple Push Notification service ... **You do not need to be a member of the Apple Developer Program to use it.** Just be sure to allow URLs from `*.push.apple.com` if you are in control of your server push endpoints.
来源: <https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>

#### 4.1 `web-push`(npm) 用法（官方 README）

来源: <https://www.npmjs.com/package/web-push> , <https://github.com/web-push-libs/web-push/blob/master/README.md>

**生成 VAPID 密钥（只做一次）**：
```js
const webpush = require('web-push');
const vapidKeys = webpush.generateVAPIDKeys();
// { publicKey, privateKey }  ——URL-safe base64
```
或 CLI：`web-push generate-vapid-keys --json`

**配置 + 发送**：
```js
webpush.setVapidDetails(
  'mailto:you@example.org',     // 或 https: URL（VAPID subject）
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// pushSubscription = 浏览器端 PushManager.subscribe() 的 JSON
const pushSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/...', // 或 *.push.apple.com / Mozilla
  keys: { p256dh: '...', auth: '...' }
};

webpush.sendNotification(pushSubscription, JSON.stringify({
  title: 'cc 需要审批',
  body: 'Bash(rm -rf ...) 请求权限',
  data: { kind: 'approval', reqId: 'abc123' }
}));
```

**前端订阅（拿 endpoint）**：
```js
navigator.serviceWorker.ready.then(reg =>
  reg.pushManager.subscribe({
    userVisibleOnly: true,                 // Chrome/Edge 必填，否则 reject
    applicationServerKey: <VAPID_PUBLIC_KEY base64→Uint8Array>
  })
).then(sub => /* POST sub 到 bridge 存起来 */);
```
来源: <https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe>

#### 4.2 Payload 加密

- **`sendNotification()` 自动加密 payload**（无需手动调 `encrypt()`）。前提：subscription 必须含 `keys.p256dh` + `keys.auth`。
- 标准：**RFC 8291**（Web Push 消息加密，ECDH + auth secret）+ **RFC 8188**（HTTP 加密内容编码）+ **RFC 8292**（VAPID JWT ES256）。
- 编码：**`aes128gcm`（推荐，现代）** / `aesgcm`（legacy 兼容老 endpoint）。
来源: <https://github.com/AlexanderSlaa/node-webpush>（同标准库实现，列了三个 RFC）

#### 4.3 「通过/拒绝」选择能否带回

- **通知 action 按钮**：仅 Android Chrome 可靠（见 §3.3）。点按钮 → SW 的 `notificationclick` 拿 `event.action`（`'approve'`/`'reject'`）→ SW 里 `fetch()` 回 bridge 或 `postMessage` 给已打开的 PWA。
- **跨平台稳妥做法**：通知只用来「叫醒用户」，真正的「通过/拒绝」在打开的 PWA 页面里点按钮，经已有的 **WebSocket** 通道回传 bridge（本项目 bridge↔手机已是 WS，复用最自然）。
- iOS：点通知 → 打开 PWA（注意 §3.2(e) openWindow 坑）→ 页面内审批。

#### 4.4 自托管 Web Push 的隐性成本（坑）

- 要**存储每个浏览器的 subscription**（endpoint + keys），endpoint 会过期/失效，需处理 `410 Gone` 清理 + `pushsubscriptionchange` 重订阅。
- iOS 的全部 §3.2 限制照样适用（加到主屏、用户手势、无 action 按钮）——**自托管不解决 iOS UX 摩擦**，只是省了 FCM/APNs 账号。
- VAPID 私钥要保密；payload 别放敏感数据（push service 可能缓存/转发）。

---

### 5. MVP 兜底：ntfy.sh / ntfy 自托管 是否更省事？

**结论：通知这一环，ntfy 比自己搓 Web Push 省事很多，尤其 iOS——但有一个关键 iOS 限制要认。**

#### 5.1 ntfy 是什么 / 怎么用

- ntfy = 简单的 HTTP pub-sub 通知服务；**topic 即密码**（无注册，订阅/发布即创建 topic，所以 topic 名要不可猜）。来源: <https://ntfy.sh/>
- **发通知（bridge 侧，一行 curl 或任意 HTTP 库）**：
  ```bash
  curl -d "cc 需要审批: Bash(rm -rf ...)" ntfy.sh/your-secret-topic-xxxx
  ```
  支持 `X-Title`、优先级 `X-Priority`、tags、**action 按钮**（`view` 打开 URL / `http` 回调 / Android broadcast）。来源: <https://docs.ntfy.sh/publish/>
- **手机收通知**：装 **ntfy Android app**（Google Play / F-Droid）或 **ntfy iOS app**（App Store），订阅 topic 即可。也有 PWA 版。来源: <https://docs.ntfy.sh/subscribe/phone/>
- **自托管**：`ntfy serve`（单二进制 / Docker `binwiederhier/ntfy`）。来源: <https://docs.ntfy.sh/install/>

ntfy action 按钮（比 Web Push 强）：`view`（打开 URL/深链）、`http`（点按钮直接回调一个 HTTP 请求——**天然适合「通过/拒绝」回 bridge**）、`broadcast`。来源: <https://docs.ntfy.sh/publish/>

#### 5.2 ⚠️ ntfy 自托管的 iOS 致命限制（必读）

iOS 后台限制让**自托管 ntfy 无法独立做到即时推送**。ntfy 官方文档原文：

> Unlike Android, iOS heavily restricts background processing, which sadly makes it **impossible to implement instant push notifications without a central server**. To still support instant notifications on iOS through your self-hosted ntfy server, you have to forward so called `poll_request` messages to the main ntfy.sh server (or any upstream server that's APNS/Firebase connected) ... set `upstream-base-url` like so:
> ```
> upstream-base-url: "https://ntfy.sh"
> ```
> **If `upstream-base-url` is not set, notifications will still eventually get to your device, but delivery can take hours** ... If you are using your phone, it shouldn't take more than 20-30 minutes though.
来源: <https://docs.ntfy.sh/config/#ios-instant-notifications>

含义：
- **Android 自托管 ntfy**：即时送达 ✅（F-Droid 版甚至不用 Firebase）。
- **iOS 自托管 ntfy**：要即时，必须配 `upstream-base-url: https://ntfy.sh`，让你的服务器把「有新消息」的 poll_request 经 ntfy.sh → APNs 转发，iOS app 收到后再回你的服务器拉真正内容。**即仍依赖 ntfy.sh 这个中心**（但消息内容仍可只存你自己服务器；ntfy.sh 只转发 "New message" 占位 + message ID）。
- 不配 upstream：iOS 延迟可达数小时（靠系统不定期 background poll），**对「cc 需审批」这种实时性要求高的场景不可接受**。

#### 5.3 ntfy vs 自托管 Web Push 对比

| 维度 | ntfy（app 订阅 topic） | 自托管 Web Push (web-push + VAPID) |
|---|---|---|
| **接入工作量** | ✅ 极低：bridge 一行 curl；手机装 app 订阅 topic | ⚠️ 中：前端 SW + subscribe + 后端存订阅 + 加密 |
| **iOS 即时送达** | ⚠️ 需 `upstream-base-url: ntfy.sh`（仍过 ntfy.sh→APNs）；配好后即时 | ⚠️ 需「加到主屏」PWA + 用户手势；经 APNs，即时 |
| **iOS UX 摩擦** | ✅ 低：装个 app、订阅，无「加到主屏」仪式 | ❌ 高：必须加到主屏 + standalone + 手势订阅 |
| **「通过/拒绝」按钮** | ✅ ntfy `http` action 直接回调 bridge（含 iOS app 也支持 action） | ❌ 仅 Android Chrome 通知按钮；iOS 无 |
| **是否额外装 app** | ❌ 要装 ntfy app（多一个 app） | ✅ 不用，PWA 内搞定 |
| **是否过第三方** | ntfy.sh（或自托管，但 iOS 即时仍过 ntfy.sh） | 过 FCM/Mozilla/APNs endpoint（不可避免） |
| **与本项目 PWA 的契合** | 通知与 PWA 解耦（两个入口） | 通知与 PWA 一体（点通知回 PWA） |
| **隐私** | topic 名=密码，内容默认明文经 ntfy.sh（自托管+upstream 仍泄露"有消息"事件） | payload 端到端加密(VAPID/aes128gcm)，但 endpoint 经厂商 |

#### 5.4 推荐

- **要最快跑通 MVP 且不想碰 iOS PWA 推送那堆坑** → **ntfy（先用公共 ntfy.sh，topic 用长随机串）**。bridge 一行 HTTP 就能推，Android 即时、iOS 配 upstream 后也即时，且 `http` action 能做「通过/拒绝」回调。代价：手机多装一个 ntfy app，通知入口与 PWA 解耦。
- **要「通知 + 审批 + 终端」尽量收在一个 PWA 里、且主力是 Android** → 自托管 Web Push（web-push + VAPID）。iOS 用户接受「加到主屏」摩擦。

---

### 6. 对本项目最合适的通知方案选型 + 关键风险（结论）

**选型建议**：MVP **通知用 ntfy（先 ntfy.sh 公共服务 + 不可猜 topic，bridge 一行 HTTP 推送），iOS 即时性靠 `upstream-base-url: https://ntfy.sh`**；「通过/拒绝」优先用 **ntfy `http` action 按钮直接回调 bridge**（Android/iOS app 都支持，比 Web Push 的通知按钮跨平台性好），复杂审批/查看终端仍回到经 `tailscale serve` HTTPS 暴露的 **xterm.js PWA**（WS 通道做实时审批回传）。**PWA 本体仍走 `tailscale serve` 拿 HTTPS（secure context 必需），即便通知不用 Web Push** ——因为 SW/PWA「加到主屏」/离线/`wss://` 都要安全上下文。把「自托管 Web Push（web-push+VAPID，全收进 PWA、零额外 app）」列为 **fast-follow**，等核心回路跑通、且确认主力平台后再上；它在 Android 体验最好，但解决不了 iOS「加到主屏 + 无 action 按钮」的根本摩擦。

**关键风险**：
1. **iOS 后台限制无法绕过**——无论 ntfy 自托管还是 Web Push，iOS 即时送达都要经过一个 APNs-connected 的中心（ntfy.sh 或浏览器 push service）；纯自托管 + 纯 tailnet 内做不到 iOS 即时推送。这是架构级约束，要提前接受。
2. **「一键审批」别押在通知按钮上**：iOS 不支持 notification actions、桌面 Firefox 不稳；可靠路径是「通知叫醒 → 打开 PWA → WS 回传」或「ntfy `http` action 回调」。
3. **`tailscale serve` 是 PWA 拿 HTTPS 的唯一轻量正解**：裸 100.x / 明文 ts.net 都不是 secure context，SW/Push 全废；首次需在 admin console 开 HTTPS（serve 会引导），且 ts.net 名会进公共 CT 日志（个人自用可接受）。`--bg` 别忘了加，否则关终端就断。
4. **环境**：bridge 机（Windows）需装 Tailscale（`prd.md` 已记录当前**未安装**），手机也要装 Tailscale 才能访问 PWA；这与「装 ntfy app」是两件事——用 ntfy 通知时，手机收通知**不需要**开 Tailscale（ntfy 走公网），但**操作 PWA / 终端必须连 Tailscale**。

---

## 来源链接（全部已 fetch/exa 验证）

**安全上下文**
- MDN Secure Contexts（精确 trustworthy 列表）: <https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts>
- MDN Using Service Workers（HTTPS 要求 + localhost 例外）: <https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers>
- MDN PushManager.subscribe（secure-context-only）: <https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe>
- MDN Push API（SW 入口）: <https://developer.mozilla.org/en-US/docs/Web/API/Push_API>
- MDN Window.isSecureContext: <https://developer.mozilla.org/en-US/docs/Web/API/Window/isSecureContext>

**Tailscale serve / HTTPS**
- Tailscale Serve 官方文档（serve 3000 / 自动 HTTPS / consent 流程）: <https://tailscale.com/docs/features/tailscale-serve>
- Reintroducing Serve and Funnel（`--bg`、多挂载点、新旧 CLI）: <https://tailscale.com/blog/reintroducing-serve-funnel>
- Four ways to put a service on your tailnet（serve 自动 HTTPS + 「browser doesn't know」）: <https://tailscale.com/blog/four-ways-tailscale-service>
- Easy TLS Certificates（`tailscale cert` / Configure HTTPS / Let's Encrypt DNS-01）: <https://tailscale.com/blog/tls-certs>
- Caddy + Tailscale（明文 http 触发浏览器警告原因）: <https://tailscale.com/blog/caddy>
- MagicDNS GA（ts.net 命名 / 证书签发名）: <https://tailscale.com/blog/magicdns>
- Tailscale Funnel beta（证书进公共 CT 日志、隐私说明）: <https://tailscale.com/blog/tailscale-funnel-beta>

**Web Push 矩阵 / iOS**
- WebKit: Web Push for Web Apps on iOS and iPadOS（16.4 home-screen-only / 用户手势 / 无需 Apple Dev Program）: <https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>
- WebKit Features in Safari 16.4: <https://webkit.org/blog/13966/webkit-features-in-safari-16-4/>
- caniuse Push API（iOS 16.4+ Partial）: <https://caniuse.com/push-api>
- caniuse push event / PushSubscription / PushManager: <https://caniuse.com/mdn-api_serviceworkerglobalscope_push_event> , <https://caniuse.com/mdn-api_pushsubscription_endpoint> , <https://caniuse.com/mdn-api_window_pushmanager>
- Apple Forums: 通知 action 按钮 iOS 不显示（只有 View）: <https://developer.apple.com/forums/thread/726793>
- Apple Forums: notificationclick openWindow iOS 不可靠 + workaround: <https://developer.apple.com/forums/thread/733604>
- Apple Forums: Web Push 仅 home-screen / feature detection 坑: <https://developer.apple.com/forums/thread/732594>
- Web Push Support for Mobile Safari（PWA 合规步骤）: <https://academy.insiderone.com/docs/web-push-support-for-mobile-safari>

**自托管 Web Push**
- web-push npm（generateVAPIDKeys / setVapidDetails / sendNotification / encrypt / aes128gcm）: <https://www.npmjs.com/package/web-push> , <https://github.com/web-push-libs/web-push/blob/master/README.md>
- node-webpush（RFC 8291/8188/8292 标准说明）: <https://github.com/AlexanderSlaa/node-webpush>
- web.dev 通知 action 按钮（仅 Android Chrome/Opera）: <https://web.dev/articles/push-notifications-display-a-notification> , <https://web.dev/articles/push-notifications-notification-behaviour>
- MDN showNotification（actions / event.action / secure-context）: <https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification>

**ntfy**
- ntfy 发布消息（curl/CLI、X-Title、优先级、action 按钮 view/http/broadcast）: <https://docs.ntfy.sh/publish/>
- ntfy 配置 — **iOS instant notifications（upstream-base-url 限制）**: <https://docs.ntfy.sh/config/#ios-instant-notifications>
- ntfy 从手机订阅（Android/iOS app、PWA）: <https://docs.ntfy.sh/subscribe/phone/>
- ntfy 安装/自托管: <https://docs.ntfy.sh/install/>
- ntfy 订阅 API（JSON/SSE/WS stream）: <https://docs.ntfy.sh/subscribe/api/>
- ntfy 主页（topic=密码、自托管）: <https://ntfy.sh/>

## Caveats / Not Found

- **版本时效**：caniuse 数据截至本次抓取（2026-06），iOS Safari Web Push 仍标 "Partial support"（partial 专指 home-screen-PWA-only 限制，非功能残缺）。Tailscale CLI 自 1.52 起 serve/funnel 语法改过，落地时务必 `tailscale serve --help` 核对当前版本语法。
- **Windows 上 `tailscale serve` 的权限/服务化**未深挖（官方示例多为 Linux/macOS，含 `sudo`）；Windows 下 Tailscale 以服务运行，`tailscale serve --bg` 应可用，但**建议实测**「关闭/重启 Windows 后 serve 配置是否自动恢复」——这关系到 bridge 长期可用性（`prd.md` R1 持久会话）。未找到 Windows 专门的 serve 持久化官方文档。
- **ntfy iOS app 在「自托管 + upstream-base-url」下，消息内容隐私边界**：文档说自托管服务器只向 ntfy.sh 转发占位 "New message" + message ID，真正内容 iOS app 回自托管服务器拉取；但「有消息这件事」+ message ID 会过 ntfy.sh。若内容高度敏感需进一步评估（本项目个人自用，风险可接受）。
- 未做「自签证书在 iOS 16.4+ 加到主屏 PWA 后 Web Push 是否真能工作」的实证——理论上自签即便装了根证书也可能被 push 注册拒绝；本报告按官方推荐一律用 `tailscale serve` 的公共 CA 证书，规避此不确定性。
