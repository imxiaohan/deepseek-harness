# Agent Note: 桌面载体上的 Electron 原生目录选择器

Status: implemented

[English](2026-09-02-desktop-electron-directory-picker.md) | 中文

## 问题

桌面壳组合[目录选择接缝](../architecture/2026-07-28-directory-picker-capability-seam.zh.md)，该接缝的 note 预期过一个 `native` 交互的 Electron provider。子进程后端（`osascript`、Zenity、Win32 COM）从宿主子进程打开无父级的选择器，而桌面壳拥有一个选择器本应挂接的窗口——`dialog.showOpenDialog` 只存在于 Electron 主进程，宿主子进程（`ELECTRON_RUN_AS_NODE` 下的纯 Node）无法导入它。目录选择是第一个宿主发起的原生操作：在此之前每条载体请求都是 main→host 方向。

## 决策

把选择作为一次关联往返，沿既有 IPC 载体反向路由；接缝本身不动。

- 闭合载体 union 新增两条协议消息：host→main `pick-directory`（仅关联 id）与 main→host `pick-directory-res`（选定绝对路径或 `null`）。`parseDesktopIpcMessage` 与其他消息一样精确校验两者；畸形帧仍然终止接收进程。
- `dsh-host-desktop-electron` 中的 `createNativeHostClient(channel)` 持有宿主子进程一半：分配 `DesktopIpcId` 关联的等待者，resolve 匹配的响应，在调用方 abort 或发送失败时 reject。abort 丢弃等待者并放弃迟到结果——Electron 对话框没有程序化关闭，因此不会尝试关闭选择器。
- `DesktopRuntime` 增加接缝消费的通道：`pickDirectory(signal)` 在未绑定通道时大声失败；`attachNativeHost(channel)`（由 `apps/desktop/src/host.ts` 在服务载体时调用一次，随桥一起销毁）完成绑定。
- Electron 主进程应答 `pick-directory`：打开以壳窗口为父级的 `dialog.showOpenDialog`（`openDirectory`/`createDirectory`，locale 自有标题）；对话框失败进入既有 fatal 通道（`fatal.host.nativePick`），因为请求方是受信宿主子进程而非 renderer。
- `@deepseek-ai/dsh-host-directory-picker-electron` 是接缝消费者：注册稳定的 `native` 能力，其 `pick` 读取 `desktopRuntime.pickDirectory`。桌面 bundle 把它与无渲染原生流程占据者一起钉住，替换自适应选择器行——桌面操作者永远坐在屏幕前，electron-native 交互是无条件的，不运行任何探测。

客户端流程、workspace controller、Remote 方法与 browse 交互都不变；一行组合配对即可换掉后端，正如接塞决策所述。

## 考虑过的替代方案

- **从宿主子进程 spawn 子进程后端。** 拒绝：打开无父级选择器，复制窗口自有的对话框，并无视壳存在的意义——提供 Electron 能力。
- **经由 renderer 的 `ipcRenderer` 调用提供对话框。** 拒绝：能力位于宿主侧服务上；host→renderer→host 路由把选择耦合到文档准入生命周期（重载会取消打开中的选择器），并让 renderer 拥有一个它不该拥有的原生操作中介。
- **现在就做通用 `native-op` 信封。** 暂缓：每个原生表面一对消息使校验保持闭合且具体；第二个宿主发起表面（钥匙串凭据）可在其载荷形状明确后提取共享信封。

## 后果

- 载体现在双向：main→host 请求（fetch、stream）与 host→main 原生请求。两个方向各自持有独立的关联命名空间（`ntv-native:` id 永不与 fetch/stream id 冲突）。
- e2e 套件在启动后 stub 主进程的 `dialog.showOpenDialog` 来驱动该往返；触发标记武装宿主侧探测，使 stub 与探测不会竞速（启动期探测会在 stub 落地前打开真实选择器）。OS 选择器本身无法被 Playwright 自动化。
- 覆盖：协议解析器、原生 client（100% 分支）、provider 服务与 REAL 桌面组合（profile 启动且组合出的选择器报告 `native`）无头运行；Electron 通道（Xvfb/原生 CI）拥有平台证据。
