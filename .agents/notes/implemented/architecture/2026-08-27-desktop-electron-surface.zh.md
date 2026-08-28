# Agent Note: 桌面 Electron 壳与零端口 IPC 载体

Status: implemented

[English](2026-08-27-desktop-electron-surface.md) | 中文

## 问题

Web 组合把回环 HTTP 服务器、WebSocket 下行链路与静态文件路由作为物理浏览器载体。桌面应用需要复用同一棵宿主树、线协议、preset 与浏览器客户端 roster，且不能继承监听端口或创建桌面专用客户端 fork。Electron 还引入进程、导航、renderer 故障与应用关机生命周期，这些路径都必须把宿主树销毁到静止。

已归档的 [GUI 分层记录](../../archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)预留了这种装配：Electron 应用通过 IPC fetch 载体复用 Web 客户端包，且不组合 `dsh-host-webserver`。当前[传输分层记录](2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)拥有共享传输拆分，[Web 客户端架构](2026-07-19-gui-web-client-architecture.zh.md)拥有浏览器对象层。

## 决策

### 仓库与组合

桌面应用位于本仓库。载体和客户端 roster 与被投影的宿主 API 共处一处，因而保留了 agent-loop 或 `SessionEventMap` 改动必须在同一变更中更新所有客户端投影的规则。apiproxy 线协议没有协议版本，因为宿主与客户端一同发布；只有当壳消费带显式协议协商的稳定已发布包时，拆分仓库才成立。

`apps/desktop` 是由 `dsh desktop` 启动的已发布 Electron 程序集。其宿主子进程启动 `desktop` profile，该 profile 把 `@deepseek-ai/dsh-desktop-app` 叠在 `@deepseek-ai/dsh-base` 之上。desktop bundle 镜像 Web 行，但去掉 HTTP 载体族（`webserver`、`web-runtime`、`web-startup` 与 `client-hmr`），并加入 `@deepseek-ai/dsh-host-desktop-electron`。直接运行 `dsh --profile desktop` 仍是宿主子进程与记录会话测试使用的无窗口 profile 入口。

CLI 解析其安装的 `@deepseek-ai/dsh-desktop` 程序集，并通过经过校验的进程启动信封传递 profile overlay 与应用参数。Electron 单实例锁会拒绝第二次启动，而不是静默丢弃该信封。

### 载体

- 宿主包提供虚拟 `webServer` 服务，因为保留的 node 行为插件路由、index 注入、`/api` 路由与 Gateway upgrade 注入该服务。其路由注册表不拥有服务器或套接字；`host` 返回宿主侧回环权威，`port` 抛错。
- 宿主包还提供 `desktopRuntime`。它通过虚拟注册表分发插件资源请求，通过 `HostConnectionService.createSharedFetchHandler('/api')` 分发 API 请求，通过 Gateway wire 通道分发逻辑 stream，并通过共享 module graph 生成器提供 index 启动数据。
- preload 在客户端插件加载前安装 `window.__DSH_TRANSPORT__ = { fetch, openStream, ownsHost: true }`。connection 客户端消费与实验性 worker 载体相同的传输钩子。壳使用 `contextIsolation: false`，使浏览器原生 `Request`、`Response` 与 stream 值按引用跨越；每次载体调用都由 Electron 主进程授权，而非依赖 renderer world 隔离。
- renderer fetch 与逻辑 stream 经 Electron 主进程中继到宿主子进程。abort 消息穿过两段 IPC 并到达宿主操作的 signal。reload、主 frame 导航、窗口关闭、renderer 故障与壳关机都会取消离场 renderer 代际拥有的操作。
- 特权 `dsh-desktop://` 协议提供已注入的应用 index 与注册插件 bundle。协议上的 `/api` 请求使用同一宿主 fetch 通道，包括 Session 导出；响应体以 pull 驱动的二进制分块跨越宿主/主进程通道，因此两端都不会实体化完整归档。

### 特权权威

preload 声明 `ownsHost: true`，使共享客户端可以暴露仅回环产品操作。Electron 主进程只接受当前窗口已提交主 frame 文档在仍处于已加载权威内时发出的 IPC 与自定义协议宿主路由。主 frame 导航开始会在任何替换文档提交前撤销原文档准入、取消其活动操作，并阻止它在 unload 期间新建工作。跨权威导航、外部 redirect、subframe、子窗口、webview 与外部 WebContents 都无法到达载体。

宿主子进程收到回环 URL，因为自定义协议 origin 不具备宿主路由语义。该 URL 改写不是 HTTP 认证：Web 载体继续按[浏览器信任决策](2026-07-28-api-browser-trust-boundary.zh.md)拥有 Host/Origin 与浏览器会话检查，Electron 主进程拥有桌面文档准入。

### 进程生命周期

profile 树运行在宿主子进程中，同一 Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 运行。Electron 二进制在两种模式下都不暴露 Node 内部 ESM loader，因此 vendored Loader 使用按配置树解析的 import 回退。子进程让 profile 销毁独立于主进程与 renderer 故障；把树放入 Electron 主进程既没有 loader 优势，也会耦合两者生命周期。

正常窗口关闭、`SIGINT` 与 `SIGTERM` 都调用 `app.quit()`。关机过程先撤销 renderer 准入并取消文档拥有的工作，再关闭 listener、发送平台无关的宿主关机消息、中止并等待活动桥操作，并在子进程退出前销毁 profile 树。无条件进程终止只会结束未在有界宽限期内达到静止的子进程。致命 renderer 或 IPC 故障走同一排空路径并保留非零应用退出状态；其通知与错误对话框文案来自按操作系统 locale 选择的原生字典。

桌面用户 patch 热重载被冻结，因为 vendored config-HMR 服务要求 Electron 二进制不暴露的 Node 内部模块。宿主与客户端仍是一个发布单元；不支持只更新 renderer。

### 验证

单元测试钉住 IPC 字段校验、请求与响应序列化、响应体 reader 取消、有界响应流、runtime 分发、原生 locale 文案与虚拟注册表生命周期。REAL-composition 测试启动 desktop profile，验证保留行处于 ACTIVE，比较与 Web 共享的浏览器 roster 行及调度阶段（排除传输自有 HMR），并读取同一个共享 boot graph。

已构建应用的 Playwright 测试禁止宿主子进程监听套接字，拒绝外部权威、frame、window、redirect 与非法 IPC，并验证 reload 和关机准入取消、单实例拒绝、renderer 故障、正常退出、信号、桥销毁、阻塞 disposer 的强制终止与宿主子进程最终退出。Linux 的 PR 和 master CI 在 Xvfb 下运行该套件；Windows 与 macOS 的 PR CI 原生运行。一个 keyless 记录会话场景经 `dsh --profile desktop` replay。

## 考虑过的替代方案

**由独立仓库消费已发布包。** 它会破坏协调客户端投影更新，迫使 pre-release 契约冻结，并要求当前线协议刻意省略的协议版本。只有包和线协议成为稳定外部 API 后才适用。

**把 Electron 内的回环 HTTP 作为最终载体。** 它保留监听端口、浏览器 origin 攻击路径与宿主绑定限制，并组合分层决策只分配给 Web 的 HTTP 包。

**使用非 Node 壳。** 宿主树依赖 Node 服务、原生 addon 与子进程控制。非 Node 壳仍需要 Node sidecar，却增加一个不提供必要能力的 runtime。

**桌面专用客户端 roster。** 它复制浏览器功能包并削弱协调投影变更。桌面专属呈现应使用增量 slot 注册，而不是 fork 共享包。

**第二套应用线协议。** connection 信封与 Gateway stream 与载体无关。第二套协议会复制校验、取消、错误与 replay 语义。

**把宿主树放入 Electron 主进程。** 它省去一次进程中继，却会耦合 Electron 与 profile 销毁，而 Electron 二进制仍缺少内部 ESM loader。子进程提供可独立限定的生命周期。

## 后果

desktop profile 没有 TCP 或 WebSocket listener，并复用共享浏览器 roster、boot graph、unary 信封、stream 值与 session transcript 行为。载体增加两段 IPC 和显式宿主子进程生命周期，但取消与 pull 驱动响应流在其间保留有界工作。

Electron 主进程是安全关键的文档准入点，因为 renderer world 会刻意与客户端代码共享传输值。任何新载体入口都必须在分发前应用相同的已提交主 frame 与已加载权威规则。

原生 capability provider 与可分发发布加固不属于本决策。它们仍位于[桌面原生集成与分发提案](../../proposed/architecture/2026-08-27-desktop-native-integration-and-distribution.zh.md)。
