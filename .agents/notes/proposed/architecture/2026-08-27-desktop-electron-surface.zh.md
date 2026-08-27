# Agent Note: 桌面端 —— 预留 IPC 载体之上的 Electron 应用

Status: proposed

[English](2026-08-27-desktop-electron-surface.md) | 中文

## 问题

GUI 栈目前只交付一个物理载体：Web 组合的回环 HTTP 服务器、其 WebSocket 下行链路以及 `frontend-static` 的 dist 服务。桌面产品需要同一棵宿主插件树和同一套浏览器客户端 roster，但不监听端口，还需要浏览器标签页无法提供的集成：原生目录对话框、钥匙串凭据、面向待处理审批与提问的系统通知，以及应用深链。

[GUI 分层 RPC 决策记录](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md) 恰好预留了这个位置——"未来的 Electron 应用复用同一批 web 客户端包，走 IPC fetch 载体"，并明确 `dsh-host-webserver` 不被复用——但尚无任何壳存在。预留接缝未经桌面规模验证：`window.__DSH_TRANSPORT__` 只有一个消费者（worker 预览的 postMessage 隧道），`AbstractApiClient` 传输子类在决策记录的子类表里只是假设行，也没有任何组合在脱离 HTTP 载体的情况下启动过客户端 roster。仓库归属同样未定：本 monorepo，还是消费已发布包的独立仓库。

## 提案

在本仓库内把桌面端建成第三个应用。`apps/desktop` 是一个 Electron 应用，通过新的 `desktop` profile（`@deepseek-ai/dsh-base` 加上新的 `@deepseek-ai/dsh-desktop-app` bundle 补丁）启动。宿主插件树、线协议和整套浏览器插件 roster 保持不变；新代码只有 IPC 载体、Electron 壳，以及落在既有接缝后的小型原生 capability provider。

### 仓库归属

本仓库，而非独立仓库。同 PR 规则——agent-loop 或 `SessionEventMap` 的改动必须在一个 PR 内更新所有客户端投影——只有在载体与客户端 roster 紧邻被投影对象时才可执行。apiproxy 线协议刻意不携带协议版本，因为客户端与宿主一同发布；第二个仓库会把每次 pre-release 重排变成跨仓库版本对齐，并冻结根指令在首个 tagged release 前明确保持不冻结的契约。只有当壳变成稳定已发布包的纯消费者时，拆分才成立——那正是分层决策记录为引入协议版本协商命名的事件。

### 载体设计

- 宿主侧：一个桌面宿主插件按 Web 节点半的同一方式组装传输无关的 fetch handler——`HostConnectionService.createSharedFetchHandler('/api', <apiproxy 回退>)`——并把产出的 `FetchHandler` 桥接到 `ipcMain.handle`，而不是挂载 webserver 路由。Typert 网关在 `ctx.connection.rpc` 上的拦截器注册与传输无关，原样沿用。
- 渲染侧：preload 脚本在任何客户端插件加载前设置 `window.__DSH_TRANSPORT__ = { createApiClient, fetch, loadBundle }`。`dsh-client-connection` 的浏览器半已经优先读取该全局而非 `WebApiClient`，`dsh-client-modules` 的模块系统接受 `loadBundle` 作为插件包字节接缝；worker 预览是现行先例。
- 上行：一个 `AbstractApiClient` 子类只实现 `doFetch`——把 `Request` 经 `ipcRenderer.invoke` 序列化传出，在主进程经共享 fetch handler 执行，再把 `Response` 序列化传回。信封铸造、zod 解析、rpcId 回显校验和一元超时全部留在基类。
- 下行：子类覆写 `openMux`/`openHost`（`FixtureApiClient` 已证明这些虚方法可替换），消费由 `MessageChannelMain` 端口支撑的每逻辑流一个异步迭代器。`ConnectionController` 的握手、重连与基线重放保持不变；渲染进程重载就是一次连接世代的失效。
- 插件包字节：一个特权自定义协议服务应用 index——注入 `__DSH_BOOT__` 图——以及插件包，使模块系统的默认 URL 加载继续工作；当壳自带字节时，走 IPC 的 `loadBundle` 仍是文档化的替代路径。

### 新增包与组合

- `packages/bundle/desktop-app`（`@deepseek-ai/dsh-desktop-app`）：叠在 `dsh-base` 上的 `cordis.patch.yml`，行集合镜像 Web bundle。保留 `api-gateway`、`modules`、`connection`、`api-remotes`、`client-runtime`、storage/workspace/projection 各行，以及 Web 面在 preset 之下停用的 agent 面各行；去掉 `webserver`、`frontend-static`、`web-runtime`、`web-startup`、`client-hmr`，插入下述桌面行。
- `packages/host/desktop-electron`（`@deepseek-ai/dsh-host-desktop-electron`）：壳宿主插件。拥有窗口生命周期、菜单、托盘、单实例锁、深链、自定义协议处理器和 IPC 桥；提供 `desktopRuntime` 服务；把可应答的 `approval/*` 与 `question/*` 帧转发为系统通知，应答走渲染侧使用的同一条 `/api/respond` 路径与 pending-rpcId 表——不存在第二个裁判。
- `apps/desktop`：仅做装配——按分层决策记录，mixture 留在 `apps/`。主进程经 `@deepseek-ai/dsh-app-boot` 的 `runProfile('desktop')` 启动，复用 fail-loud 启动、信号处理与 healed profile 模块回退；electron-builder 打包、签名与自动更新在此。
- `@deepseek-ai/dsh-app-boot` 的 `PROFILE_TEMPLATES` 增加 `desktop` 元组，`apps/cli` 增加镜像 `web` 子命令的 `dsh desktop` 子命令别名 `--profile desktop`。
- 落在既有接缝后的 capability provider，各自是独立小包：`@deepseek-ai/dsh-host-directory-picker-electron` 用 `dialog.showOpenDialog` 实现 `ctx.directoryPicker`（[目录选择器接缝](../../implemented/architecture/2026-07-28-directory-picker-capability-seam.zh.md) 使 `host.pickDirectory` 无需改动），以及一个 `safeStorage` 支撑的 provider 在 `.env` provider 旁实现 credentials capability。

### 特权授权

Web 载体把特权方法集——`host.pickDirectory`、`host.openPath`、settings 与 credentials 面、agent-preset 授权面——通过 connection 节点半内带空信任列表的 Host 头围栏钉死在回环。IPC 不携带 Host 头，因此桌面载体必须在其自身入口做出同一决定：桥只接受来自本应用渲染 WebContents 的请求，且没有监听端口就没有其他进程需要围栏。Typert 网关拦截器的 `trusted-host` 授权成立，因为应用内 IPC 通道与回环等价。这是一条不升级要求：相对 Web 载体，被授权调用特权操作的调用者集合不得扩大（HTTP 侧仍以 [浏览器信任边界决策](../../implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md) 为准）。

### 需共享的 Web 侧机制

- `__DSH_BOOT__` 注入当前位于 webserver 的 index 渲染中。自定义协议处理器必须产出同一张图，因此图组装移入 modules 节点半（或由其导出），两个表面消费同一个生成器。
- 客户端 HMR：Web 组合因重载生命周期未测试而停用共享 HMR；桌面开发在桌面重载行确有必要之前组合在回环 HTTP 面上，而不是在已交付组合里挂一条未测试的重载链。
- 版本化：不引入。桌面 bundle 将宿主与客户端一同交付，因此自动更新必须整体替换应用；局部渲染层更新会在没有协议协商的情况下重新引入独立发布的客户端。

### 里程碑

- M1，薄壳：Electron 主进程启动 Web profile，窗口加载回环 URL。以零载体工作量验证打包、签名、自动更新与通知管道，且不得成为终态。
- M2，桌面 bundle 与 IPC 载体：自定义协议、preload 传输、去掉 webserver 各行；该表面不再监听任何端口。
- M3，原生 capability provider：Electron 目录选择器、钥匙串凭据、深链与通知应答。
- M4，分发加固：若有证据需要，把宿主树 fork 进子进程做崩溃隔离——载体接口在该 fork 后保持不变——以及更新通道。

### 测试

载体协议测试在内存 IPC 桥上跑完整的线协议序列化、zod 与帧解码路径，沿用 `InProcessApiClient` 的同构先例。REAL-composition 测试经 Loader 启动 `desktop` profile 并断言零监听端口与完整的 `__DSH_BOOT__` 图。桌面产品用户可见行为按[测试策略](../../../docs/testing.md)通过真实可运行例子补 keyless snapshot，且 Web 门在无修改的情况下保持绿色。

## 备选方案

**消费已发布包的独立仓库。** 它破坏客户端投影的同 PR 规则，迫使根指令拒绝的 pre-release 契约冻结，并要求线协议刻意省略的协议版本化。只有在契约面向外部消费者稳定之后才正确。

**以 Electron 内回环 HTTP 为终态。** 它保留监听端口、DNS rebinding 与 origin 攻击面，以及 Web 载体携带的绑定限制，并复用分层决策记录明确只归 Web 的 `dsh-host-webserver`。作为里程碑 1 可接受，作为目标被否决。

**非 Node 壳（Tauri 等）。** 宿主树是 Node 插件生态——`node:sqlite`、`sandbox-exec`、Landlock native addon、子进程树。非 Node 壳迫使宿主进入 sidecar 进程，为零能力增益多出一个进程边界。

**把客户端 roster fork 成桌面专用 UI 包。** 这会复制 roster 组合的每一个 `ui-*` 包。桌面差异按客户端导出纪律通过小包里的新 slot 注册进入。

**为 IPC 另立线协议。** 四象限信封在设计上与通道无关；载体替换只是 `doFetch` 子类加两个流虚方法。协议 fork 会让 apiproxy 拥有的每份契约、schema 与测试翻倍。

**首日就把宿主树放进子进程。** 在没有证据前做崩溃隔离。载体接口在之后 fork 时保持不变，因此该拆分无需重设计即可推迟。

## 验收标准

- `dsh desktop` 与打包后的应用以零监听 TCP 端口启动 `desktop` profile，由 REAL-composition 启动测试断言。
- 渲染侧完全经由 IPC 完成就绪握手——`host.describe` 加两条下行流；仅有的外部 `http(s)` 请求是用户发起的导航。
- 特权方法集可被本应用渲染侧调用，且应用之外的任何进程都不可达——没有可连接的端口。
- 浏览器插件 roster 无改动挂载：没有 `dsh.client` 包被 fork 或复制，同一 roster 的 `__DSH_BOOT__` 图与 Web 组合一致。
- 一个共享图生成器同时为 Web index 渲染与桌面 index 产出 boot manifest。
- 内存 IPC 桥上的载体协议测试、REAL-composition 启动测试、以及至少一个已组装桌面 transcript 的 keyless snapshot 存在且通过；`pnpm run test:gui` 与 `DSH_SNAPSHOT=replay pnpm run test:web` 在无修改的情况下保持绿色。

## 风险

预留接缝未经端到端验证。`window.__DSH_TRANSPORT__` 与 `loadBundle` 今天各只有一个消费者；桌面实现可能在 `dsh-client-connection` 或 `dsh-client-modules` 中发现缺口。修复必须落在共享接缝上——同时惠及 worker 预览——绝不作为任一包的桌面 fork。

Electron 的应用生命周期与 fiber 销毁交错：`app.quit` 顺序、回合进行中的渲染进程销毁、信号处理各自需要专属的关机测试，遵循 defensive-patterns 对销毁类工作的要求。

把 index 渲染移到共享生成器触及每个浏览器会话信任的注入点；同一 roster 下 Web 与桌面生成器必须产出一致的图内容，并用测试钉住。

系统通知应答为审批与提问的应答路径增加了第二个入口。它们走既有的 pending-rpcId 表，解决之后到达的通知应答坍缩为既有的 `not-pending` 回执；任何第二个裁判都会 fork 掉"先答先赢"规则。

整体应用更新是纪律风险：只补丁渲染层资产的自动更新工具会在无协议协商的情况下悄悄重新引入独立发布的客户端。

本 note 应用分层决策记录的载体计划而非取代它；[WebSocket 下行载体](../../implemented/architecture/2026-08-04-websocket-downlink-carrier.zh.md) 对 Web 载体的物理下行仍然权威，[web 客户端架构](../../implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md) 对浏览器对象层仍然权威。当本方案落地时，分层决策记录中的假设 IPC 子类行与其 `apps/` 槽位分配变为事实，并在同一改动中更新。
