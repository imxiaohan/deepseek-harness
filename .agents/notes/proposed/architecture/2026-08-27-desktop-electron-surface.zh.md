# Agent Note: 桌面端 —— 预留 IPC 载体之上的 Electron 应用

Status: proposed

[English](2026-08-27-desktop-electron-surface.md) | 中文

## 问题

GUI 栈目前只交付一个物理载体：Web 组合的回环 HTTP 服务器、其 WebSocket 下行链路以及 `frontend-static` 的 dist 服务。桌面产品需要同一棵宿主插件树和同一套浏览器客户端 roster，但不监听端口，还需要浏览器标签页无法提供的集成：原生目录对话框、钥匙串凭据、面向待处理审批与提问的系统通知，以及应用深链。

[GUI 分层记录](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)（现已归档）恰好预留了这个位置——"未来的 Electron 应用复用同一批 web 客户端包，走 IPC fetch 载体"，并明确 `dsh-host-webserver` 不被复用——但尚无任何壳存在。预留接缝未经桌面规模验证：`window.__DSH_TRANSPORT__` 在仓库内恰有一个提供者（experimental webworker runtime 的隧道），传输子类预留只是那份归档记录里的假设行，也没有任何组合在脱离 HTTP 载体的情况下启动过客户端 roster。仓库归属同样未定：本 monorepo，还是消费已发布包的独立仓库。

## 提案

在本仓库内把桌面端建成第三个应用。`apps/desktop` 是一个 Electron 应用，通过新的 `desktop` profile（`@deepseek-ai/dsh-base` 加上新的 `@deepseek-ai/dsh-desktop-app` bundle 补丁）启动。宿主插件树、线协议和整套浏览器插件 roster 保持不变；新代码只有 IPC 载体、Electron 壳，以及落在既有接缝后的小型原生 capability provider。

### 仓库归属

本仓库，而非独立仓库。同 PR 规则——agent-loop 或 `SessionEventMap` 的改动必须在一个 PR 内更新所有客户端投影——只有在载体与客户端 roster 紧邻被投影对象时才可执行。apiproxy 线协议刻意不携带协议版本，因为客户端与宿主一同发布；第二个仓库会把每次 pre-release 重排变成跨仓库版本对齐，并冻结根指令在首个 tagged release 前明确保持不冻结的契约。只有当壳变成稳定已发布包的纯消费者时，拆分才成立——那正是分层决策记录为引入协议版本协商命名的事件。

### 载体设计

- 宿主侧：一个桌面宿主插件按 Web 节点半的同一方式组装传输无关的 fetch handler——`HostConnectionService.createSharedFetchHandler('/api')`——并把产出的 `FetchHandler` 桥接到 `ipcMain.handle`，而不是挂载 webserver 路由。Typert 网关在 `ctx.connection.rpc` 上的拦截器注册与传输无关，原样沿用。
- 虚拟 `webServer` 服务：保留行的节点半硬注入 `webServer`——`ClientModuleRegistry`（`inject: ['webServer', 'loader']`，`/plugins` bundle 路由，`webserver/index-inject` 监听）、connection 节点半（`/api` 路由）与 API Gateway 的 WebSocket 升级——而 `dsh-host-webserver` 激活即监听、分层记录明确只归 Web。桌面壳插件因此以同名服务提供虚拟 `webServer`：一个接受 `register`/`registerUpgrade`/`registerFallback` 的路由注册表，加上供桌面 index 渲染消费的 index 注入收集。自定义协议处理器从该注册表服务 index 与 `/plugins` bundle 路由；IPC 上行绕开 Node HTTP 路由、经共享 handler 在 fetch 级分发，因此注册进虚拟服务的 `/api` 与升级路由只为满足注入契约而存在，不会被任何请求触达。
- 渲染侧：preload 脚本在任何客户端插件加载前设置 `window.__DSH_TRANSPORT__ = { fetch, openStream, loadBundle, ownsHost: true }`——即现行 `ClientTransportHooks` 面。`dsh-client-connection` 的浏览器半已经消费该全局（served web app 不设置它、走 HTTP 加 Gateway WebSocket），`dsh-client-modules` 的模块系统接受 `loadBundle` 作为插件包字节接缝；experimental webworker runtime 是现行先例。
- 上行：载体走传输 `fetch` 钩子——把 `Request` 经 `ipcRenderer.invoke` 序列化传出，在主进程经共享 fetch handler 执行，再把 `Response` 序列化传回。信封铸造、zod 解析、rpcId 回显校验和一元超时全部留在 connection 客户端。客户端的 `resolveBase` 取页面同源，而自定义协议 origin 铸不出回环权威——fetch `Request` 本身不携带 Host 头——因此桥重建 `Request` 时显式合成回环 `host` 头（`127.0.0.1`）；若桥在自身入口套用 `HostConnectionService.requestRejection`，Host/Origin 围栏原样通过；桥自身的 WebContents 来源检查是外门。
- 下行：载体走传输 `openStream` 钩子——由 `MessageChannelMain` 端口支撑的每逻辑流一个异步迭代器；webworker 隧道已证明该钩子可替换。`ConnectionController` 的握手、重连与基线重放保持不变；渲染进程重载就是一次连接世代的失效。
- 插件包字节：一个特权自定义协议服务应用 index——注入 `__DSH_BOOT__` 图——以及插件包，使模块系统的默认 URL 加载继续工作；当壳自带字节时，走 IPC 的 `loadBundle` 仍是文档化的替代路径。

### 新增包与组合

- `packages/bundle/desktop-app`（`@deepseek-ai/dsh-desktop-app`）：叠在 `dsh-base` 上的 `cordis.patch.yml`，行集合镜像 Web bundle。保留 `modules`、`connection`、`api-remotes`、各 `api/*-controller` 行、storage/workspace/projection 各行，以及 Web 面在 preset 之下停用的 agent 面各行；去掉 `webserver`、`web-runtime`（`frontend-static` 由其经 fallback 座挂载，随之而去）、`web-startup`、`client-hmr`，插入下述桌面行；Web 的 `connection` 行注入 `webRuntime` 取其 `trustedHosts` 配置，桌面补丁须重述该行配置。
- `packages/host/desktop-electron`（`@deepseek-ai/dsh-host-desktop-electron`）：壳宿主插件。拥有窗口生命周期、菜单、托盘、单实例锁、深链、自定义协议处理器和 IPC 桥；提供虚拟 `webServer` 服务与 `desktopRuntime` 服务；把可应答的 `approval/*` 与 `question/*` 帧转发为系统通知，应答走渲染侧使用的同一条 `/api/respond` 路径与 pending-rpcId 表——不存在第二个裁判。
- `apps/desktop`：仅做装配——按分层决策记录，mixture 留在 `apps/`。主进程经 `@deepseek-ai/dsh-app-boot` 的 profile 机制启动 `desktop` profile；`runProfile` 目前是 `apps/cli` 的 app 本地模块，随本方案上移进 `dsh-app-boot`，两个 app 共用 fail-loud 启动与 healed profile 模块回退；其进程信号语义不变，Electron 的 `app.quit` 顺序由壳插件负责；electron-builder 打包、签名与自动更新在此。
- `@deepseek-ai/dsh-app-boot` 的 `PROFILE_TEMPLATES` 增加 `desktop` 元组，`apps/cli` 增加镜像 `web` 子命令的 `dsh desktop` 子命令别名 `--profile desktop`。
- 落在既有接缝后的 capability provider，各自是独立小包：`@deepseek-ai/dsh-host-directory-picker-electron` 用 `dialog.showOpenDialog` 实现 `ctx.directoryPicker`（[目录选择器接缝](../../implemented/architecture/2026-07-28-directory-picker-capability-seam.zh.md) 使 `host.pickDirectory` 无需改动），以及一个 `safeStorage` 支撑的 provider 在 `.env` provider 旁实现 credentials capability。

### 特权授权

Web 载体上，每个 `/api` 请求在分发前经过 Host/Origin 浏览器信任围栏加持久浏览器会话认证（`HostConnectionService.requestRejection`），客户端把特权面——settings 与 credentials、agent-preset 创作、宿主原生操作——闸在 `ctx.connection.isLoopback` 上：回环页面权威、声明 `ownsHost` 的传输或非浏览器上下文成立。桌面载体在自身入口做出同一决定：preload 声明 `ownsHost: true`（webworker 先例——渲染侧完整拥有宿主），桥为围栏合成回环权威（见载体设计），且只接受来自本应用渲染 WebContents 的请求——应用内 IPC 通道与回环等价，没有监听端口就没有其他进程需要围栏。这是一条不升级要求：相对 Web 载体，被授权调用特权操作的调用者集合不得扩大（HTTP 侧仍以 [浏览器信任边界决策](../../implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md) 为准）。

### 需共享的 Web 侧机制

- `__DSH_BOOT__` 的组装已在 modules 节点半：`ClientModuleRegistry.graph()` 与导出的 `bootInjections()` 产出图与注入行，webserver 只负责收集（`webserver/index-inject` 事件）与渲染（导出的 `renderIndexInjections` 纯函数）。无需迁移：桌面 index 消费同一服务与生成器并复用同一渲染函数，两个表面天然共享一个生成器。
- 客户端 HMR：Web 组合因重载生命周期未测试而停用共享 HMR；桌面开发在桌面重载行确有必要之前组合在回环 HTTP 面上，而不是在已交付组合里挂一条未测试的重载链。
- 版本化：不引入。桌面 bundle 将宿主与客户端一同交付，因此自动更新必须整体替换应用；局部渲染层更新会在没有协议协商的情况下重新引入独立发布的客户端。

### 里程碑

- M1，薄壳：Electron 主进程启动 Web profile，窗口加载经认证的回环 URL（`BrowserAuth.authenticatedUrl`）。以零载体工作量验证打包、签名、自动更新与系统通知的发出（应答路径属 M3），且不得成为终态。
- M2，桌面 bundle 与 IPC 载体：自定义协议、preload 传输、去掉 webserver 各行；该表面不再监听任何端口。
- M3，原生 capability provider：Electron 目录选择器、钥匙串凭据、深链与通知应答。
- M4，分发加固：若有证据需要，把宿主树 fork 进子进程做崩溃隔离——载体接口在该 fork 后保持不变——以及更新通道。

### 测试

载体协议测试在内存 IPC 桥上跑完整的线协议序列化、zod 与帧解码路径，沿用 connection 包在内存 fetch handler 上的线协议测试先例。REAL-composition 测试经 Loader 启动 `desktop` profile 并断言零监听端口与完整的 `__DSH_BOOT__` 图。内存桥测试断言桥铸造的请求带回环 `host` 头，并在自定义协议 origin 下钉住 `resolveBase` 的 URL 解析；REAL-composition 测试断言保留行的 fiber 针对虚拟 `webServer` 服务完成激活。桌面产品用户可见行为按[测试策略](../../../../docs/testing.zh.md)通过真实可运行例子补 keyless snapshot，且 Web 门在无修改的情况下保持绿色。

## 备选方案

**消费已发布包的独立仓库。** 它破坏客户端投影的同 PR 规则，迫使根指令拒绝的 pre-release 契约冻结，并要求线协议刻意省略的协议版本化。只有在契约面向外部消费者稳定之后才正确。

**以 Electron 内回环 HTTP 为终态。** 它保留监听端口、DNS rebinding 与 origin 攻击面，以及 Web 载体携带的绑定限制，并复用分层决策记录明确只归 Web 的 `dsh-host-webserver`。作为里程碑 1 可接受，作为目标被否决。

**非 Node 壳（Tauri 等）。** 宿主树是 Node 插件生态——`node:sqlite`、`sandbox-exec`、Landlock native addon、子进程树。非 Node 壳迫使宿主进入 sidecar 进程，为零能力增益多出一个进程边界。

**把客户端 roster fork 成桌面专用 UI 包。** 这会复制 roster 组合的每一个 `ui-*` 包。桌面差异按客户端导出纪律通过小包里的新 slot 注册进入。

**为 IPC 另立线协议。** 四象限信封在设计上与通道无关；载体替换只是 `doFetch` 子类加两个流虚方法。协议 fork 会让 apiproxy 拥有的每份契约、schema 与测试翻倍。

**首日就把宿主树放进子进程。** 在没有证据前做崩溃隔离。载体接口在之后 fork 时保持不变，因此该拆分无需重设计即可推迟。

## 验收标准

- `dsh desktop` 与打包后的应用以零监听 TCP 端口启动 `desktop` profile，由 REAL-composition 启动测试断言；保留的 `modules`、`connection` 两行针对壳插件的同名虚拟 `webServer` 服务完成激活。
- 渲染侧完全经由 IPC 完成就绪握手——`host.describe` 加两条下行流；仅有的外部 `http(s)` 请求是用户发起的导航。
- 特权方法集可被本应用渲染侧调用，且应用之外的任何进程都不可达——没有可连接的端口。
- 浏览器插件 roster 无改动挂载：没有 `dsh.client` 包被 fork 或复制，同一 roster 的 `__DSH_BOOT__` 图与 Web 组合一致。
- 桌面 index 渲染消费与 Web index 渲染相同的图生成器（modules 节点半的 `bootInjections`），不复制、不迁移任何图代码。
- 内存 IPC 桥上的载体协议测试、REAL-composition 启动测试、以及至少一个已组装桌面 transcript 的 keyless snapshot 存在且通过；`pnpm run test:gui` 与 `DSH_SNAPSHOT=replay pnpm run test:web` 在无修改的情况下保持绿色。

## 风险

预留接缝未经端到端验证。`window.__DSH_TRANSPORT__` 在仓库内有一个提供者（experimental webworker runtime，且在 worker 沙箱之内），尚无组合把它作为独立应用载体启动过客户端 roster；桌面是该接缝的第一个应用级使用者，实现可能在 `dsh-client-connection` 或 `dsh-client-modules` 中发现缺口。修复必须落在共享接缝上——同时惠及 webworker runtime——绝不作为任一包的桌面 fork。

Electron 的应用生命周期与 fiber 销毁交错：`app.quit` 顺序、回合进行中的渲染进程销毁、信号处理各自需要专属的关机测试，遵循 defensive-patterns 对销毁类工作的要求。

桌面 index 渲染经一条新的物理路径消费每个浏览器会话信任的注入点；同一 roster 下 Web 与桌面渲染必须产出一致的图内容，并用测试钉住。

系统通知应答为审批与提问的应答路径增加了第二个入口。它们走既有的 pending-rpcId 表，解决之后到达的通知应答坍缩为既有的 `not-pending` 回执；任何第二个裁判都会 fork 掉"先答先赢"规则。

整体应用更新是纪律风险：只补丁渲染层资产的自动更新工具会在无协议协商的情况下悄悄重新引入独立发布的客户端。

本 note 应用已归档分层记录的载体计划而非取代它；现行的 [transport 分层记录](../../implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.zh.md) 拥有当前载体边界，[web 客户端架构](../../implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md) 拥有浏览器对象层。归档记录已冻结：本方案落地时，桌面各行在同一改动中更新现行记录，归档中的假设 IPC 行保持历史原样。
