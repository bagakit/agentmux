# Agents 看板注意力动作回接 review

Review: approved。

当前 Agents 已按 Board 的工具栏、状态列、卡片和右侧工作区重做。这个替换保留了正确的产品模型，但旧的注意力闭环只在旧列表行上有测试入口：当前卡片选中后，typed request 的“在这里查看请求”需要从固定详情区进入，旧 selector 已全部失效；现有面板也没有在成功回答后按注意力排序推进下一项、处理失败保持原请求和焦点恢复的行为证据。

同一轮审计还发现结果审查的两个边界需要一起守住：未知 Workspace 时不能让 `openFileDiff` 回退到 active Workspace；嵌套仓库的 Git 相对路径必须经过既有 repo-relative 转换后再打开。旧 Feature 的归档证据来自 Agents 看板替换前的候选，不能覆盖这些当前树回归。

本 Feature 只回接 Agents 看板内的注意力动作，不重新引入旧列表、不复制 Session/Run/request 真相，也不改变 Board Demand 模型。请求身份继续由 Store/Core 的 Session projection 和 typed request 持有；组件只保存当前选中的 session/request 身份与局部提交状态。

验收要求：

- 选中 Needs you 卡片后，详情区能打开同一 Session 的 AttentionRequestPanel；没有 typed request 时只提供打开原 Session 的定位动作。
- 回答成功必须等待 Core/Store 的事实更新后，再按现有 attention ordering 进入下一项；失败、请求被替换或外部已处理时保留当前身份、焦点和可见原因。
- 键盘可从卡片进入详情、打开请求、回答、返回；Board 仍是观察与需求工作面，不获得额外 Session/Run 写入权限。
- 回归测试必须针对当前卡片 DOM，覆盖空集合、两个 Session 身份隔离、成功/失败/替换和生产挂载；变异必须让删除 Review here 挂载或错误推进条件的测试变红，生产调用者检查必须有非定义文件命中。
- 结果审查测试必须覆盖有/无变更、非 Git、读取失败、未知 Workspace 和嵌套仓库路径，不允许借 active Workspace 或静态旧 artifact 冒充归属证明。

本 review 不授权打包、安装或重启用户应用；只验证 renderer 行为和类型接线。
