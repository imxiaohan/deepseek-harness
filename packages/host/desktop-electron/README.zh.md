---
description: "桌面壳的宿主插件：IPC 载体之上的虚拟 webServer（零监听套接字）、desktopRuntime 通道，以及宿主子进程与应用共享的无 Electron 载体协议。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-desktop-electron

[English](README.md) | 中文

<a id="summary"></a>

## 概述

桌面壳的宿主侧包：树侧插件提供虚拟 `webServer` 服务（无监听套接字的路由注册表与 index 注入收集）和 `desktopRuntime` 载体通道（API 与已注册插件资源 fetch、Gateway wire stream 和 boot 载荷），以及不依赖 Electron 的载体半边——IPC 线协议、宿主子进程桥、preload 传输核心——由 Electron 应用装配。

## 目录

- [概述](#summary)
- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>

## 使用本包

以 `desktop` profile（`@deepseek-ai/dsh-desktop-app`）的 `desktop-electron` 行组合本插件；它必须先于注入 `webServer` 的行（`modules`、`connection`、API Gateway）挂载。Electron 应用（`apps/desktop`）导入载体半边：宿主子进程在进程通道上用 `serveDesktopHost`，preload 用 `createDesktopTransport` 安装 `window.__DSH_TRANSPORT__`，主进程用 `loopbackCarrierUrl` 为宿主路由生成回环 URL。Electron 主进程先准入已提交的受信主 frame 文档发出的请求，本包才会收到它们。

<a id="understand-the-implementation"></a>

## 理解实现

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 树侧插件：`VirtualWebServer` + `DesktopRuntime` 服务 |
| [`src/virtual-web-server.ts`](src/virtual-web-server.ts) | 替代 HTTP 载体服务的无套接字路由注册表 |
| [`src/ipc-protocol.ts`](src/ipc-protocol.ts) | 主进程、宿主子进程与 preload 之间的 JSON 线协议 |
| [`src/host-bridge.ts`](src/host-bridge.ts) | 宿主子进程分发：初始 boot 发布、fetch 往返与流泵送 |
| [`src/preload-core.ts`](src/preload-core.ts) | 基于注入的 invoke/on/send 原语的渲染侧传输 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；REAL-composition boot 覆盖载体） |

宿主桥安装消息 listener 后发布一次 boot 载荷；主进程收到该载荷之前不会创建加载自定义协议的窗口。两个进程适配器都会校验每条载体消息，并在字段无效时终止所在进程，而不是让 boot、fetch 或 stream 工作持续等待。fetch 与 stream 取消会穿过两段 IPC，桥销毁会中止并等待所有活动操作，再让 profile 销毁完成。插件 combo URL 通过 fetch 协议保留完整 pathname 与 query string，并交给虚拟服务器注册的 `/plugins` handler；自定义协议上的 `/api` 请求（包括 Session 导出下载）在 Electron 主进程授权文档后使用共享 API Fetch handler。自定义协议响应体在主进程每次 pull 时推进一个二进制分块，因此进程通道及其两端都不会实体化完整 Session 归档。虚拟 `webServer` 的 `host` getter 返回宿主侧 URL 使用的回环权威，使依赖 bind 的消费者选择其回环分支；`port` 抛错，因为桌面组合不监听任何端口。

<a id="model-experience"></a>

## 模型体验

无：IPC 载体只在渲染侧与已启动组合之间搭桥，不注册任何模型可见内容。

#### KV Cache 效应

无；本包既不组装也不发送 provider 请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 流帧经主进程中继（渲染↔主↔宿主子进程）而非直连 `MessageChannelMain` 端口；在延迟证据要求端口之前保持消息式中继。
- 可应答帧的通知转发属里程碑 3；树侧尚未暴露转发通道。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本包刻意不导入任何 Electron 模块：Electron 应用（`apps/desktop`）以自己的原语装配载体半边，这正是内存载体测试无需进程的原因。`preload-core.ts` 声明自己的 `DesktopTransportHooks` 接口而非导入 client 面的 `ClientTransportHooks`——host 面包无法触及 `/client` 子路径，且载体测试在真实分发路径上以行为方式钉住形状。设计记录见[桌面载体决策](../../../.agents/notes/implemented/architecture/2026-08-27-desktop-electron-surface.zh.md)。

</details>
