# 已停止 Session View 的关闭出口

执行 `node apps/desktop/scripts/verify-stopped-session-view-close.mjs`。设计约束见 interaction SSOT 的《Session、Run与View》，密度文档只引用该条；此页只描述验证步骤。

使用真实 App/Store/样式、原 Tab X/确认/告示与 Chromium durable 状态。API 的两个同工作区 Session、exited/running、Stop pending 为本夹具的 synthetic Host 事实。无真实 Native、Agent CLI、用户 App、用户 Session、输入或信号。

1. 打开已 typed exited 的 target Tab，以真实 X 关闭，仅关闭投影：Stop 0；保原 Session/Run、sibling、草稿、未知输入与原保存告示。
2. 正常和窄双分屏（每面约 640/320 CSS px，窗口 1281/641）：真实 X→原 Stop & Close；5s 后保原 View、释放 UI lease、诚实 unknown。窄 Tabstrip 先用原 Scroll tabs right 暴露 X，真实命中才能点击。
3. 采原确认面 Keep/Cancel/Stop 三动作；Cancel 后采实际 TransientErrorNotice；再次 X→Keep Session & Close，Stop 仍为原一次，未知输入不发送。
4. 三个不同 PID 普通 Electron 打开同一私有 Chromium userData（两次重启），后两次不 setState。完整 Tab/Region/group/focus 布局与草稿逐字相等；真实 TerminalView attach 同 retained Session/Run。原 canonical hydrate 把 sending 转 deferred/AGENT_EXECUTION_NOT_REQUESTED，operation/Run/text/condition 精确不变且 submit 0。

每次输出独占 attempt 的 receipt、PNG 和 process log。captureOnly 不等于审美通过，独立 Agent 必须逐张 view_image 正常/窄完整图。输入/loaded/compiled 非空 SHA 绑定；cleanup 只本 private Root，无消费者后普通删除，不 force。旧 setup、过期归档误收集、采错通知面/错工作区等原失败保留，不算产品 mutation RED。

本轮不签实际用户关闭根因、Native I/O、Session retirement、安装、物理键盘或终端连续阅读/P0。
