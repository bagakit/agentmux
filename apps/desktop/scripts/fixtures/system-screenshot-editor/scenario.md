# 独立系统截图编辑窗

需求真源：[系统截图快捷键与选区](../../../../../docs/design/behavior/native-desktop.md#系统截图快捷键与选区)；呈现真源：[系统截图选区](../../../../../docs/design/presentation/conversation-input.md#系统截图选区)。

运行 `node apps/desktop/scripts/verify-system-screenshot-editor.mjs`。真实生产 `SystemScreenshotEditor` 创建独立 Electron 窗口，加载生产最小 preload 与 Renderer entry；CDP 发送真实指针输入。输入图是本夹具 Canvas 构造的合成工作页，不是用户屏幕。交付回调使用私有 sink，不触碰系统剪贴板或用户草稿。

完整代表图：正常暗色 `normal-dark.png`、裁剪与遮盖 `crop-cover-dark.png`、交付失败且编辑保持 `delivery-failure-dark.png`、420px 窄窗亮色 `narrow-light.png`。实际复用共享工具栏、主题图标、绘制和 PNG 合成，验证裁剪与黑色不透明遮盖的实际导出像素。另检查加载权限、窄窗 Copy 可见和编码中 Cancel。主按钮按原采图时的草稿资格显示 Copy / Copy & attach，不承诺发送。

本夹具不证明系统选区、跨应用快捷键、TCC、真实剪贴板、真实草稿分发、安装包与实际安装副本；这些由各自 owning 验收负责。采图不是审美通过，须由独立 Agent 实际看完整图给结论。
