# Focus 的 Saved Inputs 阅读面板

用户反馈 Focus 的 Saved Inputs 面板难看，要求全面优化。参考画面中，正文、原始附件路径、类型和 Host 线索挤在同一行；重复草稿缺少扫描层级，Continue writing 漂浮在行尾，逐行分割线与底部 Queue records、分页动作形成连续线框。空正文项也占据相同视觉重量，长列表缺少查找手段。

确认目标：把它整理成以输入正文为主的内容阅读面板。保留原草稿、队列、冷归档、图片引用、原操作与关联身份；默认只呈现有助于辨认内容的摘要、附件名称和准确类型，技术诊断按需展开。Continue writing 只沿原精确草稿位置打开，复制仍读取完整原文，均不自动发送或改变投递状态。

列表提供当前已读取范围内的搜索，明确部分覆盖与继续读取，不把本地过滤冒充完整归档查询。Drafts 与 Queued / archived 使用轻量分区和数量，行与行主要靠留白、字号和悬停层次区分，不为每项新增卡片或完整线框。窄窗口保留搜索、正文、继续编辑、复制、分页与关闭路径。

长期呈现合同归 [Focus 执行台的呈现](../design/presentation/focus-context.md#saved-inputs-阅读面板)；输入、草稿、队列和归档行为仍归[输入、草稿与提交意图](../design/behavior/conversation-input.md#输入草稿与提交意图)及[本地持久化合同](../design/behavior/persistence.md)。
