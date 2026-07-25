# AgentMux Terminal Interaction Latency

## 用户确认的问题

在真实 Agent TUI 中，Resize、滚动和界面刷新都非常卡。它们不是三个独立功能缺失，而是在同一个 Renderer 热路径里互相放大：拖动 Split 或整个 macOS 窗口触发布局变化和 Terminal resize，Terminal 重绘产生连续输出，输出又推动全局 React 投影和逐块 ACK。

## Owner 与修复边界

- `TerminalView` 是 Terminal 字节、xterm 写入和输出游标 ACK 的唯一 Renderer owner。`terminal-output` 不进入全局 Zustand 投影。
- Core 与 ctxmux 继续分别拥有 Session 合同和 Run/PTY/Replay；本修复不改变协议，不新增缓存、daemon 或第二套终端状态。
- Renderer layout 仍是 Pane/Split 的唯一 SSOT。`react-resizable-panels` 在拖动期间维持 live layout，Store 只接收一次最终比例。
- 已有 `TerminalViewportSynchronizer` 继续负责稳定帧、像素变化和 latest-wins PTY resize；不再叠加另一层通用 resize throttle。
- PTY Resize 绑定当前 View 的 retained Attachment capability。Desktop Main 从 lease 解析 exact Run，
  并让 Resize、Detach 与 Stop 复用同一串行边界；不从 Agent Session id 重新猜当前 Run。
- Electron Main 是原生窗口 resize 生命周期的 owner，只向 Renderer 发布 `will-resize` 开始与 macOS/Windows `resized` 结束；不逐像素传几何，也不管理 Terminal grid。

## 行为要求

1. 高频 `terminal-output` 不改变全局 Session projection 的对象身份，也不触发 Workbench、Pane、Tab 和 SessionPane 的级联渲染。
2. 输出 ACK 在任一时刻最多一个 IPC 在途；突发期间只保留最新游标，成功路径最终 ACK 到最新请求游标，旧游标不能倒退覆盖新游标。
3. Pointer Split drag 的中间 `onLayout` 只更新局部候选比例；释放 handle 时只向 Store 提交一次最终比例。非拖动布局变化仍可立即提交。
4. 关闭 Terminal View 后不启动新的 ACK 或 Resize；已经在途的调用可以自然结束，排队但尚未开始
   的 viewport work 必须丢弃，不能形成 retry loop 或未处理 rejection。
5. 改动必须由 owner-level 行为测试覆盖，并通过 Desktop typecheck、focused tests 和仓库统一 `pnpm check`。
6. Pointer Split drag 是一段明确的 Renderer 交互事务：拖动期间 xterm 保持上一个完整 grid，不执行 `fit()`、reflow 或 PTY resize；释放后只按最终容器几何执行一次 fit 与 PTY resize。扩大 Pane 时允许暂时露出 Terminal 背景，缩小时允许裁剪旧 grid，不能用持续清屏换取逐像素 reflow。
7. 手动拖动整个 macOS 窗口也是同一类明确交互事务：Electron Main 用原生 `will-resize` / `resized` 边界通知 Renderer；Renderer 复用同一个 `setInteractiveResize` 合同冻结所有可见 xterm，窗口释放后各 Terminal 只按最终容器几何同步一次。重复的原生开始事件必须折叠，不能用猜测毫秒数的 debounce 判定结束。
8. 拖动左侧工作区工具栏宽度时，也要冻结所有可见 xterm。松手后只按最终宽度做一次 fit 和 PTY resize，不能让工具栏拖拽绕过同一份 `interactiveResize` 合同。
9. Stop 与 Resize 的顺序由 Attachment owner 线性化：Resize 已进入时 Stop 等待；Stop 已进入时
   lease 被撤销，迟到 Resize 不调用 ctxmux。Agent 的 Resize 与 Stop 必须携带 frozen exact Run，
   不能命中同一 Agent Session 后来 Resume 出的新 Run。

## 非目标

- 不以主观手感或单次 CPU 截图宣称固定百分比收益。
- 不降低 xterm scrollback、不丢弃已接受的 live output、不改变 replay gap 语义。
- 不把 Pane layout 下沉到 ctxmux，也不让 agentmux CLI 直接管理 PTY 尺寸。
- 不让 Electron Main 逐像素计算或传递 Terminal、Pane、Monaco 与 Browser 几何；Main 只拥有原生窗口交互边界。
- 不新增通用 scheduler、猜测毫秒数的全局 debounce、性能配置层或兼容路径。
