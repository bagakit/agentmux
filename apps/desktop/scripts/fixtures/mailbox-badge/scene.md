# Messages 固定入口实景

本轮只验收 conversation-input owning SSOT 的 Messages 工具入口；不扩展投递、Automation 管理或对话 Reader。入口：`node apps/desktop/scripts/verify-mailbox-unread-badge.mjs --native`。

复用真实 WorkspaceWorkbench、SessionPane、AgentSessionComposer、SessionMailbox、Avatar、TerminalView、xterm 与生产 CSS。受控边界为100封 immutable journal 原信、原作用域分页与已读回执、Service Notices、Automation 只读采样和 synthetic ordered terminal bytes；它不是用户 App／Run 或真实 Agent 消费证据。先从真实按钮打开消息面，实际点击三次 Read earlier messages 取得四个合法25条页并产生原已读 receipts，再控制既有已读收据状态，使实际组件计算0／1／12／100未读。没有传入 unread prop、超页返回100条或从 timeline 冒充原信。

宽／窄、明／暗、短／长草稿，以及 Chromium coarse-pointer 下原 44px 命中区。检查固定按钮边界、数字字形、上缘留白和状态的位置。单独的状态在右上，双状态同时出现时 Automation 让出右上角。100 显示为 99+，可访问名称保留准确读数。以一封未读且 Automation 尚未确认的状态采图，再进入原 Automation 面核对已知状态。宽场景以真实 CDP 键盘 Enter 打开、Escape 关闭并保留原入口焦点，记录 Renderer 的 trusted keydown。

在一次私有 Renderer 构建中分别把原 CSS 规则里的单个 Automation 标记移回左侧、把 Notices 移到信封上。两次都须产生对应的几何断言失败，并在还原规则后恢复通过。回执记录样式表、变异前后的声明、生产 CSS 与编译身份。

原 Session／Run、Tab／layout、草稿、Composer和编辑器几何、头像、terminal rows/cursor/原末行与输入写入数量在各未读/提醒变化前后保持。私有 build/profile/所属进程在消费结束后清理，PNG、receipt与独立实际看图意见留同轮证据。

旧 `--mutations` 曾复制大段源码再跑整组历史 Mailbox tests，依赖已失效的宽泛 `$1` alias、旧 Inbox／Outbox 文案和 JSX anchors。它没有活跃包命令／长期文档／CI消费，本轮删除该失效入口；对应两份独立源码测试文件保留。它们的既有业务断言不由本轮native几何证明代签，旧功能漂移不伪装成本轮生产回归。
