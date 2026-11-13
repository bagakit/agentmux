# 独立系统截图编辑窗

需求真源：[截图与录制](../../../../../docs/design/behavior/capture-and-recording.md)；呈现真源：[系统截图选区](../../../../../docs/design/presentation/conversation-input.md#系统截图选区)。

运行 `node apps/desktop/scripts/verify-system-screenshot-editor.mjs`。真实生产 `SystemScreenshotEditor` 创建独立 Electron 窗口，加载生产最小 preload 与 Renderer entry；CDP 发送可信指针输入。输入图由私有 Canvas 构造，不是用户屏幕。原生产 ScreenCapture 经真实 pasted owner 写入私有原稿文件；剪贴板和原稿接收者使用私有 sink，不触碰用户剪贴板或草稿。

实际处理图经原生产保存器写入私有 PNG，读取字节和尺寸；原稿经生产文件 owner 与实际修订感知文件 worker 保存并重开，恢复裁剪和可编辑遮盖。系统 context 明确来源类型，没有编造 Browser 身份。真实 `ScreenshotPins` 打开独立参考窗；丢失第一次读取回执后，从原 operation 查询，确认没有重复创建。

代表图覆盖正常暗色、裁剪遮盖、原稿菜单与重开、贴图未确认及恢复、窄窗未确认、交付失败、窄窗亮色及其菜单。采菜单前只等待该菜单自身动画完成；长状态不得越过标题列，完整文本保留在 tooltip。检查真实 header 几何、Copy、可读画布和编码中 Cancel。菜单 Esc 只关闭菜单；完成 Copy 保留旧图，不阻止下一次独立捕获；旧窗再清除标注并复制，只改变私有剪贴板，不新增或改写原草稿文件。另记录实际处理输出耗时和所有所属窗口关闭后的释放。

本夹具不证明系统选区、跨应用快捷键、TCC、真实用户剪贴板、真实草稿分发、安装包或安装副本；这些归各自 owning 验收。采图不是审美通过，须独立 Agent 实际看完整图给结论。
