# Browser 原生浮层与最窄工具栏

行为约束：[交互 SSOT《Browser 任务能力与可复用资产》](../../../../../docs/design/agentmux-desktop-interaction.md#browser-任务能力与可复用资产2026-10-03)。控件语言：[密度 SSOT《Browser 任务工具与证据的紧凑呈现》](../../../../../docs/design/agentmux-surface-density.md#browser-任务工具与证据的紧凑呈现2026-10-03)。本场景沿已有 canonical launch/cleanup，以 private userData 从实际入口创建 Browser；不替换 bridge、不写 Store 或 durable 工作面、不改变用户运行副本。

```sh
node apps/desktop/scripts/verify-browser-overlay-visibility.mjs
node apps/desktop/scripts/verify-browser-demonstration.mjs
```

浮层场景在正常、窄、短窗口实际 hover 身份 tooltip、打开 Browser operation popover，再做 1.25 UI zoom。每轮原 native 页面像素非空、未交叠按钮收到恰好一个 trusted `mousedown → mouseup → click`，键盘打开的菜单由原页面点击关闭；真实 native Chrome 点选回到原 Activity action。截图编辑实际画长线、Cancel 后原 Owner 和页面输入仍在。退出与重启使用普通产品路径，原双 Browser Tab/Region、焦点和分割布局先做准确比较；恢复的浮层为关闭态，原页面有未强制修复的 compositor frame。

成本补充轮在默认未观察的重启/paint/input 门之后执行：仅在 private Main 的原 sibling Browser 实例上计数 `setBounds`、`setVisible`、`loadURL`、`reload`、`setBackgroundThrottling`、`capturePage`、`sendInputEvent` 和 `destroyed`。对相关 popover 的真实打开、原页面外部点击、重开、native action 和关闭，相关 Chrome 工作非空，sibling 调用为零且原 Owner/URL/bounds/visible 保留。wrapper 保留原 receiver、参数、返回和异常；这一补充轮明确属于带观察的成本范围，不能反过来覆盖默认路径的历史失败。

演示场景先以正常窗口完成真实录制，再创建原双 Browser split。收回原 draft drawer 后，在正常、窄、短和产品最低窗口尺寸测量真实 toolbar、地址、必要动作、More 与 Close split。每个控件都记录非空 rect、中心与四条边上的 `elementsFromPoint` 原始栈；实际最窄 Pane 不能由手写宽度或静态 markup 冒充。最低窗口中真实 Tab 顺序到 More，焦点环可辨；随后实际点 More，再点 Start recording，不把开始录制移到 split 之前。原两个 Browser Region、页面、名字与录制身份保留，原页面收到恰好一个 native trusted click，形成非空语义步骤。

ordinary restart 准确比较原 Tab/Region/焦点/布局后，从 More 重新进入非空 Interrupted draft。最后才显式点击目标 Region 自己的 Close split：该动作是本 private 场景唯一授权的关闭，记录原 sibling Owner 与 durable Region 保留，并在其原页面再次做一次 trusted input；这一步不作为关闭前恢复布局的替代证明。

图片分别来自原 Renderer webContents、原 native Browser page 和 native Chrome。它们不拼接成 OS 整窗；如显式启用现有 OS capture，独立记录整窗原图。`captureOnly: true` 和 `aestheticReview: not-performed` 只表示采集，必须由实现作者之外的 Agent 实际看完整原图和输入证据后评审。Synthetic `.click()` 仅用于证明录制拒绝冒充人工；不能拿它代替真实工具或页面操作。此场景没有创建活跃 CLI Session/Run，不把 Browser 脚本的健康执行扩大为全部 Agent/Terminal 验收。
