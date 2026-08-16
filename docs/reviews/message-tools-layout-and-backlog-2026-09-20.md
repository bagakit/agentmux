# Message Tools 三态与需求欠账复核

Review: approved。依据：用户确认三档、直观图标、入口保持左侧；用户随后明确选择“一起补齐已确认的缺口”，本轮同时落实身份、窄分屏与组件内操作失败反馈。身份沿用 f-2688fn733/T-003，不另建重复任务。

## 已证根因

- expanded 只把 max-height 从 132px 提到 40vh；空/短内容仍取同一 min-height，故第三种形态并未发生。
- 工具切换藏在 AgentComposerTools 内，祖先靠 :has 反推布局；current/restored 是同一个视觉态的两份状态名。
- mode 按钮 order:1 推到工具末尾；collapsed 的整排 toolbar 又位于输入右侧。旧需求的“重新安排位置”不能覆盖本次明确的“保持左边”。
- 现有测试把“修改最大高度变量”当作“大输入框已交付”，未证明实际盒子变高。

## 修复边界与验收

沿用唯一工具切换状态，删去重复状态别名；Composer 样式拥有输入几何与左右布局，工具不复制草稿。复用既有 SemanticIcon 和 CSS，不引入第二份草稿或 Provider 状态。大输入框必须有实际高度，退出后仍能编辑原草稿。三档都以真实浏览器验证空/短/长内容、左侧位置与窄分屏；关键生产变异必须变红，引用链排除定义文件。

## 复核前已确认的缺口

- f-2688fn733 / T-003：当前 Agent 头像及 Session/Tab 名仍 todo；Composer 目前只显示可隐藏的 regionName。
- 窄分屏：现有 toolbar 使用 flex-wrap:wrap，与“先丢文字、后丢控件，不折行”合同相冲突。
- 操作失败：Skill discovery 有局部错误，Capture 仍转 reportError；文件、贴图与命令失败需沿真实宿主核对。
- 本地 prompt 库、快捷语法、语义 token：已有实现，不能因为 Tracker/旧文档状态推断缺失，继续逐条核对。

## 本轮闭环

| 确认项 | 交付行为 | 生产入口与回归 |
| --- | --- | --- |
| 三态第三档无变化 | 唯一三态循环，空草稿也立即增高；展开工具、放大、收回分别用动作图标，始终在左边 | AgentSessionComposer → AgentComposer/AgentComposerTools；message-tools-three-state |
| 头像和名字 | 真实 Provider 头像与 Session 名；复用 agentDisplayName 的用户命名/首条 prompt 派生，Tab 名作上下文或后备；一行态保留身份，极窄时文字收进提示 | SessionPane → AgentSessionComposer → AgentAvatar；composer-identity / region-name-watermark |
| 窄分屏 | 根据组件宽度隐藏标签，工具不折行；占位文字裁在自己的输入列，不侵入按钮 | composer.css；真实浏览器 320/420/900px |
| 局部失败与自收敛 | 文件、贴图、截图、Skills、命令操作由宿主的同一个 runAction 执行；失败保留草稿并显示重试，原按钮成功也清除旧错误；队列 admission 拒绝回到当前 Composer | ComposerFeedback → 两个实际宿主；composer-local-feedback |
| Launcher 多文件与异步完成 | 一次选择的文件完整追加；选择期间的新草稿与同批完成的截图/文件都保留 | NewTabSurface；真实 picker/capture Promise 回归 |
| Provider 切换 | 技能菜单按上下文挂载；反馈按每次上下文切换的代际归属，A→B→A 不复活旧 Retry，旧请求不能覆盖新结果或新错误 | NewTabSurface / useComposerFeedback；晚到成功、晚到失败、ABA 回归 |
| Launcher 空转三态 | 共用工具能力，但启动表单不呈现没有几何宿主的切换键，工具直接可用 | NewTabSurface；composer-local-feedback |

已有能力未重建：本地 prompt 库、Provider command 与自定义 prompt 合并、`@ / $` 快捷语法、语义引用 token、历史/重复提交守卫、队列按 Run 归属与投递恢复。对应 composer-shortcut-library / message-tools-syntax / composer-semantic-reference / composer-history / composer-resubmit-guard / agent-steer-queue 系列回归均通过。本报告只关闭本轮确认的 Message Tools 缺口，不代替其他 Feature 的完成状态。

## 验证与架构判断

- 34 个相关测试文件、312 条回归通过；随后新增 A→B→A 两条回归，局部反馈 17 条全部通过。Desktop typecheck 通过。变异与浏览器读数见 `evidence/message-tools-2026-09-20.json`。
- 浏览器里空输入一行/常态/大输入框实际高度为 24/26/240px；320px 下仍保留 137px 输入列。420px 下切换键三态 x 均为 33px，900px 下均为 41px。长文本在高度预算内滚动，切换保留原文本和 token，工具/主动作无重叠。
- Gallery 外层原本随整页滚动导致固定高度根裁切；验证时仅把 Gallery 宿主设为视口内滚动，未覆盖 Composer 样式。实际产品组件的高度与响应式规则用于全部读数。
- 所有新增能力均有定义文件外的生产调用者：SessionPane → AgentSessionComposer → AgentComposer；两个宿主 → AgentComposerTools / ComposerFeedback；头像与名称复用 AgentAvatar / agentDisplayName。
- 草稿、队列、Provider 身份各保留原 owner。没有新增 Store 错误账本、Runtime 状态机或兼容层；局部反馈仅持有当前操作错误与作用域代际，保护确有回归证据的异步边界。两个宿主共用相同反馈与工具执行接口。
- Review 找到并补测了三处初稿遗漏：正向重试成功没有清旧错、Provider 旧请求/Retry 越界、同批工具结果覆写草稿。测试从用户操作驱动真实宿主，避免只给纯函数加无产品调用者的白绿覆盖。
