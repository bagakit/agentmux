# UI 层级的真实调用与窗口采图

合同入口：[交互公共规则](../../../../../docs/design/behavior/shared-rules.md)、[呈现公共规则](../../../../../docs/design/presentation/shared-rules.md)、[Browser 工作面](../../../../../docs/design/behavior/browser-workface.md)。具体层级、失败恢复和嵌套归属由这些 owning SSOT 定义；本 fixture 只定义如何观察，不另立产品规则。

```sh
node apps/desktop/scripts/verify-ui-layering.mjs --output .tmp/ui-layering/current
node apps/desktop/scripts/verify-ui-layering.mjs --mutations --output .tmp/ui-layering/mutations
node apps/desktop/scripts/verify-ui-layering.mjs --without-system-fullscreen --mutations --output .tmp/ui-layering/available-checks
node apps/desktop/scripts/verify-ui-layering.mjs --mobile-only --output .tmp/ui-layering/mobile-development
node apps/desktop/scripts/verify-ui-layering.mjs --fullscreen-only --output .tmp/ui-layering/system-fullscreen-development
AGENTMUX_VISUAL_ORCA_CLI=orca node apps/desktop/scripts/verify-ui-layering.mjs --output .tmp/ui-layering/visual
```

真实链路是 `WorkspaceWorkbench` 关闭最后一个 Agent View → Store 关闭计划 → `ConfirmationDialog` → 共享 `Modal` → Window overlay host → collector → `useNativeOverlayChrome` → IPC → `NativeOverlaySurfaces`。点击原生投影后，通过原生产转发返回原 DOM handler，记录可信事件和原 API control。外部 Agent API 使用 preview 受控事实；不停止任何用户 Run。原生 Browser 使用隔离测试页及真实 `WebContentsView`，而非替换成 Renderer DOM；这不代表 BrowserPane 导航或用户页面协议已验收。

场景：

1. 正常窗口从实际 Tab X 打开 Stop；检查 DOM 与原生 hit owner 均为原内容，遮罩和内容同属一个 modal，Cancel 首焦点。初始 Enter 取消；原生投影点击 Keep 只关闭 View并保留 Session/草稿；Stop 延迟回执期间再次点击和 Escape 不重复发起、不丢失 busy 请求。
2. 弹窗已经打开时改变为 640×410 窄矮窗口、125% zoom；保留同一个 modal identity，观察标题、内容、按钮可见性和原生 owner 同步。macOS 私有窗口分别验证 `setSimpleFullScreen` 与真正 `setFullScreen`，两者回执独立；系统全屏必须收到原 Window 的 `enter-full-screen`、`leave-full-screen`，确认 `isFullScreen` 与新几何稳定，再核对原 modal / Browser / Session / 草稿保留、原生键盘 Tab 能进入原控件，以及原边界、Browser attachment 与 zoom 全部还原。系统拒绝或事件未确认时记录 unconfirmed 并失败，不能由 Simple 结果代签。全程不调用 focus 或 activate；`--fullscreen-only` 是这个受限场景的开发入口，不能代签其他场景。
3. 仅在 Electron `capturePage` 这个外部 IO 边界暂挂原内容捕获。准备中检查没有孤立 native scrim；直接向原 Browser 发送可信输入，不得触发其背景动作。释放 IO 后同一原确认可以正常显示。
4. 同一 IO 边界一次失败。检查 required pair 整组撤回、DOM 模态暂停、原 View/Session/Browser 草稿及停止请求保留，非阻塞服务窗保留 Retry。点击 Retry 后恢复同一请求，未凭失败触发 Stop。
5. 同一原确认内使用实际 `HoverDropdownMenu` 与 `WindowOverlayPortal`，观察独立 Portal 落在父 modal 的非滚动 slot，DOM hit 保持在父内容之上。菜单使用真实 right/start placement，先确认它与原生 Browser 相交，再要求独立原生投影和原回调命中；不为完全不相交的附件要求投影。附件 IO 失败不得撤销 required pair；重新打开附件后采集正常图。第一个 Escape 只关闭子菜单；第二个关闭父确认。
6. CSSOM 更改原弹窗位置而不修改原节点、属性和尺寸，原生边界须随实际纯布局位移更新。两次在较新的原生 HTML popover 之后打开 Stop，复用的宿主须重新提到顶层，并保留原 HTML popover。
7. 第二个真实 BrowserWindow 加载自己的实际 Renderer document、Workbench、原生 Browser 和 Modal；只有这个 window 收到自己的组投影。原窗口无新 modal / native chrome。通过独立窗口原投影点击 Cancel，原 Browser 输入仍保留。
8. 父确认中运行实际共享 `AgentComposer`。可信输入 `/` 展开非空原补全项；ArrowDown 必须允许焦点进入 portaled option，Enter 只选择并编辑原草稿，不发送或确认。原生 repaint 失败与 Retry 前后保持同一个维护编辑器 DOM 实例和完整草稿。
9. 完成 Desktop 后导航到独立 Mobile entry，避免 Mobile CSS 污染此前窗口。390px 真实 `MobileMailbox` 从原 IO 消息“查看原文”展开共享图片；原缩略图打开真实 lightbox，两个稳定 Portal host 是同一 window root 的兄弟，图片 scope 不在 sheet scope/host 后代，共用实际 dialog token、位于 sheet 上方并显示同一原 bytes。Escape 与 Close 均只关闭图片，保留原 sheet/message 并恢复原缩略图焦点。`--mobile-only` 仅供此受限场景的开发验证，receipt 明示 scope，不代签完整 Desktop/native proof。
10. 使用真实 `StableWorkbenchView` 和真实 `placeWorkbenchWindow`，把同一个工作面 host 从主 document A 迁到同源 iframe 的真实 ownerDocument B，再迁回 A。迁移前通过可信 CDP 输入在实际 `AgentComposer` 编辑草稿；迁移前后要求原 host、form、editor、content DOM、组件 state 身份、草稿及 modal id 全部保留。旧 document 无活动 modal，outside focus 可到、Escape 不取消新 document 请求、背景 wheel 不被旧 scroll lock 消费；目标 document 的实际表单保有焦点 trap，并继续阻止其背景 wheel。隐藏 focus-guard span 数量仅记录诊断，不能由节点存在推断输入 trap 残留。随后将原 iframe 以保状态的 DOM move 放入 A 模态真实内容边界，在同一个 React runtime 中同时打开 A/B 两个实际确认框，分别核对各自 trap、输入锁，以及单次 ownerDocument Escape/原 Cancel 只影响准确请求。此段 focus、wheel、Escape、Cancel 是明确的 DOM 合同事件，非物理键鼠；iframe 验证不代替第 7 项独立 BrowserWindow/native proof，也不声称实现了 iframe native chrome 投影。
11. 从真实 Mote 原入口的 Context Menu 打开 `SpaceIconPicker`，使用原 isolated Config、Mote 与 Avatar source owner 的真实 target、catalog 和内置 GLB。确认切到 Series/3D 后内容与遮罩成组、正文不被重复压暗，原生 Browser 仍可见且内容 View 是正确的顶层命中对象。通过原生输入连续修改材质、表情、旋转及 Canvas 拖动；检查同一 modal、target、source、canvas 与 native View 保留，原 GLB meshes/triangles 实际绘制、PNG 草稿变化且准确 Chrome View 的像素跟随。Cancel 后原头像配置、Browser 输入、Session、布局与草稿保持。仅图标选择或单独 Avatar renderer 的检查不代签这个组合。

`--mutations` 只在私有编译中改变实际生产模块：取消 required pair 的延迟原子提交、去掉背景输入 guard、让嵌套 Portal 逃出父 modal。对应真实场景必须 RED，再以同一输入 SHA 编译原候选，恢复所请求检查通过。所有实际消费产品源码/CSS、锁文件、编译 artifact、进程退出和非空场景均记录；候选输入在轮间变化会使整轮无效，重新运行即可。

Main 与产品一样以 ESM 消费原外部 Core，preload 仍是 sandbox CJS。Node loader 观察器原样委托加载，绑定实际外部模块字节；不把 CJS 重打包产物当成产品 Core。GLB/JSON 等不经过 Vite 的原 Avatar 资源也由 source owner 回执绑定，轮间逐字节核对。

`--without-system-fullscreen` 是明确的部分证明模式：不再发送已未确认的 macOS 系统全屏请求，保留原失败回执，仍运行其余完整 Desktop/native、开态 resize/zoom、Simple、独立窗口、失败恢复、completion 与 Mobile，以及三个私有变异和 restored。它不改变任何产品行为或 T3 验收条件。成功时进程退出 0 仅表示所请求的可用检查通过；receipt 必须 `availableChecksPassed: true`、`completeGate: false`、`passed: false`，并列出 `uncovered: ['native-system-fullscreen']`，无真实 OS 图时另列 `OS-composition`。输出明确 PARTIAL，不打印完整 GREEN；T1/T2 可消费其绑定同候选的已覆盖切片，T3 仍保留外部阻塞。默认不加此参数仍严格请求并验证系统全屏和完整覆盖，Simple 不代签。没有 OS 图的普通或部分运行均不闭合完整 gate，独立看图也仍是外部验收。

每场景保留完整 Renderer 图和 native page 图，它们各自不包含另一 WebContents，不能称为 OS 整窗图。设置 `AGENTMUX_VISUAL_ORCA_CLI` 后使用已读版本指南的 `computer-use` provider，按私有 Electron 精确 PID/窗口 ID 取得真实 OS 整窗图，同时保留捕获前后原生 owner 和 provider 回执。没有 OS 图时不能签发合成层级的视觉通过；不拼图冒充 OS 截图。

每次 frame 还只读该准确 Window 的原 `NativeOverlaySurfaces` owner，逐个捕获已附着、可见、非准备态的真实 Chrome View。记录原 View／WebContents／Window／region／modal identity、前后 bounds、PNG 与 bitmap hash、alpha 像素统计，保存每张 compositor readback 图供独立评审；内容需有绘制像素，scrim 只覆盖未被其它 Chrome 遮住的 Browser 区域，允许其合法全透明。独立 BrowserWindow 从自己的 manager 取原对象，不借全局 main 的投影。`capturePage` 可能主动要求一帧，因此这些图只证明准确 View 可读回 compositor 像素，不能证明首次可见呈现或宿主整窗合成，不能代替 OS gate。原 onload、decode、RAF 或 DOM 都不替代这些像素证据。

`receipt.json` 通过只证明行为断言。`review.md` 提供独立看图入口，评审者必须实际打开完整 OS 图，检查正常、busy、窄矮、缩放、失败服务窗、Retry 和嵌套菜单的可读性、动作主次、对齐与留白，并给出明确交付结论。采图不是审美通过。

证明边界：此 probe 不操作安装版、不改变用户工作面、不证明真实 CLI 停止、物理键鼠、系统输入法或 durable 进程重启恢复。系统全屏证据仅覆盖这个精确私有 Window 的实际 macOS transition，不推断其他窗口或用户手势已覆盖。原工作面持久恢复仍需要同批真实持久空间与 Session 身份的重启证据，不能由本轮构造的隔离窗口代签。
