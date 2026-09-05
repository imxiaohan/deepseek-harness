# Agent Note: 转发事件瀑布上的系统通知应答

Status: implemented

[English](2026-09-02-desktop-notification-answers.md) | 中文

## 问题

待答审批或提问在应用窗口内等待，在别处工作的操作者可能让 agent 无限期阻塞而不自知。桌面壳拥有浏览器标签页触达不到的 OS 通知面——但来自通知的答案绝不能成为 pending 状态的第二个裁判：接缝的瀑布已经裁决每个竞态，壳也不得保留平行的 pending 表。

## 决策

以又一个客户端世代加入 Gateway 的转发事件瀑布。

- 载体就绪后，main 经既有的 `open-stream` 载体请求打开 `$events` 逻辑流（端点、载荷与结果路由是 gateway 包导出的线上词表——该协议的唯一归宿）。ready 帧命名本壳的客户端 id；流帧路由到 main 自有的流 id，而非 renderer 转发集。
- `approval/request` 的 `waterfall` 帧呈现 OS 通知，其按钮以 `allowed-once`/`rejected` 应答——作为一条 `client-request` 信封投递到 gateway 的 `$events/result` RPC，与 renderer 的应答路径完全一致。Gateway 的语义仍是唯一裁判：首答即赢、迟到结果幂等无操作，本壳除通知本身外不保留第二张 pending 表。
- `user-questions/request` 的 `waterfall` 帧呈现仅聚焦的通知（提问以结构化草稿作答，通知按钮承载不了）；点击正文把窗口带到前台而不作答。划掉任何通知都不作答——瀑布继续等待其余投递。
- `cancel` 帧——renderer 已答、agent 中止、会话结束——折叠通知。按钮点击先本地移除通知再投递；其后到达的 cancel 对它是无操作。
- 不支持通知的会话退化为无通知（`Notification.isSupported()` 把守构造器）；窗口继续应答一切。

## 考虑过的替代方案

- **专用的通知应答 API。** 拒绝：第二个端点意味着第二个裁判；`$events/result` 已为每个客户端世代承载 first-answer-wins 与幂等迟到结果。
- **从通知内联应答提问。** 拒绝：提问的答案是结构化草稿；通知按钮无法诚实地承载它们，因此通知只浮现并聚焦。
- **把 pending 状态投递给 renderer 呈现。** 拒绝：renderer 已持有窗口内卡片；通知是同一次瀑布投递的第二种呈现，不是 pending 状态的新主人。

## 后果

- e2e 端到端驱动一次真实审批：组合 fixture 创建 agent、打开 turn、发起一次真实审批；被桩掉的通知面捕获 main 呈现的内容，测试激活允许按钮，接缝记录 `allowed-once`——整个环路穿越真实载体、Gateway 瀑布与结果 RPC。
- hub 对注入的呈现与投递面目是纯的：其状态机（呈现、应答、折叠、划掉、畸形帧、投递失败）无头覆盖全部分支；`apps/desktop/src/pending-notifications.ts` 不持有任何 Electron 导入。
- macOS 仅在打包构建中显示通知按钮；开发构建仍会通知，点击正文聚焦窗口（作为已知限制记录于桌面 README）。
