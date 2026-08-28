# Agent Note: 桌面原生集成与分发

Status: proposed

[English](2026-08-27-desktop-native-integration-and-distribution.md) | 中文

## 问题

已实现的 [Electron 壳与零端口载体](../../implemented/architecture/2026-08-27-desktop-electron-surface.zh.md)在桌面窗口中运行共享 Harness 产品，但尚未提供浏览器标签页无法拥有的集成：原生目录对话框、钥匙串凭据、系统通知应答、应用深链、签名工件、崩溃恢复或更新通道。

这些功能跨越特权操作系统和发布边界。它们必须扩展既有 capability 与应答路径，而不是增加 Electron 专用业务 API；分发必须保留当前规则，即宿主与 renderer 作为一个没有协议协商的单元发布。

## 提案

### 原生 capability provider

- 增加 `@deepseek-ai/dsh-host-directory-picker-electron`，作为既有 `directoryPicker` capability 的 provider。它调用 `dialog.showOpenDialog`；`host.pickDirectory` 及其客户端 consumer 在[目录选择器决策](../../implemented/architecture/2026-07-28-directory-picker-capability-seam.zh.md)下保持不变。
- 在环境 provider 旁增加基于 `safeStorage` 的 credentials provider。Credentials Service Definition 与 consumer 保持不变；provider 拥有 Electron 可用性与加密失败处理。
- 在 Electron 主进程中注册应用深链，在分发前校验完整输入，并把接受的操作路由到既有应用 command 或 API，而不是把 renderer 导航作为权威。
- 把待处理 approval 与 question 投影到系统通知。通知应答使用与 renderer 相同的 `/api/respond` 操作和待处理 rpcId 表，因此既有 first-answer-wins 与 `not-pending` 行为仍是唯一裁判。

每个 provider 都是位于既有 capability 或 command 路径后的独立包，且只加入 desktop bundle。必要的桌面专属呈现使用增量客户端 slot；共享客户端包保持不变。

### 分发加固

`apps/desktop` 拥有 electron-builder 配置、平台签名与 notarization、可分发工件验证、崩溃恢复策略和更新客户端。发布自动化发布完整应用工件。一次更新会一同替换宿主代码、renderer 资源、profile bundle 与 Electron 壳；线协议没有版本时，仍不支持只更新 renderer。

应用通过桌面端拥有的 UI 与诊断报告更新和恢复失败，且不会绕过宿主子进程的有序关机。打包验证针对已安装工件运行，而不是针对 workspace 符号链接。

### 里程碑

- M3 交付原生目录选择器、钥匙串凭据、经过校验的深链与通知应答。
- M4 交付签名可分发工件、崩溃恢复策略与完整应用更新通道。

## 考虑过的替代方案

**把原生行为直接放进共享客户端包。** 它会围绕 Electron 全局量 fork 浏览器行为，并绕过已经隔离宿主与呈现差异的 capability provider 和 slot。

**让通知应答拥有自己的待处理状态权威。** 两个裁判可能接受冲突应答。复用 `/api/respond` 可让既有待处理 rpcId 表保持权威。

**独立更新 renderer 资源。** 它会创建没有版本协商、独立发布的线协议对端，并可能把旧宿主与新客户端 graph 配对。

**在分发前把壳移入独立仓库。** 它会让发布加固依赖尚不存在的稳定已发布包与线协议契约。只有壳成为纯外部 consumer 后，拆分才仍是后续选项。

## 验收标准

- 桌面目录选择与已存储凭据使用既有 capability 方法，测试通过真实桌面组合覆盖取消、provider 故障与销毁。
- 深链在到达 command 或宿主 API 前拒绝格式错误、不受支持与跨权威输入。
- 通知反映待处理 approval 与 question，应答或关闭通知保留既有 first-answer-wins 与终态 receipt 行为。
- 发布任务为受支持平台生成经过签名、可安装的工件，并从已安装应用验证启动、profile boot、原生 provider、有序关机与更新回滚。
- 更新替换完整应用，且无法独立安装 renderer 资源。

## 风险

`safeStorage`、通知、协议注册、签名与更新机制因操作系统和桌面 session 而异。每个 provider 与发布通道都需要原生平台证据；source mode 或 mock Electron 测试不足以声明平台支持。

通知应答可能在 renderer 操作、过期、重启或 session 销毁后到达。既有待处理 rpcId 操作必须裁决每个竞态，通知不得通过保留第二张待处理表来折叠终态 receipt。

中断的完整应用更新可能留下无法使用的安装。更新设计需要原子替换或 rollback，并且必须保留应用工件之外的用户数据。
