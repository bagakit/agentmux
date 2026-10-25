# Topic 晋升为 Mote：真实 Renderer 场景

来源：[伙伴从哪里来](../../../../../docs/design/behavior/companions-from-work.md)、[Mote 晋升呈现](../../../../../docs/design/presentation/motes-and-coordination.md)。

运行 `node apps/desktop/scripts/fixtures/topic-promotion/capture.mjs`。只创建私有 Electron Renderer 和临时 profile，不连接用户 App、不晋升用户 Topic、不启动或停止 Agent。

使用生产 App、WorkspaceTopicsPanel、Topic 菜单、TopicPromotionDialog、Store 和样式。内容与空间 API 是固定 fixture；这份证据证明真实界面消费与操作，不代替 Host/Core/CLI/进程恢复证明。

- 原分类含有三个 Topic，保有文件工作面和未发送草稿。
- 原菜单点击晋升：只出现原名字、保留 Agent/对话/资料的说明与简短确认，无团队或人格配置表单。
- 亮暗主题、窄窗口显示相同确认；取消不调用晋升写入。
- 模拟明确部分完成，继续操作复用原 operationId，原工作、布局、草稿保持。
- 完成关闭确认，在原分类保留同对象入口，显示克制的本地完成提示。
- 减少动态效果时窄窗口仍完整可用。

`--mutant=consumer` 在私有编译里精准移除生产 WorkspaceTopicsPanel 的菜单回调。仍真实打开原菜单，直接断言晋升动作存在；缺少消费使该断言变红，不以超时或编译失败冒充证明。源码不写入该变异。

每次保存 source/compiled 摘要、原操作断言、全屏 PNG 与 receipt。`captureOnly: true` 和 `aestheticReview: not-performed` 保留，独立 Agent 必须实际逐张打开图片并给出可交付结论。

## 局部动效与原组反馈

`capture.mjs --motion` 只运行本轮受影响路径，证据另存 `.tmp/topic-promotion-motion/`，不覆盖原首版回执。写入由 fixture 的 response barrier 暂留，生产代码没有人为完成延迟。

- 初始图像淡入结束后，在真实时间中采集亮暗各三帧；同时读取实际粒子和轮廓的几何、透明度，确认持续等待仍有可感知变化。
- 写入等待中关闭界面并通过原分类入口切到另一组。原操作完成不改变后来选择，不进入全局通知。回原组后，提示须紧邻同一 topicId 条目，scope 同原 categorySpaceId。
- 减少动态时在窄窗口等待，效果与按钮保持静态同义；完成不等待动画定时器。
- 无延迟的完成回执，在正常渲染后直接显示原条目旁提示，不为播放过程延迟。投影刷新暂留时，真实完成仍须立即停止写入动效并显示原组提示。

`capture.mjs --motion --mutant=motion` 只在私有编译中关闭生产等待能量层的动画。相同的初始过渡后时间取样必须在“实际几何或透明度变化”断言失败，不能用动画声明存在、超时或编译失败替代。基准时间序列由独立 Agent 逐张看图评审。
