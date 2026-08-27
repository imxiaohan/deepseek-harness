# dsh desktop

[English](README.md) | 中文

Harness 的 Electron 壳，[桌面端 note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.zh.md) 里程碑 1–2。主进程拥有窗口与 IPC 载体：渲染侧 fetch 中继到宿主子进程（同一二进制以 `ELECTRON_RUN_AS_NODE=1` 运行，Node 内部 ESM loader 在其中可用），后者启动 `desktop` profile；应用 index 与插件 bundle 经特权 `dsh-desktop://` 协议服务，`/api` 信任围栏读取桥合成的回环权威——该表面不监听任何 TCP 端口。

## 运行

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dev     # build the shell and open the window
DSH_DESKTOP_PROFILE=web pnpm --filter @deepseek-ai/dsh-desktop run dev   # milestone-1 loopback mode
pnpm --filter @deepseek-ai/dsh-desktop run dist    # electron-builder packaging (release/)
dsh desktop                                        # the CLI alias for --profile desktop
```

preload 在任何客户端插件加载前安装 `window.__DSH_TRANSPORT__ = { fetch, openStream, ownsHost: true }`（壳以 `contextIsolation: false` 运行，connection 客户端按引用取得钩子；载体的信任线是主进程的发送方门）。壳拥有 Electron 的退出顺序、持有单实例锁，并在致命状况下经控制台、系统通知与错误对话框报告。

## Known Limitations and Deferred Work

- 里程碑 3（原生 capability provider：Electron 目录选择器、钥匙串凭据、深链、通知应答）与里程碑 4（更新通道、崩溃隔离）待做，见 [note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.zh.md)。
- CI 尚未运行 Electron e2e；载体的非 Electron 半边由 `packages/host/desktop-electron/tests/carrier.host.spec.ts` 覆盖，完整组合由 `tests/desktop-profile.spec.ts`（REAL boot、零载体行、虚拟 webServer 语义）覆盖，零端口表面由本地冒烟覆盖。
- 在 pnpm workspace 符号链接之上做 `electron-builder` 打包需要 hoisted 安装才能产出可分发工件；在此之前 `run dist` 只验证配置形态，更新通道随里程碑 4 落地。
