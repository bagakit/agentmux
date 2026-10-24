# A2A 原信主阅读采图

当前约束见[行为合同](../../../../../docs/design/behavior/conversation-mode.md)与[呈现合同](../../../../../docs/design/presentation/conversation-mode.md)。

场景挂载实际 `ActivityView`、`MobileConversationSurface` 和 `FocusMessagePreview`，编译本候选共享组件与产品 CSS。输入来自测试运行时的实际 Core public Reader：内置 Provider 读取受控 native 记录，精确关联 durable prompt admission 和 captured 通知，投影为同一通知事件及两项原贡献。私有 Renderer API 与 Hosted delivery 只提供已读事实和可控原信读取结果。

三个消费者各操作宽／窄、明／暗四个场景；每次直接进入通知，自动读取两位已核 Agent 的原信。窄暗场景先令第一位读取失败、第二位成功，保留草稿及焦点，再显式重读第一封。检查每封原信各有独立右侧卡片与真实作者，主列表没有额外系统消息卡。

窄暗场景分别复制两封原信，通过 Enter 展开「通知与来源」，复制独立通知协议，展开原生与提交记录。检查原始 JSON 留在同一证据入口，展开后没有再次渲染原信或增加读取。采图前后的输入、原信读取目标、Copy、批内故障隔离及 DOM 卡片数写入 `render.json`。

采图成功只证明上述真实 Renderer 操作。独立评审必须实际打开全部 PNG，判断主次、作者身份、右侧排列、文字可读性、留白、紧凑与控件清晰性；不能用几何检查或测试通过代替审美判断。本场景不证明已安装 App、活跃 CLI、真实模型、Session 重启或布局恢复。
