---
description: "桌面壳的 OS 钥匙串凭据 provider：受管存储落在 Electron 主进程的 safeStorage 之后，经桌面 IPC 载体读写，而环境与 .env 分层保持不变。"
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-electron

[English](README.md) | 中文

## 概述

桌面壳完整保留凭据接缝的环境半边——继承的进程环境只读且优先，项目与用户 `.env` 在受管存储之下回退——与[本地 provider](../credentials-local/README.zh.md) 一致；而受管可写来源移入 Electron 主进程：应用 `userData` 下唯一一份 `safeStorage` 加密文档，经桌面 IPC 载体的原生通道读写。`dsh-credentials-electron` 注册 `ctx.credentials`；接缝、其消费者与 Remote 表面不变。只有桌面组合挂载它，因为它读取的 `desktopRuntime` 通道仅存在于桌面宿主子进程。

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

只有桌面壳组合此 provider：它读取的 `desktopRuntime` 载体通道仅存在于桌面宿主子进程。任何其他组合都会在第一次操作时大声失败，而不是静默降级。

### 何时选择它

桌面表面组合此 provider，使存储的凭据落在操作系统钥匙串（macOS Keychain、Windows DPAPI、Linux libsecret/KWallet）之后，而非明文文档。工作站与远程 web 部署继续使用[本地 provider](../credentials-local/README.zh.md)。

### 操作者看到什么

经 Models 页面存储的密钥在下一次模型请求即从钥匙串解析；继承环境仍然优先，`.env` 文件仍在受管存储之下回退。会被环境遮蔽的写入与本地 provider 一样以可操作的错误拒绝。

### 可观察的失败

OS 钥匙串不可用时（无钥匙串的 Linux 会话），存储与读取以可操作的错误失败，而存在性事实（`describe`、`listRecords`）继续应答；浏览器会话秘密降级为本次启动有效的值，而不是让启动失败。密文与本机钥匙串不再匹配的文档会带着恢复提示大声失败，而不是读作空。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

### 设计概念

provider 是薄的接缝适配器：环境分层经启动环境快照本地解析，每个受管存储操作作为一条原生操作穿越载体——主进程拥有加密文档、以单进程串行化写入，并把 `modifyRecord` 的互斥实现为按 key 自过期的租约，崩溃的变更不会卡死一个 key。主进程是唯一写者，因此没有跨进程文件锁；文档以 `0600` 原子写入，组或其他权限位非零即拒绝。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `ElectronCredentialProvider` 服务：环境分层 + 逐操作原生往返 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当 provider 契约不够用时先读接缝，再读承载往返的载体。

- [凭据接缝](../credentials/README.zh.md) — reference/key 两个键空间、逐操作解析与 UI 安全的描述。
- [本地 provider](../credentials-local/README.zh.md) — 文件背衬的孪生实现，本 provider 镜像其环境分层。
- [desktop-electron 宿主插件](../../host/desktop-electron/README.zh.md) — 原生操作通道与闭合的操作词表。
- [凭据子系统参考](../../../docs/subsystems/credentials.zh.md) — 完整契约。

-----

<a id="model-experience"></a>
## 模型体验

无；作为凭据 provider，不注册任何模型可见内容。

#### KV Cache 影响

无；本包既不组装也不发送提供商请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定钥匙串存储的适用范围；它们是当前的包约束，不是任务清单。

- **仅限桌面壳** — provider 读取 `desktopRuntime` 通道，桌面 bundle 之外的组合会让第一次操作大声 reject，而不是降级。
- **无外部编辑热重载** — 主进程是唯一写者，因此与本地 provider 不同没有文档 watcher；编辑只能经接缝发生。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>

**运行时不变量：** 不发布配套 invariant。存储不变量（单一写者、租约过期、仅属主权限）在主进程存储中强制，并由 `apps/desktop` 中的测试覆盖。
