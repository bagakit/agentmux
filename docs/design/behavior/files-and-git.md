# 文件、编辑与 Git

本文集中本主题的交互与行为要求。已确认约束定义必须成立的结果，不代表当前实现通过验收；提案、历史与当轮授权状态按正文的明确范围阅读。

[返回交互合同](../agentmux-desktop-interaction.md) · [同主题视觉](../presentation/files-and-git.md)

**本页章节**

- [Explorer 与 Editor](#explorer-与-editor)
- [扇出比稿](#扇出比稿)
- [Git 源码控制与 PR](#git-源码控制与-pr)
- [Explorer 的真实文件与快捷键入口](#explorer-的真实文件与快捷键入口)
- [本地文件预览与按格式编辑](#本地文件预览与按格式编辑)
- [文件打开目的地](#文件打开目的地)
- [Branch Pin 的层级与操作位](#branch-pin-的层级与操作位)

## Explorer 与 Editor

- Explorer 以 Selected Worktree 为根，使用层级目录、文件夹优先排序、多选、键盘导航、Reveal、刷新和受 Workspace Root 约束的文件操作。Move 当前明确为单项操作：Pointer drag 在开始时收敛到被拖动项；Context Menu/`Shift+F10` 使用 `Move This Item to` 子菜单，并在执行时收敛到该项，不用多选外观暗示尚未实现的批量移动。
- Stale response 不能覆盖新 Workspace 或新目录 revision；刷新期间保留现有内容，直到新结果原子替换。
- **打不开的文件必须给出一个能落地的出口，而不是只说"打不开"**。Editor 的失败态除文案外提供一个 Reveal 动作，经**既有**的揭示通路落地，不新增第二条 IPC 或第二套路径解析。揭示目标对**已删除的文件回退到最近的存在的祖先目录**——文件已被删除正是"打不开"最常见的成因，揭示父目录仍然回答了用户的问题（它不在那儿了），而报一个二次错误没有回答任何问题；回退的每一步仍做根内约束校验，不得借符号链接逃出 Workspace 根。远端（非 local host）Workspace 下不提供该动作：那条通路对非 local host 必然失败，**以缺席表达而非画一个禁用的假按钮**。揭示失败经既有 reportError 浮现，不静默吞掉，也不把编辑器面板替换成第二个错误态。
- Desktop Main 是 Workspace 文件与磁盘版本的唯一事实 Owner；`packages/core` 不承载文件服务，
  Renderer 不直接读写磁盘，也不维护第二份文件 revision 或 watcher truth。
- 打开文件时由 Main 返回内容与不透明 revision；保存必须携带读取时的 revision，并由 Main 在
  Workspace Root 约束内原子替换。磁盘内容已经变化时保存必须明确冲突并保留编辑草稿，不能静默覆盖。
- 外部工具或 Agent 修改已打开文件时，由 Main 发布权威变更。无本地草稿的 Document 自动读取新
  revision；有本地草稿的 Document 保留草稿并进入明确冲突状态，不能假装保存成功或悄悄回退内容。
- 文件 Rename 和删除先由 Desktop Main 完成磁盘操作；成功后，Renderer 用一次纯 reducer 原子更新 Document、Dirty、Last Active、Tab Group、View/Region 路径以及当前 Workspace 的 Explorer Selection/Expanded 投影。路径映射若会占用已有 Tab、Document 或 Region owner，Renderer 会在请求磁盘操作前拒绝。
- 路径映射使用 segment-aware 子树判断。受影响保存先被 mutation admission 阻止并等待静止；磁盘失败或最终位置未知时不提交 Renderer 映射。active-file auto-reveal 若 Selection 已含该路径且 ancestors 已展开，必须原样返回并跳过 Store 写；确需 Reveal 时只原子补齐 ancestors，并保留包含 active path 的现有多选。
- Drag 与菜单从同一份已加载文件树 facts 预计算 Move plan；同 parent、自身或后代目标、已加载的 destination collision 不显示为可提交目标，也不依赖 Main 最终拒绝来代替交互计划。
- Darwin Local move 使用同一 Desktop owner 构建和分发的原子 no-replace helper，同时执行 Workspace Root-relative、no-follow 和 no-clobber 约束。Renderer 的 Rename、Drag 和菜单入口使用同一 move transaction；helper 缺失或平台无法满足合同会明确返回 typed unsupported，不回退到普通 `rename`、`mv`、重试或事后回滚。
- Main 只有在 helper 明确成功时返回 `moved`，明确未提交时返回 `finalLocation: source`；commit 后回执缺失始终返回 `finalLocation: unknown`，不得用 source/destination pathname occupancy 猜对象身份。Renderer 对成功或 unknown 并发、去重重读恰好 source/destination 两个 parent，对确认留在 source 的失败不刷新；unknown 仍不提交路径投影。
- 内置 Editor 保存 Topic 的 `topic.md` 后使 Topics 文件系统快照失效并重读，不建立第二份 watcher 或 Renderer Topic Registry。
- Monaco 只声明当前真正注册的语言能力；未知或未注册语言回落 plaintext，不伪造 tokenizer。

### Revision-aware 保存与外部冲突

- Desktop Main 的 `WorkspaceFiles` 独占 Workspace Root confinement、磁盘 revision、同目录临时写入、同步、mode 保留、原子替换、单文件观察和磁盘错误事实。Shared contract 与 preload 只暴露 typed read、write、observe 和 move 能力。
- Read 返回内容和不透明 revision。Write 必须携带 expected revision，只返回 `written | conflict | error`。Remote workspace 无法满足同一原子保存合同时返回 typed unsupported。
- 临时写入或替换失败会清理临时文件并保持原文件字节不变。普通文件系统 revision 是 optimistic concurrency signal；最终 revision 复核与原子替换之间仍存在外部进程竞争窗口，不宣称强跨进程 compare-and-swap。
- Renderer 持有 Monaco buffer、dirty、保存 generation、observation generation、document lifetime 和冲突交互。每文件保存串行化；保存期间继续输入时旧 written 回执只更新落盘 revision，不清除更新后的 buffer 或 dirty。
- Main observation 只发布 `{ workspaceId, path }` 失效事实，Renderer 重新 read。Clean buffer 自动采用新内容与 revision；dirty buffer 保留草稿并进入 changed/deleted conflict；read error 保留最后 buffer且不能伪装成删除。
- Reload 明确采用 observed disk state。Overwrite 使用最近一次 observed revision；若磁盘再次变化则继续 conflict。旧 save/read completion 不能越过 close、reopen 或 move 的 lifetime 边界修改新文档 owner。

## 扇出比稿

- 一个 prompt 扇出 N 路：从当前 HEAD 起 N 个新分支、各自一个 worktree、各跑一个 Agent，比较哪一路更好后留一路、拆其余。整套编排归 **Desktop Main**：它只按顺序调用已有的公共命令（worktree 创建、单条 Agent 启动、worktree 拆除），不引入新的运行时事实。**发起与收尾复用既有的单一 IPC 与导航路径，不新增第二条**：发起一次扇出＝依次调用既有的 worktree 创建与单条 Agent 启动；「留一路、拆其余」＝保留所选那一路、其余经既有拆除原语移除；跳转任一路仍走既有 `selectSession`——没有专属于扇出的第二套 IPC、导航或错误状态机。这条竖切的完成标准是**端到端可达**：用户能发起、也能收敛。只做出编排原语与比稿展示面却没有发起入口，是一段测得很好却用不到的代码，不计为已交付。
- **Core 不拥有 coordinator loop**。`packages/core` 只认识单条 Agent Session；"同时跑 N 条并收敛"不是 Core 的概念。把这个循环放进 Core 会让它凭空多出一个它并不持有的生命周期对象——批处理编排是 Desktop Main 顺序调度公共调用的结果，不是 Core 的第二种 Session 语义。lane 顺序创建（并发 `git worktree add` 会争抢同一 index 与 metadata，config 也逐路串行穿过每次注册），Agent 一旦启动即并发运行——用户要的并行发生在这里。
- **默认 worktree 落在项目内，且只有一处出处**。为某个分支新建 worktree 时，默认位置是项目自身的隐藏子目录 `<项目>/.worktrees/<清洗后的分支名>`，而不是与项目同级的兄弟目录——它随项目目录一起被移动或删除、并出现在项目自身的文件树里，因为它本就属于这个项目；仓库卫生由后面的 clone-local `info/exclude` 约束。这条默认路径只由**一处**推导：Branches 面板取默认值、扇出取各 lane 的 worktree 根，都经同一个出处得出，任何调用点都不得再自行拼第二份默认位置。扇出把各 lane 建在其 worktree 根下，该根必须解析到同一个项目内 `.worktrees` 目录，不另立第二处真相。分支名先收敛为路径安全字符、空名回落为固定占位，使目录名不泄露分支里的路径分隔符。
- **项目内的 worktree 是工具产物，不能把用户仓库弄脏**。创建成功后，产品应把项目内 `.worktrees/` 根目录写入该 clone 的 Git `info/exclude`（幂等、可重复执行、已有内容和无换行文件都要保留），而不是修改用户跟踪的 `.gitignore`。这条卫生动作失败只提示降级，不得阻断已经成功的 worktree 创建；验收以真实 `git status --porcelain` 为准，而不是只检查是否发出了写入命令。
- **移除 worktree 前要把留下来的分支事实说清楚**。普通确认框必须明确签出目录会被移除、分支仍保留；若 Git 能数出相对权威 base 的独有提交，显示数量和分支名；若 base 只是猜测或探针失败，明确说“无法核实”，不得把未知伪装成安全。这个提示只帮助用户决定，不得因为探针超时或失败阻断移除；未提交改动仍由既有脏树保护单独拦截。
- **移除确认框的 retention note 必须到达最终正文**。生产者、IPC 和面板转发都不是完成标准，只有用户真正看到 note 才算闭环；未询问到时保持空白，探针明确给出“无法核实”时必须原样呈现。丢弃未提交改动的二次确认不得混入这条分支留存提示。
- 一路失败绝不掀翻其余：扇出返回逐路结果而从不为某一路抛出。区分三态——已启动、worktree 建成但 Agent 未起（明说 worktree 是否留在磁盘上，否则成为无主目录）、worktree 都没建成（无可清理）。逐路的部分失败经**既有** `reportError` 面浮现，不另建扇出专属的错误状态机。
- **分组是派生的，复用共享状态语汇**，不新建第二套。扇出计划把 lane 命名为 `<stem>-1`、`<stem>-2`……，stem 已经标识了这一组，因此比稿面从分支名推导分组，而不持久化 group id（持久化等于给分支名已经说清的事再开一份会漂移的注册表）。每条 lane 的状态点用与 StatusDot、关注栏同一套 class；点一条 lane 走与全局同一个 selectSession；"跳到最早观察到待办的一路"与关注栏"跳到最早的"同序。没有比较时整条 strip 不占空间。
- **留一路、拆其余**：用户指定保留的那一路，worktree 与 Session 原样留下；其余各路经既有拆除原语移除，不写第二套拆除逻辑。**脏树保护仍然生效**——有未提交改动（含未 `git add` 的产物）的那一路被拒绝、留在磁盘、留在记录集、并如实报告为 retained，绝不因为它没被选中就静默丢弃。要丢弃是逐路、显式的选择（`discardChanges`），批量收尾没有"一键丢弃所有脏 loser"的开关，因为那正是保护要消除的数据丢失杠杆。一路拒绝清理不阻断能清理的其余路。
- **扇出 v1 不自动合并胜者，不加入通用逐行批注**。扇出的状态比较与留一路、拆其余保持现有责任；已提交的两条分支差异复用下面 Git 源码控制的比较入口，不另建 Git owner 或 Review 系统。

## Git 源码控制与 PR

- **已经提交的两条本地分支也必须能比较**。从现有 Branches 工作面明确选择 A、B；默认看 B 从共同祖先分叉后的改动，也可明确选择 A 与 B 两个提交的差异。比较不签出、不改工作树、不创建 worktree，不触发 Agent。一次结果固定两个 commit 和实际比较起点；分支随后移动不能混入同一结果，显式刷新才产生新快照。
- **只读比较面仍是可寻址的真实 Region**。Control 用通用只读 view 表达这种工作面，不伪装成磁盘 File、Launcher 或 Agent，也不因它的存在让整个 Tab 无法 inspect。Git 快照与 blob 仍归 Desktop，Core 只持有通用 Region 身份。Tab/Region 地址沿用既有短的不透明身份并持久保存；比较的去重与逻辑身份由已有 Tab 中的完整快照和文件事实决定，合法长路径不能撑破地址协议，也不另建比较身份表。
- **比较先列小范围，再读取所选文件**。路径逐字保留，重命名旧侧使用原路径；只读取被打开文件两侧的固定提交。真实缺席才是新增或删除的空侧，读失败、无共同祖先、超限或桥不可用必须说明，不能当作零改动或暗换 HEAD。单个比较失败不影响其他编辑面或健康 Agent。
- **固定比较是独立只读工作面身份**。同路径的不同快照与普通脏编辑文档必须能共存，不对比较面执行文件 attach/save/watch。复用现有 Diff、Tab、Region、布局和持久化，只保存比较 descriptor，不保存 blob 或第二份比较注册表；重启先恢复原面与焦点，再读同一快照。对象不可读取时原身份保留并给出原因。

- **本地**：看到当前分支的改动（`status --porcelain=v1 -z`——`-z` 使 NUL 分隔、关掉 git 的 C-quoting，因此带空格、引号、换行或 CJK 字节的路径逐字到达，解析器永远不必解码），stage 单个文件、commit、结构化 diff、unstage、discard。**diff 读 blob 而非解析 unified-diff 文本**：旧侧取 `HEAD:<path>`、新侧读工作区文件，二进制由 NUL 扫描判定而非塞进文本字段；**读不到就是失败，不回落到 HEAD**——"读不到"正是渲染新增/删除文件的依据，被静默吞成空 diff 就再也分不清。
- **共享工作树的事故按案例回看**：并发 Agent 可以共享工作树，也可以共享 `git add`；别人的改动被一并带入提交本身不是失败，最终目标是所有 Agent 停止时 main 正确且协作吞吐最高。add 之后检查 `git diff --cached` 是为了知道本次提交的真实边界、识别半成品并及时协调，不是为了按作者拒绝内容。发现进行中的改动时不要用 `stash`、`reset --hard`、无明确范围的 `checkout` 或 `clean` 清场；自己的完整改动仍应尽快形成小提交。已发生的形状与证据集中在 [`docs/casestudy/`](../../casestudy)，这里记录约束，案例记录现象、根因和排查证据。
- **远程**：push（默认 `origin HEAD` 并 `--set-upstream`，`--force-with-lease` 永不裸 `--force`）、pull（可 pin ff-only/merge/rebase；未 pin 时对分叉自动回退为显式 merge，因为主机可能没有 reconcile 策略）、fetch `--prune`。**ahead/behind 对有效上游计算**：先解析 `@{push}` 再 `@{upstream}`，因此覆盖"分支 track `origin/main` 却 push 到 `origin/<branch>`"与"上游是本地分支"两种情形，不是只看配置上游。
- **PR**：`gh pr create`，正文写临时文件经 `--body-file` 传。**认证完全委托 `gh auth`**——只探测 `gh auth status`，AgentMux 不读取、不持久化任何 token（`gh` 自己继承 `GH_TOKEN`/`GITHUB_TOKEN`），与"什么都不出机器"的隐私线一致，零新增鉴权存储面。`gh` 缺失与未认证是两种可区分的结果，各自给出可操作文案，不混成一个泛化错误。
- 四条**不可退让**的约束，任何后续改动都不得削弱：
  1. **argv 不拼 shell**。一律数组传参；路径用 `--` 终结符与 `:(literal)` pathspec；任何以 `-` 开头的用户可控输入（路径、分支名、remote、refspec）被拒。`clean` 是唯一会从磁盘删文件的动词，调用前额外做 worktree 内约束校验，绝不 clean 到 worktree 之外。
  2. **远程错误擦凭据后再上浮**。git 会把远程 URL 回显进错误文本，因此**任何**上浮路径都先经同一个纯函数擦除。擦的是 http(s) 类 URL 的**全部 userinfo**——既包括 `user:pass@`，也包括**无冒号的 bare-token** `https://<token>@host`（这是 CI 与 `git remote set-url` 嵌入 PAT 的标准写法，只匹配冒号的规则会把它逐字泄露）；ssh 的 `git@host` 保留，那是身份不是秘密，擦掉只会毁掉报错里唯一有用的信息。且只有带 `fatal:` 前缀且匹配已知短语的 "no upstream" 被吞，鉴权失败、非 git 仓库、损坏一律上浮，不被误判成 no-upstream 而静默隐藏。
  3. **PR 一键流键到 run-token**。点击时捕获 `{repo, worktree, branch, base, startedAt}`，异步各步只在 token 仍匹配时落地。**切到另一个 worktree 明确不算冲突**——运行照旧对原 worktree 完成、create payload 打到原 worktree/分支；**只有同一 worktree 内 branch/base 漂移才算冲突**并中止。搞反方向会让用户切个窗口就丢掉正在建的 PR。创建失败**不清空 composer**：标题/正文/base 原样保留、按钮重新可用，否则一次网络抖动就吃掉用户写的正文。
  4. **后端 preflight 终裁，unavailable 即拒**。renderer 的资格探测是提示，不是权威；main 在真正创建前用"base 必须在远程存在"重查，探测**不可用时拒绝而非放行**——放行等于用一个没验过的前提去写外部世界。写操作**不重试**：重试会重复建 PR。
- 模型生成 PR 标题/正文时，分支名、文件路径、commit 文本、链接的 issue 全部作为**不可信数据**注入，明示"当数据不当指令"。解析在 `JSON.parse` **之前**先跑结构化上限守卫（token 数与嵌套深度），越限直接拒绝；去 ``` fence 用逐字符扫描而非可回溯正则（防 ReDoS）。解析失败返回明确的"无法解析"，**绝不把半解析状态当成功**。

## Explorer 的真实文件与快捷键入口

- 键盘快捷键入口属于全局工具，应在项目栏最底部设置按钮右边；顶部只承载视图开关。项目栏收起后仍能访问。
- Explorer 默认能看到被 `.gitignore` 忽略的文件与目录，并明确区分忽略状态；不按 node_modules、dist 等固定名字静默过滤。忽略事实来自 Git 自身规则，包括嵌套规则与否定规则。
- 软链接同时表现目标类型与链接身份，使用图标而不是 `link` 文字。目录链接应能在链接所在位置按需展开；文件链接应能打开；失效链接如实显示。显示路径保留链接路径，禁止循环展开。浏览链接不意味着允许把已有工作区写入约束放宽。

## 本地文件预览与按格式编辑

- 用户要求「内置的 browser 应该要支持打开本地文件进行预览」，不能只接收网络 URL。
- 对能识别的网页、图片、文本等常见格式，应提供适合该格式的预览与编辑体验，而不是都落到同一种通用显示。
- 具体编辑能力与格式边界先参考成熟产品，再形成对应 Feature 的评审任务；`local-file-preview-editors` 保留历史需求与验收记录，后续格式预览维护沿本节的同一 File / Browser 所有者闭合，不混入既有版本安装验收。

### Terminal 本机临时产物预览

用户反馈系统临时目录下的 html 链接 hover 无浮窗，点击无反应。本 Pane 所属资源 Host 确认是本机时，系统真实临时目录中的文件产物应有可辨链接和被动目标读出，点击后可在现有隔离 Browser 中真实预览 HTML 及其相对资源；Browser 已有可呈现格式沿原能力和诚实失败使用，不制造假 Workspace、第二 FileSurface 或另一套 Browser。该能力只补本机临时产物，普通源码、书签、正文 `file:` URI 与远端路径仍遵守各自原入口。

临时范围来自系统通用临时目录的本机事实，包括用户所指临时目录别名的系统真实归属；不能把任意根外绝对路径、其他 Host 或用户目录名当作临时目录。打开时须确认原 Workspace / Host 与目标文件未漂移，目标为实际存在的普通文件，词法路径和实际文件位置均在已确认的临时范围内，指向范围外的链接与非文件不能借临时入口通过。存在、文件种类与实际位置由 Main 的原本地文件边界持有；悬停和命中仍只消费本次相关终端字符与已知 Host / 路径事实，不做文件读取、存在探测、IPC 或全历史扫描。

预览使用原 Browser 的隔离与目的地 / 布局 owner；页面不能获得 App Renderer 权限。原源 Pane、Workspace / Host、Tab / Group / Region、阅读位置、草稿与健康 Run 保留，较晚结果不替换新选择或错投其他工作面。临时文件消失、类型不支持、Host 未确认或校验失败应通过原可达错误面说明真实原因与恢复动作，不能静默无反应或伪称预览成功；不自动改写原文件、扩大文本编辑 / 写入边界或重启 Agent。重启恢复原 Browser / 布局引用；临时文件已消失时保留原引用并诚实说明，不能把持久工作面清空。

### 本地链接的真实格式预览与二进制保全

用户反馈「本地PNG链接增加预览能力，其他相关缺失也补齐」，要求找到相关 Feature / worktree 后仔细分析并解决。链接已能打开文件，显示为普通文本不等于完成图片预览；本轮补齐常见格式的真实查看与不可预览边界，不扩成办公文件编辑器。

- 正文、Terminal 和文件树的打开动作沿同一文件入口，目标始终来自来源 Workspace / Host 与真实路径；切项目、切 Region 或较晚操作发生后，旧读取不能把结果投给新目标或抢回焦点。图片、媒体、Markdown 预览与源码沿原 File 身份，不额外复制 Tab、布局或文件内容所有者。SVG 换 File 的首个呈现也不得把旧文件图像标为新文件内容，不能等异步清理后才恢复身份正确。
- PNG、JPEG、GIF、WebP、BMP、ICO、AVIF 与 SVG 在当前引擎实际能解码时显示内容；图片有 Fit、原尺寸与缩放，小图默认不强行放大，放大后能连续查看完整图片。格式识别、字节读取成功与解码成功是不同事实；损坏或不支持的内容不能用空白面冒充预览成功。
- 音频与视频使用当前引擎真实可解码能力，有播放控制，不自动播放；离开可见工作面后暂停。PDF 只有实际原生预览显示成功才宣称可预览，插件 / 解码不可用时明确说明并保留外部打开动作，不以文件扩展名保证支持。
- Markdown 与 SVG 在同一 File 内切源码 / 预览，预览反映同一正文所有者的当前内容，包括未保存草稿；保存、冲突与回到源码沿原文件动作，不以磁盘旧版冒充当前效果。同 File 出现在多个 Region 时，任一视图切预览或关闭不能使其他 Source 模型消失；原 dirty 正文与各视图的选择、阅读位置保持，退出或换文件释放各自临时编辑资源。Markdown File Preview 的相对 href 按当前文件所在目录解析，仍限于原 Workspace 根边界；不能把嵌套文件的同目录链接错开到项目根，也不改变 Terminal / Agent 普通正文的原路径规则。显式 Markdown 图片与文件链接里的 URI 百分号编码目标须按一次解码打开实际文件，中文与 emoji 文件名同样可达；编码的空格不能让已明确的目标失去预览入口。原 Workspace / Host 与文档目录、越根拒绝和既有 scheme 边界保持，畸形编码不能绕过边界，不重复解码；未编码空格的含混 href、普通正文与裸 Terminal 的原严格识别不因此放宽。Markdown 不执行嵌入 HTML。HTML 的预览沿既有隔离 Browser 打开真实本地文件与相对资源，明确表示预览已保存文件，不能注入带 App 权限的 Renderer；未保存源码保持原状，不自动写盘或假称 Browser 已显示该草稿。显式 Save & Preview 才执行原保存，保存失败不宣称成功。
- 未知二进制由实际字节事实判定，不转换成损坏 UTF-8 文本或伪造空正文；保留原 File 身份并提供既有系统打开 / Reveal 入口，不出现会覆写原字节的文本保存动作。已知不可文本编辑的格式即使已有旧 Doc 或改名后遗留正文，也不能暴露文字编辑 / 保存入口；遗留 dirty 缓冲事实保留，呈现仍按真实格式预览或诚实说明不可预览。文件已删除、目录、读取失败、超出预览预算、内容变更、远程读取不可用与解码失败分别给出真实原因和可达动作，不以这些失败清空原工作面或阻断健康 Agent。
- 预览只为真正可见、相关的文件读取有界内容；字节不进入持久化工作面，不为无关 Session / 隐藏文件反复读取整份内容。采用现有字节边界与文件修订事实，不扩张已有远程能力或削减原可用文本能力。退出或换文件释放临时资源，重启从原 File / Workspace / 布局恢复可查看内容，原草稿、焦点与健康 Run 保留。

### 文件树目录作为项目打开

- 文件树目录的右键菜单提供“Open as Project”；文件行不显示这个动作。入口只把当前 Workspace 的 host 与目录路径交给既有 `workspaces:add`，不建立第二份 Project 注册表。
- 目录名作为默认 Project 名称，路径由当前 Workspace 根与目录相对路径派生。Renderer 的同路径快路径只用于减少一次请求；是否已注册由 Main 的归一化位置判定决定，尾斜杠、`.` 等等价写法不能产生重复 Workspace。
- 添加失败必须落到现有错误面；不能静默关闭菜单或让用户误以为项目已经打开。成功后选中新建或已存在的 Project。

### 书签文件（.webloc / .url，）

- 存书签「不要整页打包 就是保存个 link」：把当前页存成一个书签文件，不做整页归档。
- 打开书签「应该是默认 browser」：双击 `.webloc` / `.url` 在 AgentMux 自己的 Browser 里打开那个地址，不跳去系统浏览器。
- 「查看源码指的是书签文件本身的源码」，不是网页 HTML——网页源码 DevTools 已覆盖。所以这个入口回到文本路径打开那份书签文件。
- 「如果是 binary 就不支持切换到编辑, 如果是文件就支持」。二进制 plist 那一档的提示「绝对要极简, 比如就是按钮灰掉, hover 告知」——不弹框、不 toast、不加警告条。
- 二进制判定是主进程的事实，随书签内容一次取回；renderer 不重新读一遍字节（utf8 往返会损坏二进制 plist）。
- 用户复查「我记得之前的需求里面有一个可以预览保存在本地的 link 的，你找一找，看看它有没有完全实现？」：这里的 link 是上述单个标准书签文件；普通文件预览继续遵守[《本地链接的真实格式预览与二进制保全》](#本地链接的真实格式预览与二进制保全)。
- 书签打开后的 Browser 来源路径与二进制事实随原工作面持久保存；进程重启恢复后，文本书签仍可查看那份文件的源码，二进制书签仍沿上述在场禁用入口表达。原 URL、Tab、Region、焦点、分割布局与健康 Run 保留，不以重开新 Browser 或重新选择书签替代恢复。
- XML 书签的标准十进制与十六进制数字实体必须还原为真实 URL 字符；例如 `&#38;` 表示 `&`，不能把未解码实体中的 `#` 当作地址 fragment。原命名实体、URL 判定与正文保全继续成立。
- 本地书签字节读取与既有远端读取采用同一 4 MiB 预算；预算内保持原文本和二进制字节语义。本地明确超限的书签预览失败进入原错误面，该次打开不能自动退回普通文本路径再全量读取；不无界读入整文件后才拒绝，也不改写原文件或阻断健康 Run。普通解析／读取失败仍沿原文本路径，用户显式查看源码不削减既有文本能力。
- 长中文、emoji 与混合标题派生的最终保存文件名须不超过 255 UTF-8 bytes，完整字符、`.webloc` 后缀及重名避让均可用；不能按字符数冒充文件系统字节限制，不能覆盖已有文件或改动书签内的原 URL 正文。
- Netscape bookmark HTML 批量导入导出本轮不做：今天没有书签库，导进来无处安放。

## 文件打开目的地
文件点击也应进入统一的打开目的地选择器；目录点击保持 Explorer 导航语义。目的地目前使用有明确布局语义的四个基数方向与新 Tab，斜向按钮只有在布局 owner 能提供真实语义时才增加，不为凑齐九宫格制造无效动作；不可行目的地置灰并说明原因。

## Branch Pin 的层级与操作位

用户反馈「branch 被 pin 了以后，它的缩进不对」，且 Pin 按钮不应在没有 hover 时占用名称空间。固定分支仍归属原 Project；导航、组内顺序、折叠语义不变。Pin 操作只切换固定，不打开分支；鼠标悬停与键盘聚焦时均可发现和操作。视觉约束见 surface-density 的同名小节。
