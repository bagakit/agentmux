# Mote 剪影的 Native 布局边界

合同：[Mote 持久身份与动作](../../../../../docs/design/presentation/motes-and-coordination.md)、[动态视觉的渲染边界](../../../../../docs/design/presentation/shared-rules.md#动态视觉的渲染边界)、[动态视觉的浏览器成本验证](../../../../../docs/testing/strategy.md#动态视觉的浏览器成本验证)。

```sh
node apps/desktop/scripts/verify-mote-silhouette-layout.mjs --mutations
```

场景编译产品 `SpaceObjectIcon → MoteIdentityMotion → MoteSilhouetteArt`、`MoteAvatarCrop`、共享指针与 SessionMotion、原主题 runtime 和完整产品 CSS。普通 Native Electron 窗口不抢焦点，关闭遮挡后台节流，以持续呈现的实际显示环境观察。原组件消费七类真实宿主结构与 CSS：rail、chooser、常驻 footer、目录 collaborators / list、104px 预览与104px 裁切；footer 的高优先级 `inline-flex` 和预览的 `grid` 均在同一 CSS 级联内，不能被私有 override 替代。

固定七个可见剪影与输出负载，无关留存 DOM 工作面从200增至16000；再增加六个相关剪影，以及原七个剪影与真实 xterm 持续输出共存。每场景从相同原生动画相位观察14.1秒完整自然周期，保存部件矩阵、实际像素变化、外部槽位和完整截图。Trace 保留失效源、Layout 根、Style / Layout / Paint / Layerize / Commit 和去重主线程任务成本。局部 SVG Layout 允许存在；固定相关消费者后，部件 Layout 不得传播到 document 或因无关规模显著放大。原裁切台可承担自己的局部布局。前三场目标消费者矩阵把邻居沿原 visible=false 路径静态化；持续输出场恢复邻居全部原动作，记录真实混合成本，允许终端和旁路自身的 document Layout，不能据目标矩阵声称整页零全局布局。

承重变异只撤销共享 owner 对 `.mote-silhouette-art` 的 `inline-block` 资格，恢复五官专用选择器。其余动画、主题、尺寸、宿主、工作面和输入不变，同一范围与成本 oracle 必须红；恢复后必须绿。`inputs.json` 绑定实际消费源码、原 CSS / 变异 CSS、编译产物 hash 与 Electron 版本，Native receipt 绑定 Renderer PID、窗口、GPU、帧和 trace。

行为检查覆盖13种系列外观、深浅主题、原自动 / 可编辑五官 / 字形 / 用户图片邻居、静态45px / 24px 样张、目录45px / 64px、裁切 zoom / 真实 pointer 拖拽 / reset、命中、原 SessionMotion 的 thinking / tool / starting / waiting / identity、附近指针与姿态组合。同一已渲染原头像还进入 FocusToolbar 的14px 按钮、原命名 container 触发的12px 窄形态、20px 菜单图标宿主，核原 CSS 尺寸、focus 与完整画面；这些宿主检查不宣称 Dropdown 导航与业务动作已验收。显式 visible、原 parking、IntersectionObserver、document hidden 和 reduced-motion 均沿原 owner 停活并恢复。真实 xterm 持续输出下接受 Chromium wheel、输入和组字提交，保滚动与焦点。

私有 typed SessionSnapshot / timeline 只供原呈现消费者读取；不模拟 Provider、Core 或 ctxmux Run，也不操作用户 App、Session 或健康 Run。终端输入仅进入隔离 xterm 的本地接收端，不证明物理键盘、OS IME 或用户原会话恢复。宿主布局在此复用原结构与 CSS，不宣称全 App 导航和持久工作面已验收；真实重启恢复由交付任务承担。本修正只影响内部 CSS 呈现，无需新增 JSON-RPC / CLI 公共能力。

命令打印 `verification.json`，同目录 `review.md` 直接列出完整截图、身份与 receipt，交独立 Agent 逐张实际看图。全周期像素与矩阵证明持续动作，截图不代签审美。`--smoke` 只用于3.2秒活跃相位开发诊断；`--behavior-only` 只用于行为采图，两者均不能替代正式 `--mutations` 门禁。
