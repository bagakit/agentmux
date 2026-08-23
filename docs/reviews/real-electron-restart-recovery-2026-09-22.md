# 真实 Electron 重启恢复闭环 review

Review: approved — 现有 attention/result successor 已恢复当前 Board 合同，但原 Feature 的重启探针只比较 executable、packaged 和手填 generation，不能证明真实 Electron 进程退出后布局、焦点、草稿或 Session 身份恢复。本 Feature 只补这条证据和它缺失的最小运行接线，不重做 ctxmux 的 Run/PTY owner。

## 必须成立

- 隔离启动真实 Electron 主进程和 Renderer，至少记录两次不同 PID；两次使用同一个隔离 userData/runtime 根目录。
- 启动前写入一个可识别的 Tab/Region、焦点和 composer draft，并关联一个可验证的 Session/Run/Provider-native handle；退出后第二个进程读取同一份 durable 状态并报告身份匹配、布局仍在、焦点和草稿仍在。
- Runtime snapshot 暂时为空、Provider 探测失败或恢复握手超时只产生服务窗并保留原布局；只有明确 retired/unknown 才移除投影。探针不触碰用户已有 Run，只清理自己的临时目录。
- 现有 `desktop-agent-continuity`、store/workbench persistence 和 provider identity 测试继续作为局部 oracle，但不能替代真实 Electron 进程证据。

## 非目标

- 不新增第二套 Session/Run/PTY、布局或持久化实现。
- 不把 Electron 探针的测试 fixture 当成生产恢复逻辑，不为具体站点、Provider 或按钮文案写分支。
- 不在本 Feature 中打包、安装或修改用户机器上的已安装应用。

## 验收证据

探针输出必须包含真实 PID、userData/runtime 根目录、Tab/Region/focus/draft/Session 身份的前后摘要、恢复动作和清理结果；任何字段缺失或两次 PID 相同都失败。代码变异后真实探针或针对其序列化/恢复边界的行为测试必须变红，并且探针入口有 Desktop 生产调用者或明确的发布前脚本调用关系。
