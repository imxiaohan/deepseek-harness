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

CLI 启动其安装的 `@deepseek-ai/dsh-desktop` 程序集，并通过经过校验的进程启动信封把 `--patch` overlay 与其余应用参数传给宿主子进程；直接运行 `dsh --profile desktop` 只会启动该宿主 profile，不会创建窗口。preload 在任何客户端插件加载前安装 `window.__DSH_TRANSPORT__ = { fetch, openStream, ownsHost: true }`，并把呈现器的 `light`、`dark` 或 `system` 主题来源投影到 Electron 原生窗口外观。组合出的目录选择器把每次选择沿载体反向路由——一条关联的 host→main 请求，主进程从壳窗口打开 `dialog.showOpenDialog`，选定路径回传宿主子进程。存储的凭据则落在操作系统钥匙串之后：主进程拥有应用数据目录下唯一一份 `safeStorage` 加密文档，组合出的凭据 provider 经同一原生通道读写它，同时保留文件背衬 provider 的环境与 `.env` 分层。外部 `dsh://open?path=` 链接在 main 完整校验——畸形、不支持与跨权威输入（包括内部 `dsh-desktop://` 协议）在其命中的任何命令或 host API 之前被拒绝——接受的意图聚焦窗口并经载体上的既有 `workspace/create` API 收纳工作区；公共协议仅在打包构建中注册。壳以 `contextIsolation: false` 运行，使 connection 客户端按引用取得这些钩子，但只接受窗口当前主 frame 在已加载权威内发出的载体 IPC 和自定义协议宿主路由请求；重载会取消离场文档拥有的工作，跨权威导航与子窗口均被拒绝。自定义协议响应体以 pull 驱动的二进制分块逐块跨越进程通道，因此 Session 导出不会在宿主进程或主进程中实体化完整归档。退出时，壳先撤销文档准入并取消 renderer 工作，再发送平台无关的关闭消息，等待宿主桥与 profile 树达到静止；超过有界宽限期的子进程会被无条件进程终止结束。壳在已有实例运行时拒绝第二次启动，并在致命状况下经控制台及 locale 自有的系统通知与错误对话框文案报告后以非零状态退出。

## Known Limitations and Deferred Work

- 原生 capability provider（通知应答）和分发加固仍处于提案状态，见[原生集成与分发 note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-native-integration-and-distribution.zh.md)。Electron 目录选择器、safeStorage 凭据存储与已校验的应用深链已实现。
- 在 pnpm workspace 符号链接之上做 `electron-builder` 打包需要 hoisted 安装才能产出可分发工件；在此之前 `run dist` 只验证配置形态，更新通道随里程碑 4 落地。
