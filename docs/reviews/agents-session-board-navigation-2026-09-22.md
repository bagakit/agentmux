# Agents / Session / Board 导航 review

Review: approved — 用户确认当前 Board 中心混入 Session 事实，需要把 Agents、Session、Board 拆成三个工作面，并把切换放到底部中央；未分屏时不再发生右侧切左侧的方向错觉。

约束：Board 只承载 Task；Agents 只承载 Agent/Executor 聚合；Session 只承载具体 Session。三者共享选择、焦点和恢复事实，但不能复制生命周期或在未分屏时制造空右侧。

非目标：不改 Core/ctxmux Runtime，不新增第二套 Session/Terminal，不重命名已有持久 Session ID。
