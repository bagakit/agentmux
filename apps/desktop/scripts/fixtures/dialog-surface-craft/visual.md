# 确认与任务弹层的实际场景

依据交互 SSOT《Stop Agent Session 与同类弹窗的统一品质》和密度 SSOT《确认与任务弹层的统一品质》。

```sh
node apps/desktop/scripts/verify-dialog-surface-craft.mjs
```

每轮输出自己的 `.tmp/dialog-surface-craft/attempt-*/receipt.json`。实际编译生产 Workbench、Store、ConfirmationDialog 和 CSS，在私有 Electron 数据目录操作，不接触用户 App、Run 或权限。

1. 点击实际 Workbench 单 Session Tab 的 X，打开 Stop Agent Session；初始 Enter 取消，Keep 保留原 Session 和草稿，显式 Stop 进入原停止入口。延迟返回时验证 Escape、外部点击不会关闭 busy 弹窗，Working 标签不改变按钮宽高。
2. 同一生产确认组件呈现完整长路径及不可断开的对象标识，分别在 640px 暗色和 320×300px 亮色窗口查看；逐个滚动到 Cancel、Keep、Stop，检查内容完整、动作可达及 hover 几何稳定。窄窗截图记录滚动后的动作区，不代表首屏标题被裁掉。
3. 呈现实际图标选择器、QuickSwitcher、快捷键帮助和 GoalDetail 删除入口。Goal 的 Store 删除方法由观察 spy 替换，证明确认前和取消不调用、明确确认调用一次；不证明删除 API 的持久化或失败处理。
4. 私有编译分别改坏危险 autofocus、busy 关闭保护、实际长对象换行规则和 busy 按钮的尺寸保留；必须由对应场景报 AssertionError，再编译未变异源码恢复通过。

Workbench 使用既有 preview API 受控事实及真实 xterm；图标、导航和 Goal 使用受控样例。图片、每轮加载来源/编译身份及失败记录一起保留。`passed` 只代表上述行为与几何断言通过；采图不是独立审美通过，安装版、真实 CLI、系统截图授权与 durable 重启均不在本场景证明范围。
