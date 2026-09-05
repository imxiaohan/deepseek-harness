# Agent Note: 已校验的应用深链

Status: implemented

[English](2026-09-02-desktop-deep-links.md) | 中文

## 问题

桌面壳没有注册任何外部协议，应用之外没有任何东西能把意图带进来，单实例路径也只是聚焦窗口。深链是操作系统直接投递到 Electron 主进程的输入——壳所拥有的最特权入口——因此其词表必须闭合，校验必须在其命中的任何命令或 host API 之前完成。

## 决策

纯校验器拥有准入，main 经既有应用 API 分发接受的意图。

- 公共协议是 `dsh://`。注册（`setAsDefaultProtocolClient`）只在打包构建中进行——开发构建共享同一个 Electron 二进制，在那里注册会认领每个未打包开发应用的链接。
- 入口：macOS `open-url`（阻止默认行为，就绪前排入队列）、全平台的暖 `second-instance` argv、以及载体就绪后排放的冷启动 argv 扫描。三者汇入同一个 `enqueueDeepLink`。
- `parseDesktopDeepLink` 完整校验：精确的 `dsh:` 协议、无凭据无片段、无 pathname、唯一闭合操作（`open` 带单个必须为绝对 POSIX 或 Windows 盘符路径的 `path` 参数）、长度有界、参数恰有一个。畸形、不支持与跨权威输入——包括任何声称内部特权 `dsh-desktop://` 协议的输入——以控制台诊断拒绝，绝不进入分发。
- 接受的 `open` 聚焦（或创建）窗口，并经载体上的既有 `workspace/create` Remote 收纳工作区：一个 `client-request` 信封 POST 到回环 `/api` 路由，与每个 renderer API 调用相同的共享 handler 与 Electron-main 准入。被拒绝的操作（不再存在的路径）只是诊断且窗口已在前；只有载体损坏才让壳失败。

## 考虑过的替代方案

- **经 renderer 导航分发（`window.loadURL`）。** 拒绝：note 的规则——renderer 导航不是权威；链接命名 URL 会把 renderer 导航意图偷运过 main 的校验。
- **把意图投递给 renderer 分发。** 暂缓：尚无客户端意图消费者，经既有 host API 路由无需它；renderer 消费者以后可在同一校验器之后加入。
- **开发构建也注册协议。** 拒绝：未打包的 Electron 构建共享一个二进制和一条协议数据库记录；开发注册会为每个 checkout 劫持 `dsh://`。
- **现在就铺开操作词表。** 拒绝：一个带完整校验的操作才是诚实的第一词表；操作连同各自的校验与分发加入，而不是放松准入。

## 后果

- e2e 通道确定性地驱动暖入口：第二个携带链接的 Electron 实例交出 argv 后在单实例锁上退出，组合的 workspace registry 经 fixture 探针显示已收纳的工作区。
- 校验器是纯函数，对接受、畸形、不支持与跨权威形状无头测试；`apps/desktop/src/deep-link.ts` 是词表的唯一家。
