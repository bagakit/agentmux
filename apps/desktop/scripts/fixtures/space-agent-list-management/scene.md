# Space Agent list management

来源：[行为 SSOT](../../../../../docs/design/behavior/spaces-and-layout.md)、[呈现 SSOT](../../../../../docs/design/presentation/spaces-and-layout.md)。

实际入口：`SurfaceToolDock → ConnectedWorkspaceAgentsTool → WorkspaceAgentsTool → WorkspaceAgentRow → FocusContextRow`。加载完整产品样式，保留原 Workbench；仅隔离非本任务的 Native PTY／Monaco 绘制和原生服务 I/O。Agent 与 Stop 回执使用明确的私有 typed fixture，不连接或操作用户 Run。

正常与窄侧栏检查状态归属、卡片边界、摘要阅读；通过真实 CDP 指针拖拽和键盘移动重排，最终保留非默认顺序；打开共享卡片菜单；切换状态筛选，进入多选并选择可见项，复制标题与原 Agent 链接，检查批量关闭确认及单项失败。原工作面含两个 Region、分割比例、活动 Region 和未发送草稿；退出真实 Electron 后在同 profile 再启动，通过原 Store 初始化恢复同一偏好与工作面，不重新 seed。截图为完整窗口，截图成功不代表审美通过，须由独立 Agent 实际逐张打开评审。

默认验证命令另运行公共顺序测试：编译的真实 CLI 经公开 RPC 调用原 Store owner，覆盖发现、读写、保存、冲突与未知回执。JSON report 必须确认两个消费测试文件实际执行、用例非空且全部通过。此公共调用链证据与上面的私有 Renderer presentation/Stop I/O 边界分别记录。

其中一张卡片使用与原 `control.agentSessionId` 不同的 presentation id；真实多选、复制、关闭及重启顺序检查都核对原身份，不能把显示定位别名当作执行对象。
