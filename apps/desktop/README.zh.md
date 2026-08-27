# dsh desktop

[English](README.md) | 中文

Harness 的 Electron 薄壳，[桌面端 note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.zh.md) 里程碑 1。主进程经 `@deepseek-ai/dsh-app-boot` 的 `runProfile` 启动 Web profile，随后在单窗口中加载带进程令牌的回环 URL（`BrowserAuth.authenticatedUrl`）——零载体工作量，且刻意不是终态。

## 运行

```sh
pnpm --filter @deepseek-ai/dsh-desktop run dev     # build the shell and open the window
DSH_DESKTOP_PROFILE=web pnpm --filter @deepseek-ai/dsh-desktop run dev
pnpm --filter @deepseek-ai/dsh-desktop run dist    # electron-builder packaging (release/)
```

壳向 Web profile 传递 `--no-open`（窗口即浏览器交接），持有单实例锁，并拥有 Electron 的退出顺序：`before-quit` 把最终退出推迟到 profile 树的有界 shutdown 完成销毁之后。致命启动错误经控制台、系统通知与错误对话框报告——这是里程碑 1 对通知发出路径的验证。

## Known Limitations and Deferred Work

- 里程碑 1 保留回环 HTTP 载体；IPC 载体、自定义协议与零端口表面在里程碑 2 落地，可应答帧的通知应答在里程碑 3（[note](../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.zh.md)）。
- CI 尚未运行 Electron e2e；壳的非 Electron 逻辑由 `tests/app-url.spec.ts` 覆盖，dev 运行即本里程碑的打包验证。
- 在 pnpm workspace 符号链接之上做 `electron-builder` 打包需要 hoisted 安装才能产出可分发工件；在此之前 `run dist` 只验证配置形态，更新通道随里程碑 4 落地。
