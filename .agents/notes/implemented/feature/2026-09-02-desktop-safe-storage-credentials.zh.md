# Agent Note: safeStorage 凭据与原生操作信封

Status: implemented

[English](2026-09-02-desktop-safe-storage-credentials.md) | 中文

## 问题

桌面壳此前组合文件背衬的凭据 provider，存储的密钥躺在明文 YAML 文档里，而操作系统提供只有 Electron 主进程能触达的钥匙串——`safeStorage` 不存在于纯 Node 的宿主子进程。目录选择器已经以一对专用消息开启了第一个 host→main 往返；本项工作带来第二个宿主发起的表面，也正是接缝 note 预期的提取共享信封的时机。

## 决策

提取一个原生操作信封，并把凭据存储建在它之后。

- 专用的 `pick-directory`/`pick-directory-res` 消息对升级为 `native-request`/`native-ok`/`native-error`：闭合的 `DesktopNativeOp` 词表（目录选择器加十个凭据操作）、载体解析中的逐操作参数与值校验（映射联合让 `args` 随 `op` 为 main 的分发收窄）、`native-error` 承载操作自身的业务失败而结构非法仍然致命。`DesktopRuntime.nativeRequest` 是类型化通道；目录选择 provider 迁移其上，行为不变。
- 该通道懒绑定到宿主子进程的进程 IPC 通道，以 main 在 spawn 环境里设置的 `DSH_DESKTOP_HOST_CHILD` 标记为门——显式优于隐式，因为 vitest fork 同样拥有 `process.send`。懒绑定正是让 boot 期消费者成为可能的关键：connection 行在组合 boot 期间初始化浏览器会话秘密，早于任何 boot 后接线。宿主入口的分发器仍是非法消息致命性的唯一裁判；通道的 listener 只消费载体解析接纳的消息。
- Electron 主进程拥有存储：`userData` 下唯一一份 `safeStorage` 加密 JSON 文档（`refs` 按名字存密文，`records` 存密文并把 kind 标签留在明文，使存在性事实无需解密），以 `0600` 原子写入，超出属主权限即拒绝，损坏只大声失败。唯一写者使文件锁不再必要——一条进程内操作链串行化写入——`modifyRecord` 的互斥实现为按 key 的租约，在本地 provider 锁等待的量级上自过期，崩溃的变更不会卡死一个 key。
- `@deepseek-ai/dsh-credentials-electron` 是接缝消费者：精确镜像本地 provider 的环境分层（继承环境只读且优先、`.env` 在存储之下回退、同样的遮蔽拒绝），并转发每个受管存储操作。桌面 bundle 禁用 base 的 `credentials` 行并插入此行。
- `BrowserAuth` 在其记录无法被服务时降级而非让 activation 失败：钥匙串不可用或记录不可读时，本启动以警告使用进程内签名秘密，因此无钥匙串的 Linux 会话可以启动，CI 无需 secret service 即可跑桌面通道。本地 provider 同样受益于该加固。

## 考虑过的替代方案

- **保留逐表面消息对。** 在第二个表面拒绝：十对凭据消息会撑爆闭合 union，而信封保留一条校验接缝与分发的逐操作收窄。
- **由宿主子进程存储密文，保留本地 provider 的文档机制。** 拒绝：需要把安全关键的 provider 重构出扩展接缝，且密文比较破坏变更检测（随机 IV）；把整个存储交给 main 是删掉锁而非搬移锁。
- **boot 后在宿主入口绑定原生通道。** 拒绝：connection 行的 boot 期秘密早于任何 boot 后接线穿越；懒绑定的进程通道是从第一个 tick 就存在的传输。
- **钥匙串不可用时让 activation 失败。** 拒绝：无 secret service 的桌面 Linux 会话会因一个 cookie 签名便利在 boot 时变砖；带警告的降级让失败被拥有且可观察。

## 后果

- 载体现在以单一信封承载双向；fetch/stream id 与原生 id 保持不相交的关联命名空间（`ntv-native:`）。
- 桌面 profile 的 REAL 组合测试拦截 `process.send` 并应答 boot 期的 lease/abort 对，在 main 使用的同一接口上顶替它；e2e 通道以恒等面目桩掉 `safeStorage`，经触发标记驱动 set/resolve/describe（镜像目录选择的纪律），因此 CI 从不需要 OS 钥匙串。
- 记录在密文旁以明文携带 kind 标签：枚举与描述保持免解密，wire 校验器（`isDesktopCredentialRecord`）是记录形状在线上与持久边界上的唯一家。
