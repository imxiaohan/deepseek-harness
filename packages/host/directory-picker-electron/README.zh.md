---
description: "目录选择接缝的 Electron 原生后端：把每次选择经桌面 IPC 载体路由到 Electron 主进程，由主进程打开壳窗口所属的原生目录选择器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-electron

[English](README.md) | 中文

## 概述

桌面壳通过 Electron 原生选择器选取工作区目录：`dsh-host-directory-picker-electron` 注册 `native` 能力，把每次选择经桌面 IPC 载体路由到 Electron 主进程；主进程打开挂接在壳窗口上的 `dialog.showOpenDialog`，并把选定的绝对路径回传（取消返回 `null`）。provider 运行在纯 Node 的桌面宿主子进程中，不导入任何 Electron 模块；对话框属于主进程。桌面 bundle 把该后端与无渲染的原生流程占据者一起钉住，一行配对即组合两侧。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

只有桌面壳组合此后端：它读取 `desktopRuntime` 载体通道，该通道由桌面宿主子进程在启动时绑定。任何其他组合都会在第一次选择时大声失败，而不是静默降级。

### 何时选择它

桌面应用选择此后端——Electron 主进程拥有选择器应挂接的窗口。工作站本地的 web 部署改组[子进程原生后端](../directory-picker-native/README.zh.md)；远程部署改组[浏览后端](../directory-picker-browse/README.zh.md)。

### 操作者看到什么

每次选择打开一个以应用窗口为父级的原生选择器并等待操作者；选定目录以绝对路径 resolve，取消 resolve `null`。浏览器侧即既有的无渲染原生流程占据者——每个 `open` 请求驱动 `directoryPicker/pick` 并回报唯一的结局。

### 可观察的失败

取消返回 `null` 而非错误。载体通道断开或对话框失败会以 pick rejection 呈现载体错误；没有桌面通道的组合在第一次选择时以可操作的错误 reject。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

### 设计概念

该后端是桌面载体上的薄服务：`ElectronDirectoryPicker` 注册 `native` 能力，其 `pick` 读取 `ctx.get('desktopRuntime').pickDirectory(signal)`。宿主子进程在启动时把该通道绑定到进程通道上；一个关联的 `pick-directory` 请求 host→main 单程，主进程打开选择器并以一条 `pick-directory-res` 应答。关联 id 命名空间与校验镜像 fetch/stream 载体。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：持有稳定 `native` 能力的 `ElectronDirectoryPicker` 服务 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当后端契约不够用时先读接缝定义，再读承载该往返的载体。

- [目录选择接缝](../directory-picker/README.zh.md) — `native` 能力契约与类型化错误词汇。
- [目录选择接缝决策](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.zh.md) — 后端为何在交互形状上不同；本包即当时预期的 Electron provider。
- [desktop-electron 宿主插件](../desktop-electron/README.zh.md) — IPC 载体协议与原生操作通道绑定。
- [子进程原生后端](../directory-picker-native/README.zh.md) — web 部署的工作站本地替代。

-----

<a id="model-experience"></a>
## 模型体验

无；作为 GUI 宿主的选择后端，不注册任何模型可见内容。

#### KV Cache 影响

无；本包既不组装也不发送提供商请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定 Electron 交互的适用范围；它们是当前的包约束，不是任务清单。

- **仅限桌面壳** — provider 读取 `desktopRuntime` 通道，桌面 bundle 之外的组合会让第一次选择大声 reject，而不是降级。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>

**运行时不变量：** 不发布配套 invariant。每次选择即一次载体往返；选择器结局只有返回的路径。
