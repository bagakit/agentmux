# Result ready 输入连续

对应两份设计 SSOT 的《Result ready 在小 Region 中的可用性》与《Result ready 的紧凑层级》。

`node apps/desktop/scripts/verify-result-ready-input-continuity.mjs` 使用独立 userData 的 Electron 私有编译，真实 `WorkspaceWorkbench → SessionPane → TerminalView → xterm` 与产品 CSS 全部参与。只在公开 preview API 边界给定两个健康 Session、明确 basic-vt checkpoint、原 ordered output、完成事件、Git/result.txt 文件事实和 preview 目标。键入、右键 Paste、Review、Collapse、Escape、light dismiss、隐藏再恢复、Close 与目标跳转都走实际产品控件。Paste 的受控 API seam 返回固定文本，不读取或修改 OS 剪贴板。

正常 640px 与窄双分屏 320px 的原终端底部有正在编辑的 prompt，Message Tool 保留长草稿；先键入、自动完成、再键入，随后主动查看并收回。自动出现的 glyph 不改变原终端几何、rows/cols、resize 调用、焦点、Run、Region 或草稿。另采有真实服务窗的降级场景及无 Composer 的只读 Header 入口；这些不代签 Native CLI，也不将服务窗 CSS 隐藏成健康。完整候选图用于独立 Agent 主观评审。

私有 compile transform 将真实行为块改坏并记录原文与变异文：额外 flow 子项、自动 autofocus、实际键盘 write 回调切断、删除未完成态固定槽。另守主动收起真正关闭 native popover，以及关闭当前结果后下一轮仍可发现。每条必须在实际场景 Assertion RED；未变动生产源码的恢复编译再 GREEN。脚本另外证明非空生产挂载调用者。进程重启与真实健康 Run 的 durable 工作面回归复用已有 `verify-workbench-persistence-restart.mjs`，由交付者单独执行并保存回执。
