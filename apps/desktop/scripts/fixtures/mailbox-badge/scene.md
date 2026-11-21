# Messages 固定入口实景

本轮只验收 conversation-input owning SSOT 的 Messages 工具入口；不扩展投递、Automation 管理或对话 Reader。入口：`node apps/desktop/scripts/verify-mailbox-unread-badge.mjs --native`。

复用真实 WorkspaceWorkbench、SessionPane、AgentSessionComposer、SessionMailbox、Avatar、TerminalView、xterm 与生产 CSS。受控边界为100封 immutable journal 原信、原作用域分页与已读回执、Service Notices、Automation 只读采样和 synthetic ordered terminal bytes；它不是用户 App／Run 或真实 Agent 消费证据。先从真实按钮打开消息面，实际点击三次 Read earlier messages 取得四个合法25条页并产生原已读 receipts，再控制既有已读收据状态，使实际组件计算0／1／12／100未读。没有传入 unread prop、超页返回100条或从 timeline 冒充原信。

宽／窄、明／暗、短／长草稿，以及 Chromium coarse-pointer 下原44px命中区。每个状态检查固定按钮和mark边界、数字自然Range、信封／右上Notices／左上Automation各自位置与不相交。100的视觉字面量是99+，可访问标签保准确100；0时没有数字。Automation首次未确认会保留真实unknown图；实际进入原Automation面读取合法source后再检查已知状态。不靠外观推断控制事实。宽场景另以真实 CDP 键盘 Enter 打开、Escape 关闭并保留原入口焦点，记录 Renderer 的 trusted keydown。

一次私有 Renderer 构建，在同一实际页面的唯一导入 CSS rule 上将 Notices 的 inset-inline-end 从原值改成8px，必须因与信封重叠产生实际 AssertionError。还原同一 rule 的完整原 cssText 后必须恢复同一几何断言。记录stylesheet href、原／变声明、生产CSS SHA与实际编译身份；没有写共享生产源码，也没有另建CSS覆盖层。截图只采正常态，不把变异红图签为交付。

原 Session／Run、Tab／layout、草稿、Composer和编辑器几何、头像、terminal rows/cursor/原末行与输入写入数量在各未读/提醒变化前后保持。私有 build/profile/所属进程在消费结束后清理，PNG、receipt与独立实际看图意见留同轮证据。

旧 `--mutations` 曾复制大段源码再跑整组历史 Mailbox tests，依赖已失效的宽泛 `$1` alias、旧 Inbox／Outbox 文案和 JSX anchors。它没有活跃包命令／长期文档／CI消费，本轮删除该失效入口；对应两份独立源码测试文件保留。它们的既有业务断言不由本轮native几何证明代签，旧功能漂移不伪装成本轮生产回归。
