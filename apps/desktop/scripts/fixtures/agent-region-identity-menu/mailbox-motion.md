# 紧凑消息卡与邮箱的连续交接

对应呈现合同：[Message Tools 邮箱](../../../../../docs/design/presentation/conversation-input.md#message-tools-邮箱)。

```sh
node apps/desktop/scripts/verify-agent-region-identity-menu.mjs --visual-only --mailbox-motion-owning
```

真实消费链为 WorkspaceWorkbench → SessionPane → AgentSessionComposer → SessionMailbox / ComposerPendingDelivery → 原 HTML popover、CSS anchor 与 Element.animate。私有 Renderer 使用当前生产组件和样式，不实现另一套插值、开关或消息队列。640 暗色与320浅色分屏先输入长草稿，再实际点击原消息卡的详情按钮打开 Outbox、关闭、快速反向和减少动态。记录实际连续 RAF 的原面板几何、原生开关状态、裁切和动画时钟，断言非空中间帧、实际位置变化且文字没有整体缩放。

中间截图在当前原面板的原生动画 effect 上暂停，并把该 effect 的 currentTime 设为其真实 duration 的15%、50%、85%；图片说明真实浏览器插值的画面，连续性由未暂停的 RAF 记录证明。端点截图、暗/浅完整工作面和真实 elementFromPoint 命中交给独立 Agent 逐张实际看图。关闭事件立即收回原层的键盘和指针资格，退出绘制仍复用原 DOM；不复制交互层。

后续实际操作覆盖原生 IME hover、编辑器焦点/DOM、Terminal实例与rows/cursor、邻面草稿、Region尺寸变化、准确 Run 投影变化、原 Store 的 Tab 切换与真实树卸载。准确 Run 变更可以重新绑定 Terminal；同一 Run 的普通过渡必须保留原实例，不把两者混为一谈。关闭 Escape 由当前实际焦点 owner 决定：面板内关闭；编辑器内仍属于原编辑器/IME，不改写成通用关闭键。

两个方向的20%交接直接比较原动画的实际位置、裁切和透明度，关闭中的原面板立即退出交互，原卡片轻淡入。同一轮原 HTMLElement.hidePopover/showPopover 压力验证浏览器合并 toggle 事件时也能提交当前原阅读 owner；这是实际原生 DOM API 事件，不是私造 toggle。目标切换使用原 mailbox history API 的自然满高事实，准确 Run 变更前后面板高度必须一致，避免目标取消测试仅靠 ResizeObserver 意外通过。

对象边界另向原 React 子节点派发一条故意不可信的 beforetoggle，验证 React 向祖先传播时不能撤掉父邮箱的交互 owner。这个反例明确是伪造输入，不签真实原生操作；真实父开关、键盘和 IME 路径仍由上述实际操作分别证明。

边界：snapshot/preview API 和 Clipboard 接口是可控私有事实；所有点击、键盘和 IME 经该 Electron 窗口的原生输入。证据只签当前 Renderer 呈现，不签真实 CLI/Native 投递、取消等待、系统剪贴板、安装或用户 Session/Run。userData/sessionData 隔离，不控制用户进程。不扩展 T010 的正文/诊断验收范围。
