---
description: "桌面壳的宿主插件：IPC 载体之上的虚拟 webServer（零监听套接字）、desktopRuntime 通道，以及宿主子进程与应用共享的无 Electron 载体协议。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-desktop-electron

[English](README.md) | 中文

<a id="summary"></a>

## 概述

桌面壳的宿主侧包：树侧插件提供虚拟 `webServer` 服务（无监听套接字的路由注册表与 index 注入收集）和 `desktopRuntime` 载体通道（connection 共享 fetch handler、Gateway wire stream、boot 载荷与插件 bundle 字节），以及不依赖 Electron 的载体半边——IPC 线协议、宿主子进程桥、preload 传输核心——由 Electron 应用装配。

## 目录

- [概述](#summary)
- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>

## 使用本包

以 `desktop` profile（`@deepseek-ai/dsh-desktop-app`）的 `desktop-electron` 行组合本插件；它必须先于注入 `webServer` 的行（`modules`、`connection`、API Gateway）挂载。Electron 应用（`apps/desktop`）导入载体半边：宿主子进程在进程通道上用 `serveDesktopHost`，preload 用 `createDesktopTransport` 安装 `window.__DSH_TRANSPORT__`，主进程在转发渲染侧 fetch 处用 `loopbackCarrierUrl` 合成回环 Host。

<a id="understand-the-implementation"></a>

## 理解实现

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 树侧插件：`VirtualWebServer` + `DesktopRuntime` 服务 |
| [`src/virtual-web-server.ts`](src/virtual-web-server.ts) | 替代 HTTP 载体服务的无套接字路由注册表 |
| [`src/ipc-protocol.ts`](src/ipc-protocol.ts) | 主进程、宿主子进程与 preload 之间的 JSON 线协议 |
| [`src/host-bridge.ts`](src/host-bridge.ts) | 宿主子进程分发：fetch 往返、流泵送、boot 与 bundle 应答 |
| [`src/preload-core.ts`](src/preload-core.ts) | 基于注入的 invoke/on/send 原语的渲染侧传输 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；REAL-composition boot 覆盖载体） |

虚拟 `webServer` 的 `host` getter 返回载体合成的回环权威——与桥铸造进每个宿主侧请求的值相同——使依赖 bind 的消费者选择其回环分支；`port` 抛错，因为桌面组合不监听任何端口。

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

本包刻意不导入任何 Electron 模块：Electron 应用（`apps/desktop`）以自己的原语装配载体半边，这正是内存载体测试无需进程的原因。`preload-core.ts` 声明自己的 `DesktopTransportHooks` 接口而非导入 client 面的 `ClientTransportHooks`——host 面包无法触及 `/client` 子路径，且载体测试在真实分发路径上以行为方式钉住形状。设计记录见[桌面端 note](../../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.zh.md)。

</details>
