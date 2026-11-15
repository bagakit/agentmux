# 文件与 Git 的实现

本文说明 Desktop 读写 Workspace 文件、移动与改名、扩展文件格式、Git 仓库操作、PR 创建、worktree 与扇出的当前源码机制，以及书签文件与提交作者头像的读取方式。必须成立的行为约束见[文件、编辑与 Git](../design/behavior/files-and-git.md)，分层归属见[系统职责地图](system-ownership.md#从哪一层接入)。源码机制不代表某个安装或运行实例已通过验收。

## 文件读写与修订

Desktop Main 的 [`WorkspaceFiles`](../../apps/desktop/src/main/workspace-files.ts) 是 Renderer 读写 Workspace 文件的唯一入口。它持有 Workspace Root 约束、磁盘 revision、单文件观察和磁盘错误事实；普通文件的原子写入委托给 [`OrdinaryWorkspaceFiles`](../../apps/host/src/ordinary-files.ts)。Shared contract（[`contracts.ts`](../../apps/desktop/src/shared/contracts.ts)）与 preload 只暴露 typed read、write、observe 和 move。

- **读。** `read` 返回内容与不透明 revision。
- **写。** `write` 必须带读取时的 `expectedRevision`，结果类型 `WorkspaceFileWriteResult` 为 `written`、`conflict`、`error` 或 `unknown`。替换之后才丢失回执时返回 `unknown`，不解释成明确未写入。
- **原子发布。** 原生写入（[`workspace-file.inc`](../../apps/host/native/workspace-file.inc)）在同一目录以 `O_CREAT | O_EXCL | O_NOFOLLOW` 创建临时文件，写入后 `fsync`，再发布并 `fsync` 父目录：
  - 覆盖已有文件用 `rename`；
  - `expectedRevision` 为 `null`（新建文件）时用 `link` 独占发布，目标已存在就失败，不会覆盖别人刚建的同名文件；
  - 临时写入或发布失败时删除临时文件，原文件字节不变。
- **合作写入。** helper 收齐输入后，对实际父目录持有 `flock`，在锁内比较原 revision、发布、核对已发布文件的实际字节与 inode，并同步父目录后确认。不同进程经同一 File 写入实现提交同一旧 revision 时，只有一个成功；同目录的独立保存等待当前短事务，其他目录不受此锁影响。不遵循这把锁的外部写入，以及目录移动，不由这项串行保证覆盖。
- **观察。** Main 的观察只发布 `WorkspaceFileInvalidated`（`{ workspaceId, path }`），Renderer 收到后重新 read。远端 Workspace 的单文件观察返回 `REMOTE_WORKSPACE_FILE_OBSERVATION_UNSUPPORTED`。

Mote 归档由 [`ScratchTopics`](../../apps/host/src/mote-resources.ts) 从同一份原文件字节取得业务版本与 File revision，再经上述 File 实现提交；冲突拒绝原意图，不借新读的 revision 重试。首次归档文件以 `0600` 创建，既有权限保持。业务状态、原目录身份和写后读取确认仍归 Mote owner，原 File 回执未知时保留已发布字节与重读入口。

## 移动与改名

- **本机原子移动。** `WorkspaceFiles.move` 在 macOS 上调用随 Desktop 分发的 helper `resources/bin/agentmux-workspace-move`。
  - 源码是 [`workspace-move.c`](../../apps/host/native/workspace-move.c)，由 [`buildWorkspaceMoveHelper`](../../apps/host/scripts/build-workspace-move-helper.mjs) 编译。
  - helper 以 `renameatx_np(..., RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH)` 完成相对 Workspace Root、不跟随符号链接、不覆盖目标的移动。
  - Linux 构建只支持同一目录内的 `renameat2(..., RENAME_NOREPLACE)`。
- **回执。** 结果类型 `WorkspacePathMoveResult`：
  - helper 明确成功时为 `moved`；
  - 失败时带 `finalLocation`：`source` 表示确认未提交，`unknown` 表示提交后回执丢失。实现不用源与目标路径是否被占用来猜对象位置。
- **不支持的情况。** 以下情况都明确返回，不退回普通 `rename`、`mv` 或重试：
  - 本机非 macOS 平台：`LOCAL_WORKSPACE_FILE_MOVE_UNSUPPORTED`（`finalLocation: source`）；
  - helper 无法启动：`WORKSPACE_MOVE_HELPER_UNAVAILABLE`；
  - 远端 Workspace：`REMOTE_WORKSPACE_FILE_MOVE_UNSUPPORTED`。
- **移动计划。** Renderer 的 [`planFileExplorerMove`](../../apps/desktop/src/renderer/src/lib/file-explorer-move.ts) 与 `fileExplorerMoveTargets` 从同一份已加载文件树预先计算移动计划。同父目录、自身或后代目标，以及已加载的目标同名冲突，都不呈现为可提交目标。
- **路径投影。** 磁盘移动成功后，[`reduceFileRename`](../../apps/desktop/src/renderer/src/lib/file-workbench-state.ts) 一次性纯函数更新 Document、Dirty、Last Active、Tab Group、View／Region 路径与当前 Workspace 的 Explorer 选择与展开状态。
  - [`findFileRenameProjectionCollision`](../../apps/desktop/src/renderer/src/lib/file-workbench-state.ts) 在请求磁盘操作前拒绝会占用已有 Tab、Document 或 Region 的映射。
  - 子树判断按路径段进行（[`isPathWithinSubtree`](../../apps/desktop/src/renderer/src/lib/workspace-paths.ts)、`remapPathWithinSubtree`）。
  - 结果为 `unknown` 时不提交路径投影。

## Renderer 侧的文档簿记

[`file-document-bookkeeping.ts`](../../apps/desktop/src/renderer/src/lib/file-document-bookkeeping.ts) 持有打开中文件文档的进程内簿记，不随 store 快照持久化：

- `documentLifetime`／`advanceDocumentLifetime`：文档代次。关闭文档面时代次加一，迟到的读写结果先比对代次，代次变了就丢弃，不落到新打开的同路径文档上。
- `fileReadRequestIds`、`fileReadInFlightCounts`：读请求去抖与在途去重；`fileInvalidationSequences`：外部改动到达时递增，让在途读取知道自己已过期。
- `fileSaveTails`、`workspaceFileMutationTails`、`withWorkspaceFileMutation`、`transferFileSaveTail`：同一文件的保存，以及同一子树的写入与结构变更，按尾链串行，改名时把保存尾链转移到新路径。

## 文件工作面的宿主组装

Desktop 二级内容由 [`WorkspaceFilesTool`](../../apps/desktop/src/renderer/src/components/WorkspaceFilesTool.tsx) 按原对象选择组装，统一的 [`WorkspaceFilesFrame`](../../apps/desktop/src/renderer/src/components/WorkspaceFilesFrame.tsx) 只持有上下文栏、文件树和分割布局。[Project](../../apps/desktop/src/renderer/src/components/ProjectFilesTool.tsx)、[Topic](../../apps/desktop/src/renderer/src/components/TopicFilesTool.tsx)、[Mote](../../apps/desktop/src/renderer/src/components/MoteFilesTool.tsx) 各自提供原数据、准确文件范围、动作和内容；普通项目不自动订阅 Scratch 目录或分类，Git 历史缓存由分割框架上方的原 Git owner 保留。显式知识收集仍沿原操作读取来源，不建立另一份空间或业务状态。

## 文件格式的扩展位置

格式编辑、呈现与原生工具留在 Desktop，沿原 FileRegion 和 FileDocument 派发；可移植文件与知识领域 owner 由 Host 提供，Core 只公开准确目标、动作和结果类型。行为要求见[格式能力与按需扩展](../design/behavior/files-and-git.md#格式能力与按需扩展)，当前模块按以下职责增长。

| 职责 | 当前来源与扩展方式 |
| --- | --- |
| 轻量格式能力 | [`editor-extensions/catalog`](../../packages/editor-extensions/src/catalog.ts) 集中后缀、复合后缀、语言、MIME、预览、格式化和默认模式；查询不导入引擎。二进制格式继续消费原 `workspace-file-preview` 元数据。 |
| 原工作面与正文 | [`FileSurfaceView`](../../apps/desktop/src/renderer/src/components/FileSurfaceView.tsx) 保有原 Region／正文／模式上下文；[`SourceFilePreview`](../../apps/desktop/src/renderer/src/components/file-preview/SourceFilePreview.tsx) 只选择当前可见格式的 lazy 组件。 |
| 格式实现 | [`components/file-preview/`](../../apps/desktop/src/renderer/src/components/file-preview/) 放呈现与临时资源生命周期，[`lib/file-formats/`](../../apps/desktop/src/renderer/src/lib/file-formats/) 放解析、诊断、Worker 和引擎适配；类型模块不加载重依赖。 |
| 源码着色与格式化 | [`register-file-formats`](../../apps/desktop/src/renderer/src/lib/monaco-languages/register-file-formats.ts) 注册轻量语言规则；[`format-file-region`](../../apps/desktop/src/renderer/src/lib/file-formats/format-file-region.ts) 经原 Monaco adapter 对同一草稿作一次可撤销编辑，显式 Worker 才导入格式化器。 |
| 宿主隔离与文件资源 | [`WorkspaceFiles`](../../apps/desktop/src/main/workspace-files.ts) 持有原资源与读取边界；[`FileDiagramRenderer`](../../apps/desktop/src/main/file-diagram-renderer.ts) 持有独立图计算页面；[`FileBuilds`](../../apps/desktop/src/main/file-builds.ts) 持有显式编译的进程组、日志和私有产物。 |
| 公共消费 | Core [`space-control`](../../packages/core/src/space-control.ts)／[`public-rpc`](../../packages/core/src/public-rpc.ts) 定义目标和回执，Renderer [`store`](../../apps/desktop/src/renderer/src/store.ts) 将公开请求委托给 GUI 同一格式化／构建 owner。Core 不导入格式库。 |

新增格式先补轻量能力声明，再添加所属适配器并接入可穷尽派发；已有 parser、Worker、PDF reader 与资源 owner 可直接复用。格式各自持有适合自身的语义，不强行转成统一 AST，也不为后缀建立独立 editor 包、文件 watcher 或可执行插件层。Markdown 的图通过 `ClientUiPlatform.renderMarkdownDiagram` 注入宿主能力，共享 UI 不依赖 Desktop Main。

编译 owner 当前只在原本地 Host 显式启动本机 Tectonic／Typst，不自动安装编译器或在本地执行远程 Host 的请求。Tectonic 仅使用已有缓存；Typst 遵循已安装 CLI 的包缓存与下载行为，联网或依赖失败保留编译诊断和 Source。Typst 的私有草稿 overlay 保留原工作区相对引用，产物进入原 PDF reader；用户文件与持久工作面不存储编译器临时文件或 PDF bytes。

## Git 仓库操作

中立 Git 模块是 [`packages/git`](../../packages/git/src/git-repository.ts)，不依赖 Renderer、Electron、AppConfig 或 Agent 生命周期。`GitRepository` 的所有调用都以数组传参。

- **路径与引用参数。** 路径经 `toLiteralPathspec` 加 `:(literal)` 前缀，并放在 `--` 之后。引用类输入（remote、分支、refspec）经 `assertSafeRef` 拒绝以 `-` 开头的值，以及 Git 本身禁止的控制、空白和 `~^:?*[` 字符。
- **未跟踪文件的丢弃。** 只有 `discard` 对未跟踪文件执行 `clean --force`，执行前先经 `assertInWorktree` 确认路径在 worktree 内。
- **状态。** `status` 读取 `git status --porcelain=v1 -z --branch --no-ahead-behind --untracked-files=all`，由 `parseGitStatusPorcelain` 按 NUL 分隔解析，路径不经 Git 的转义与再解码。Changes 只使用分支名和改动；精确分歧计数由同步状态的 `aheadBehind` 按有效上游独立读取。
- **diff。** diff 读取两侧原始字节：旧侧取 `HEAD:<path>`，新侧读工作区文件。二进制由字节中的 NUL 判定，超过 `MAX_DIFF_BYTES`（2 MiB）的内容也按二进制报告；读不到时报告失败，不回落到 HEAD。
- **远程操作。**
  - `push` 默认推送 `origin HEAD` 并带 `--set-upstream`，只在显式选项下加 `--force-with-lease`；
  - `pull` 映射 ff-only／merge／rebase；
  - `fetch` 带 `--prune`；
  - 远程调用使用非交互环境 `GIT_NONINTERACTIVE_ENV`。
- **ahead／behind。** 私有方法 `effectiveUpstream` 用 `for-each-ref --format=%(refname)%00%(push)%00%(upstream)` 读取 push 与 upstream 目标，先取实际存在的 push 目标，再取存在的 upstream；探测失败抛出错误，不当作无上游。
- **错误文本。** 所有向上传递的错误文本先经纯函数 `scrubGitCredentials`：擦除 http(s) URL 的全部 userinfo，包括整段 userinfo 就是 token 的写法；ssh 的 `git@host` 保留。远程错误由 `classifyGitRemoteError` 分类。

## PR 创建

- **入口与认证。** Main 的 [`GhService`](../../apps/desktop/src/main/gh-service.ts) 只经 `gh` CLI 创建 PR。认证只探测 `gh auth status`（`authStatus`），AgentMux 不读取、不保存 token。
- **创建。** `createPullRequest` 依次执行：
  1. 以 `assertSafeGhRef` 校验 base 与 head；
  2. 以 `remoteBranchPresence`（`git ls-remote --exit-code --heads origin`）区分 present、absent 与 unknown，只有 present 才继续，unknown 也拒绝；
  3. 把正文以 `0o600` 写入临时文件，用 `gh pr create --body-file` 传入，结束后删除临时文件；
  4. 不重试创建。
- **就绪检查。** `prReadiness` 把同一次远端探测用于 Renderer 的资格提示。
- **运行令牌。** Renderer 的 [`create-pr-intent.ts`](../../apps/desktop/src/renderer/src/lib/create-pr-intent.ts) 以 `CreatePrToken`（worktreeId、worktreePath、branch、baseRef、startedAt）冻结点击时的目标，`evaluateCreatePrIntent` 的判定为：
  - 用户切到另一个 worktree 时为 `proceed-detached`，运行继续针对原 worktree；
  - 同一 worktree 内的分支或 base 漂移时为 `conflict`。
- **一次读取的决策。** [`pr-launch.ts`](../../apps/desktop/src/renderer/src/lib/pr-launch.ts) 从同一次 readiness 读取同时得出资格判断与令牌，避免两份推导漂移。

## Worktree 与扇出

- **创建 worktree。** [`WorktreeService.createForBranch`](../../apps/desktop/src/main/worktree-service.ts) 先执行 `git worktree add`，Git 成功后才写仓库卫生规则并登记 Workspace，失败的创建不会留下指向不存在目录的记录。
- **仓库卫生。** 卫生规则由 `excludeWorktreeRootFromStatus` 写入：
  - 用 `git rev-parse --path-format=absolute --git-common-dir` 定位所有 worktree 共用的 Git 目录，在其 `info/exclude` 中追加锚定在仓库根的 `WORKTREE_EXCLUDE_LINE`（`/.worktrees/`）；
  - `grep -qxF` 保证幂等；原文件非空且末字节不是换行时先补换行，避免与用户最后一条规则粘连；
  - 路径与规则作为 `sh` 参数传入，不拼进脚本文本。
- **当前实现：卫生写入失败被静默吞掉。** `excludeWorktreeRootFromStatus` 忽略返回值，并在 `catch` 中不做任何处理（注释写明 "Deliberately silent"）。设计要求这类失败要提示降级，当前实现没有满足，已登记为实现缺口。
- **默认路径的两份推导。** worktree 默认位置是 `<仓库根>/.worktrees/<清洗后的分支名>`，目前有两处推导：
  - Branches 面板用 Renderer 的 [`defaultWorktreePath`](../../apps/desktop/src/renderer/src/lib/workspace-projects.ts)（基于 `snapshot.repoPath`）；
  - 扇出由 [`runFanOutRequest`](../../apps/desktop/src/main/fanout-request.ts) 以 `join(branches.repoPath, '.worktrees')` 作为各路根。

  两处都以仓库根而不是 Workspace 路径为基准（子目录被注册为 Workspace 时，以子目录为基准会落出锚定规则的范围），但仍是两份推导，这是设计中登记的缺口。
- **扇出编排。** [`planFanOut`](../../apps/desktop/src/main/fanout-plan.ts) 把各路命名为 `<stem>-<n>`；[`runFanOut`](../../apps/desktop/src/main/fanout-run.ts) 按顺序逐路创建：
  - 每一路先读取当前配置，登记后经 Main 的配置 owner 发布，不在开头快照、结束时整份覆盖（回归测试 `apps/desktop/test/fanout-config-lost-update.test.ts`）；
  - `runFanOutRequest` 把只有一路的计划原样交还普通启动路径，不进入比稿编排。
- **留一路、拆其余。** `WorktreeService.keepOneOfFanOut` 与 `removeWorktree` 执行；`removeWorktree` 用 `git status --porcelain` 检查未提交改动，有改动的那一路以 `WorktreeRetainedError`（`uncommitted-changes`）保留，丢弃须逐路显式传入 `discardChanges`。

## 书签文件

书签格式的纯逻辑在 [`shared/bookmark-file.ts`](../../apps/desktop/src/shared/bookmark-file.ts)，Main 专属的一步在 [`main/bookmark-file.ts`](../../apps/desktop/src/main/bookmark-file.ts)：

- `BOOKMARK_FILE_EXTENSIONS` 是可识别扩展名的唯一来源（`webloc`、`url`），`BOOKMARK_FILE_MAX_BYTES` 是本地与远端读取共用的 4 MiB 预算。
- `readBookmark` 一次返回 URL 与 `binary`：二进制 `.webloc` 经 `/usr/bin/plutil -convert xml1` 转成 XML 再取 URL（`readWeblocUrl`），`.url` 只按文本解析。
- 保存时由 `emitWebloc` 只写 XML plist，不写二进制格式。

## 提交作者头像

[`GitAuthorAvatar`](../../apps/desktop/src/renderer/src/features/git/commit/GitAuthorAvatar.tsx) 用提交记录中的作者邮箱拼出 `https://avatars.githubusercontent.com/u/e?email=…&s=64`，以 `referrerPolicy="no-referrer"`、`crossOrigin="anonymous"` 加载。

- 缓存：成功 24 小时后复查，失败 5 分钟内不重试；进程内最多保留 128 条记录，图片字节由 Chromium 的 HTTP 缓存持有。
- CSP：独立工作面窗口（[`workbench-window.html`](../../apps/desktop/src/renderer/workbench-window.html)）的 CSP 在 `img-src` 中显式列出该域名；主窗口（[`index.html`](../../apps/desktop/src/renderer/index.html)）的 `img-src` 允许任意 `https:`。
- 当前没有关闭这项查询的设置。
