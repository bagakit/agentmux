# Messages 布局的真实 Renderer 切片

```sh
node apps/desktop/scripts/verify-agent-region-identity-menu.mjs --visual-only --mailbox-layout-owning
```

行为来源为[Message Tools 邮箱与完整阅读](../../../../../docs/design/behavior/conversation-input.md)，呈现来源为[Session 归属与 Message Tools 密度](../../../../../docs/design/presentation/conversation-input.md)。该切片沿原 `WorkspaceWorkbench → SessionPane → AgentSessionComposer → AgentComposer → SessionMailbox`，消费生产导航、共享记录 frame、A2A reader、User Messages 的 compact input journal、Notices、Collaboration 和 Progress。

受控接缝只在 `entry.tsx` 的既有 preview API：`listMessages` 按准确 Host／participant／direction／sequence 返回 240 字符 metadata，27 封来信通过原 25 条窗口和 Read earlier 取得；`readMessage` 按原 MID 返回单条完整 durable envelope，记录每次准确 reference 和 MID。列表不逐行获取全文。reference notification 的 pending／submitted／unconfirmed 与普通 delivery 的 delivered／failed 分别提供原 typed 事实，不从文案判断资格。A2A 不使用旧 `mailbox()` 的 timeline 合成作为原信来源。

真实操作覆盖完整六页名称与规则网格、原生键盘导航、原 MID 详情与 Info、Back 返回原行、全文 Copy、显式 Fill、journal 的 body／wire 边界和原 selected inline disclosure。只检查已有动作，不发送、不 ack、不启动 Progress。已呈现的 Progress 配置输入节点、未保存值与观察订阅，及原 Composer 草稿／编辑节点、队列和 xterm 实例／几何，都有保全断言。

采图策略保持有界：320／380／640px × 明暗的 Inbox 主面，380px 暗色其余五页及原信 Info／journal 详情，以及 320px 矮面；全部宽度仍实际切换六页并执行操作。图片清单、原始回执、编译输入与产物哈希按本次 attempt 写入证据目录；采集成功不表示审美通过，须由独立 Agent 打开完整图片评审。私有编译恢复旧 flex 导航、撤掉 Desktop 的 compact 消费，分别须让原几何／消费断言失败；产品源文件不被变异写入。

这是源码 Chromium Renderer 与受控 API 证据，不能代签真实 Host、安装包、Native CLI、上游消息读取或持久 Run 恢复。这个 preview entry 每进程都会重新初始化并 seed Workbench，不能用同 userData 重开冒充原工作面恢复。真实双进程工作面恢复另复用 `verify-workbench-persistence-restart.mjs` 的私有产品 oracle，并绑定其当前编译身份；该 oracle 的执行与通过须查本轮回执。
