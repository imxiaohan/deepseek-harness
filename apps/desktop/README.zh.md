# dsh desktop

[English](README.md) | 中文

Harness 的 Electron 壳，实现[桌面载体决策](../../.agents/notes/implemented/architecture/2026-08-27-desktop-electron-surface.zh.md)。主进程拥有窗口与 IPC 载体：渲染侧 fetch 中继到宿主子进程（同一二进制以 `ELECTRON_RUN_AS_NODE=1` 运行，并使用 Loader 按配置树解析的 import 回退），后者启动 `desktop` profile；应用 index 与插件 bundle 经特权 `dsh-desktop://` 协议服务。主 frame 文档准入负责授权载体调用，宿主路由收到合成的回环 URL，且该表面不监听任何 TCP 端口。

## 运行

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dev     # build the shell and open the window
DSH_DESKTOP_PROFILE=web pnpm --filter @deepseek-ai/dsh-desktop run dev   # milestone-1 loopback mode
pnpm --filter @deepseek-ai/dsh-desktop run dist    # electron-builder packaging (release/)
dsh desktop                                        # launch the Electron app through the public CLI
```

CLI 启动其安装的 `@deepseek-ai/dsh-desktop` 程序集，并通过经过校验的进程启动信封把 `--patch` overlay 与其余应用参数传给宿主子进程；直接运行 `dsh --profile desktop` 只会启动该宿主 profile，不会创建窗口。preload 在任何客户端插件加载前安装 `window.__DSH_TRANSPORT__ = { fetch, openStream, ownsHost: true }`。壳以 `contextIsolation: false` 运行，使 connection 客户端按引用取得这些钩子，但只接受窗口当前主 frame 在已加载权威内发出的载体 IPC 和自定义协议宿主路由请求；重载会取消离场文档拥有的工作，跨权威导航与子窗口均被拒绝。自定义协议响应体以 pull 驱动的二进制分块逐块跨越进程通道，因此 Session 导出不会在宿主进程或主进程中实体化完整归档。退出时，壳发送平台无关的关闭消息，等待宿主桥与 profile 树达到静止，只在有界宽限期结束后才强制终止子进程。壳在已有实例运行时拒绝第二次启动，并在致命状况下经控制台、系统通知与错误对话框报告后以非零状态退出。

## Known Limitations and Deferred Work

- 原生 capability provider（Electron 目录选择器、钥匙串凭据、深链与通知应答）和分发加固仍处于提案状态，见[原生集成与分发 note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-native-integration-and-distribution.zh.md)。
- Windows 尚无原生 Electron e2e 通道。Linux CI 在 Xvfb 下运行 `test:desktop:built`；同一套已构建应用测试在 macOS 直接运行，并覆盖权威校验、宿主零监听、reload 取消、非法 IPC、renderer 故障、信号、正常退出与单实例锁。
- 在 pnpm workspace 符号链接之上做 `electron-builder` 打包需要 hoisted 安装才能产出可分发工件；在此之前 `run dist` 只验证配置形态，更新通道随里程碑 4 落地。
