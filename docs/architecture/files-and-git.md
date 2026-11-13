# 文件与 Git 的实现

本文说明 Desktop 读写 Workspace 文件、移动与改名、Git 仓库操作、PR 创建、worktree 与扇出的当前源码机制，以及书签文件与提交作者头像的读取方式。必须成立的行为约束见[文件、编辑与 Git](../design/behavior/files-and-git.md)，分层归属见[系统职责地图](system-ownership.md#从哪一层接入)。源码机制不代表某个安装或运行实例已通过验收。

## 文件读写与修订

Desktop Main 的 [`WorkspaceFiles`](../../apps/desktop/src/main/workspace-files.ts) 是 Renderer 读写 Workspace 文件的唯一入口。它持有 Workspace Root 约束、磁盘 revision、单文件观察和磁盘错误事实；普通文件的原子写入委托给 [`OrdinaryWorkspaceFiles`](../../apps/host/src/ordinary-files.ts)。Shared contract（[`contracts.ts`](../../apps/desktop/src/shared/contracts.ts)）与 preload 只暴露 typed read、write、observe 和 move。

- **读。** `read` 返回内容与不透明 revision。
- **写。** `write` 必须带读取时的 `expectedRevision`，结果类型 `WorkspaceFileWriteResult` 为 `written`、`conflict`、`error` 或 `unknown`。替换之后才丢失回执时返回 `unknown`，不解释成明确未写入。
- **原子发布。** 原生写入（[`workspace-file.inc`](../../apps/host/native/workspace-file.inc)）在同一目录以 `O_CREAT | O_EXCL | O_NOFOLLOW` 创建临时文件，写入后 `fsync`，再发布并 `fsync` 父目录：
  - 覆盖已有文件用 `rename`；
  - `expectedRevision` 为 `null`（新建文件）时用 `link` 独占发布，目标已存在就失败，不会覆盖别人刚建的同名文件；
  - 临时写入或发布失败时删除临时文件，原文件字节不变。
- **竞争窗口。** revision 是乐观并发信号。最终 revision 复核与原子替换之间仍存在外部进程的竞争窗口，当前实现不提供跨进程 compare-and-swap。
- **观察。** Main 的观察只发布 `WorkspaceFileInvalidated`（`{ workspaceId, path }`），Renderer 收到后重新 read。远端 Workspace 的单文件观察返回 `REMOTE_WORKSPACE_FILE_OBSERVATION_UNSUPPORTED`。

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

## Git 仓库操作

中立 Git 模块是 [`packages/git`](../../packages/git/src/git-repository.ts)，不依赖 Renderer、Electron、AppConfig 或 Agent 生命周期。`GitRepository` 的所有调用都以数组传参。

- **路径与引用参数。** 路径经 `toLiteralPathspec` 加 `:(literal)` 前缀，并放在 `--` 之后。引用类输入（remote、分支、refspec）经 `assertSafeRef` 拒绝以 `-` 开头的值，以及 Git 本身禁止的控制、空白和 `~^:?*[` 字符。
- **未跟踪文件的丢弃。** 只有 `discard` 对未跟踪文件执行 `clean --force`，执行前先经 `assertInWorktree` 确认路径在 worktree 内。
- **状态。** `status` 读取 `git status --porcelain=v1 -z --branch --untracked-files=all`，由 `parseGitStatusPorcelain` 按 NUL 分隔解析，路径不经 Git 的转义与再解码。
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
