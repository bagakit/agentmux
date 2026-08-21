# 消息控件语义与视觉讨论

状态：用户已确认实施。Feature：f-27q8fjs45。

## 最终批准（优先于下文历史提议）

用户指定单一发送／实心方块打断按钮；批准图片对齐正文、真实三分类邮箱及未读优先／无未读有发件则 Outbox；指定独立可交互头像的 Provider 中心、可设置颜色叠加、左上自定义角标、右上状态、右下数量和图形轮廓描边。不再实施举手或文字打断方案。Agent 正常停止不冒充错误，原因未知如实表达。设置的精确作用范围待用户补充，不阻塞按钮、图片和消息链工作。

用户三张截图指出控件间距与举手含义不清、正文图片方框留白、停止后头像红叹号与错误混淆，并提出 Inbox / Outbox / System messages 三分法。

已观察：Composer 普通形态图片强制 48×48，长图 contain 后产生空白；Core runDisplayState 把 Runtime interrupted 映射为 error，而退出原因分类只覆盖 exited。Runtime interrupted 是 PTY 终局，不能等同于打断当前回复；截图具体状态来源尚未确认。当前 Inbox 实为系统通知，Outbox 只有待发送队列。

提议：统一图标列宽、内边距与光学尺寸；打断采用琥珀色短文字按钮及 hover。图片保持原始比例，按正文行高展示。邮箱区分真实 Agent 来信、用户发件及投递状态、系统告示；已读不代表 Agent 已处理。头像表示身份，小状态标记表示运行事实，未读点归信封。正常完成、主动中断和主动停止保持中性，待用户处理用琥珀，真实失败才红色，未知须明确表达。具体方案及发件历史保留范围待讨论。

### Integration review counterexamples

Same approved durable-mailbox outcome, not new messaging scope: explicit CLI send targets were dropping managed caller attribution; post-launch-only initial/resume prompts were recorded complete before delivery; mixed activity retention could evict unread Agent mail. Close each owning path before calling T-004 delivered. Core owns delivery/retention, read receipts remain UI presentation facts.

Additional T-004 closure counterexample: durable completion may remove the draining head before its IPC rejection arrives. A removed, confirmed head must not stall the next queued message. Verify deferred A completion → A rejection → B automatic delivery, no A resend.

T-004 persistence counterexample: plaintext content fingerprints duplicate up to 200 large incoming messages into localStorage and can exhaust layout/draft quota. Use deterministic bounded content digests, verify large-body receipts bounded/no plaintext plus change/unread and restart/read; clean scopes only on authoritative terminal removal.
