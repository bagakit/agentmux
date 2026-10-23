# UI 弹层的实现归属

行为合同见 [Browser 浮层让位与输入层级](../design/behavior/browser-workface.md#浮层让位与输入层级)，呈现合同见 [共享弹层作用域与层级](../design/presentation/shared-rules.md#弹层作用域与层级)。本页只说明实现如何消费这两处合同；不持有另一份窗口、Session 或业务状态。

## 共享组件与宿主

[`client-ui/Modal`](../../packages/client-ui/src/components/Modal.tsx) 是 Desktop、Mobile 和共享图片阅读器的 Dialog 入口，复用 Radix 的焦点、关闭与无障碍机制。它持有本次展示的身份、作用域、附件 slot 和展示失败状态；调用者继续持有 requested-open、表单、忙碌状态和业务操作。展示 Retry 只换展示身份，不重新提交业务动作。

真实 modal 在准确 document 的窗口 overlay 根建立独立作用域。必需的 scrim 和 content 标记同一展示身份，附件经独立 slot 保持在内容滚动区外。嵌套 modal 回到窗口根，避免困在前一个 modal 的 CSS 层叠上下文。非模态 Dialog 保持原有非模态语义。

作用域内的语义边界是实际可聚焦、非滚动的 DOM 节点，接收 Radix 的焦点与 ARIA 属性并包含内容和附件；Content 的公共 ref 仍指向原绘制表面，布局、背景和内容滚动也留在那里。共享入口组合已有 IME 事件判定与调用者的关闭约束，不在各表单维护第二份 Escape 策略。跨 document 移动保留原内容和文本选择，仅重新取得准确 document 的行为资源。

Portal 使用稳定的 DOM host。工作面跨 document 移动时，host 随原内容移动，表单和编辑器不因换容器而重建；焦点、关闭和滚动约束则在实际 document 上重新取得并释放。依赖库对多 document 的修正沿 [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) 的 `patchedDependencies` 声明，由 lockfile 绑定补丁内容；原库的作用域、层栈和滚动机制继续负责行为，客户端不复制一套管理器。

[`overlays.css`](../../packages/client-ui/src/styles/overlays.css) 定义全局层级 token 和 modal 内部局部次序，Desktop 与 Mobile 引入同一文件。业务组件只消费角色，不计算“当前在弹窗里所以再加一层”。Desktop 的 [`WindowOverlayHost`](../../apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx) 将已有 Portal 接到共享作用域和实际 `WorkbenchDocument`；内容与焦点使用同一个 document，不能从主窗口全局变量猜测目标。

## Desktop 的原生 Browser 投影

原生 Browser 覆盖 Renderer 的 DOM，单独增加 CSS z-index 无法跨越这条边界。

1. [`native-overlay-regions`](../../apps/desktop/src/renderer/src/lib/native-overlay-regions.ts) 收集实际打开的浮层与准确 Browser 几何。它沿共享作用域排序，将必需节点作为一组验证和预算，附件独立处理；位置观察只订阅有关浮层。原生 popover 的打开序独立保留。
2. [`useNativeOverlayChrome`](../../apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts) 向 Main 发布当前 document 的描述，并将带展示身份的失败回执送回原组件。迟到回执不能关闭后来的一次展示。
3. [`NativeOverlaySurfaces`](../../apps/desktop/src/main/native-overlay-surfaces.ts) 通过原 Browser owner 校验目标，准备整组位图和输入投影后提交。它选择准确 Browser 与已绘制的下层 Chrome，再交 [`native-overlay-scrim`](../../apps/desktop/src/main/native-overlay-scrim.ts) 将窗口 DIP 转成局部 SVG。后者只持有纯几何与绘制代码，显式设置完整 mask 坐标系；不查询 Browser、申请输入权限或管理原生资源。
4. [`NativeOverlayWindows`](../../apps/desktop/src/main/native-overlay-windows.ts) 按已有原生工作面窗口管理各自的投影 owner 和输入路由。真实 WebContentsView 的创建与绘制仍归 Surfaces；销毁、关闭与失败释放该次展示，不改变 Browser 或 Session 的生命周期。

背景人工命中隔离经 [`BrowserViewManager`](../../apps/desktop/src/main/browser-view-manager.ts) 的 `acquireNativeInputBarrier` 取得准确原页面的准备与释放句柄。Browser owner 将 Agent 控制与模态展示的独立需求合并到同一个 [`BrowserNativeInputShield`](../../apps/desktop/src/main/browser-native-input-shield.ts) 原生表面；Surfaces 只管理当前展示需要的句柄，不直接拦截原网页输入。句柄释放只结束自身需求，保留其他仍有效需求和未确认销毁的准确资源身份。系统命中进入原生屏障，已授权的 CDP 继续寻址原网页；这份展示协议不成为第二套 Browser 控制事实。

内部描述和失败回执归 [`shared/native-overlay.ts`](../../apps/desktop/src/shared/native-overlay.ts)。它们是展示协议，不进入 Core 的 Session、Run、权限或恢复事实。

内容投影可见时，`NativeOverlaySurfaces` 在准确 Renderer 上保留一个合成帧订阅。SDK 帧用于比较原投影区域的像素；像素变化才沿原 `capturePage` 取得带原色彩描述的 PNG。动态更新只保留一轮在途工作和最新待处理帧，解码完成后重新核对原订阅与投影版本再安装；几何准备、隐藏、撤去和销毁释放旧订阅。逐帧检查只消费本 owner 的投影和准确宿主，不遍历 Session 或 Browser manager 的全局条目。

SDK 订阅仍读取完整 Renderer 帧。区域比较避免无变化时重复捕获、PNG 编码和原生解码，不表示底层读回已缩小到弹层矩形；这项成本只在存在可见内容投影时承担。

系统文件／目录选择、保存和确认框不经过 Browser 位图投影。发起组件沿 [`WorkbenchDocument`](../../apps/desktop/src/renderer/src/lib/workbench-document.tsx) 携带当前窗口身份，原 preload／IPC 透传给 [`WorkbenchWindows.windowForDocument`](../../apps/desktop/src/main/workbench-windows.ts) 取得准确原生 parent。工作面移动仍复用原 Root 桥，因此 IPC sender 只证明可信来源，不决定对话框位置；窗口身份与代次继续由原窗口 owner 校验。

## 防退化验证

[`overlay-architecture.test`](../../apps/desktop/test/overlay-architecture.test.ts) 从实际源码发现消费者，限制原始 Dialog 导入和全局 token 的定义 owner；它是贡献边界检查，不能替代真实绘制或输入验收。共享 Modal 测试覆盖关闭、失败、草稿和焦点生命周期，Renderer 与 Main 测试覆盖收集及整组投影。

[`verify-ui-layering`](../../apps/desktop/scripts/verify-ui-layering.mjs) 在隔离 Electron 中运行实际 Stop 消费链、原生 Browser、附件、窗口形态和失败场景，并对承重实现执行私有变异。图像、候选身份和运行回执留在本机证据目录，独立图审按 [视觉验收规范](../guides/agent-visual-e2e-review.md) 执行。

[`verify-modal-boundaries`](../../apps/desktop/scripts/verify-modal-boundaries.mjs) 分别验证原生遮罩像素、Browser 输入效果和共享模态交互。像素期望从场景中独立选取应遮区域、间隙和下层 Chrome 排除区，不调用生产几何函数生成答案；输入同时验证人工命中被隔离与 CDP 的真实页面副作用；焦点在 Chromium 中验证。各切片对实际加载的生产源码执行定向变异，并绑定源码、依赖、编译产物与回执，不能用 mock、脚本文本或操作返回成功替代这些合同。
