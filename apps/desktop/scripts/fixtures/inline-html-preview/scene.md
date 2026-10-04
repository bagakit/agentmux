# HTML 就地预览私有 Chromium 场景

合同来源：`docs/design/behavior/files-and-git.md` 和 `docs/design/presentation/files-and-git.md` 的文件源码与预览模式。通过真实 Explorer 打开 `index.html`，在生产 Monaco 键入草稿，点击 `Preview current content`，操作页面按钮，再点击 `Show source`。以宽窗口和窄双分屏查看同一个 FileRegion；故障后重试、切到后台及迟到回执均保留原文件。

真实边界：生产 WorkspaceWorkbench、FileExplorer、FileSurfaceView、HtmlFilePreview、Monaco 和 CSS；生产 preload 文件 API 经真实 Electron IPC 进入 WorkspaceFiles、HtmlFilePreviews。iframe 使用 Chromium 实际加载内联脚本和工作区相对 CSS、模块 JS、SVG。由 WebFrameMain 读取页面事实，证明 opaque sandbox 无 host bridge、Node 或父文档访问。文件保存不调用，所有工作区字节前后核对。

受控边界：空 Core Session snapshot、配置、Git 非仓库事实和不参与本场景的 Browser 能力采用私有适配器。IPC 注册为目标窄夹具，保留原应用 frame 检查；生产 IPC 的注册和 sender 信任另由 owning 测试证明。开错目标不会操作用户实例。故障和迟到响应是夹具注入的 transport 场景，实际分配与释放仍经真实 owner。未改变布局或 Session 生命周期，不增加重启验收，也不宣称安装包已验证。

默认命令采图至 `docs/reviews/evidence/editor-inline-html/`；只采图，不签审美。独立 Agent 逐张打开完整 PNG，检查控件、层级、可读性、窄布局和失败恢复的清晰性，再写 `visual-review.json`：`{approved:true,reviewer:"...",sourceDigest:"...",screenshots:[{file:"...png",sha256:"..."}],notes:"..."}`。`--check` 消费相同候选的 capture、mutation 和独立图审证据。
