# Agents / Session / Board 导航 review

Review: approved — 用户确认当前 Board 中心混入 Session 事实，需要把 Agents、Session、Board 拆成三个工作面，并把切换放到底部中央；未分屏时不再发生右侧切左侧的方向错觉。

约束：Board 只承载 Task；Agents 只承载 Agent/Executor 聚合；Session 只承载具体 Session。三者共享选择、焦点和恢复事实，但不能复制生命周期或在未分屏时制造空右侧。

非目标：不改 Core/ctxmux Runtime，不新增第二套 Session/Terminal，不重命名已有持久 Session ID。

## 右上角重复入口修复

Review: approved — 用户再次指出安装后右上角仍有切换按钮；沿用原已确认的唯一底部导航约束。
WorkspaceWorkbench 的 root leaf 标签栏与 split chromeline 仍调用 SurfaceSwitch。此前只检查 App 的调用和独立组件测试，遗漏了两个产品调用点。追加 T-002 仅删除这两个调用及空容器，保留底部入口和 Session 布局。回归测试应遍历 renderer 的实际 JSX 调用，断言唯一调用位于 App 的底部容器，且扫描非空；分别还原两处调用必须变红。
