---
description: "dsh 桌面面：与 Web GUI 相同的 harness、roster 与 preset，装进一个带原生集成的 Electron 应用，由 `dsh desktop` 启动。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-desktop-app

[English](README.md) | 中文

<a id="summary"></a>

## 概述

dsh 桌面面 profile 组合包：叠在 `dsh-base` 上的 `cordis.patch.yml` 镜像 Web bundle 的行集并去掉 HTTP 载体族（`webserver`、`web-runtime`、`web-startup`、`client-hmr`），由 `desktop-electron` 行提供保留行所注入的虚拟 `webServer`，IPC 载体取代所有监听套接字。`dsh desktop`（`--profile desktop` 的别名）启动它。

## 目录

- [概述](#summary)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="model-experience"></a>
## 模型体验

间接——经所组合的行：patch 层重组与 Web bundle 相同的 roster，每一行各自持有其模型可见行为。

#### KV Cache 效应

无；本包既不组装也不发送 provider 请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 桌面壳冻结用户 patch 热重载（启动时 `patchReload: 'frozen'`）：Electron 的 Node 无法挂载 vendored 配置 HMR 服务，`cordis.patch.yml` 的编辑在重启后生效。

### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本 patch 镜像 `dsh-web-app` 的行集并去掉 HTTP 载体族；`desktop-electron` 行必须先于每个注入 `webServer` 的行挂载。组合的零端口保证即行缺失本身：没有任何会绑定套接字的包参与组合，REAL boot 测试断言虚拟 `webServer` 的语义（`host` 是合成的回环权威；`port` 抛错）。设计记录见[桌面端 note](../../../.agents/notes/proposed/architecture/2026-08-27-desktop-electron-surface.zh.md)。

</details>
