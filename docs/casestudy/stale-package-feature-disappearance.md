# 功能已经做过，界面却像没做过：启动了旧 App 包

## 定性

P1。本案范围是 macOS 安装包的安装与启动路径：正在运行的 AgentMux 实例与当前源码不是同一份，已合入的功能在界面上“消失”。用户因此在旧版本上工作，并容易把现象误判为“并发 Agent 把代码回滚了”，进而重写已有功能或追责他人；但没有证据表明 Session、工作面或用户数据受损，Git 历史也完整，所以不定为 P0。

本案有两种形态：第一次是磁盘上的安装副本本身就旧；复发时磁盘副本是新的，仍在运行的进程却来自旧副本，见[复发](#复发磁盘是新的进程是旧的)。文末当时提出的强制退出升级方案已被现行约束取代，见[改进措施 6](#改进动作承接上面第-3-条补上进程那一侧)。

## 用户可见症状

第一次：用户看到 Scratch／Topic 的体验退化——Topic 隔离、Topic Agent 头像、底部状态栏与资源统计、新建 Tab 继承当前 Topic 等功能像是从版本里消失。原话未保留。

复发时的原始报错见[复发](#复发磁盘是新的进程是旧的)：终端里点击链接弹出 `Do you want to navigate to …? WARNING: This link could potentially be dangerous` 的原生框。

两次症状属于同一根因（运行实例与源码身份不一致），但失败形态不同：第一次是磁盘副本旧，复发是进程旧。

## 影响面

**坏了什么**：正在运行的实例缺少已合入的功能，用户看到的行为与当前源码不一致。第一次涉及的功能在当前 main 上分别由以下提交承载：

- `9efbf25092`：workbench 隔离 Topic tabs
- `fa5113bdcc`：Topic Agent 头像
- `bd11984bfd`：按 Provider 的状态栏
- `3c0166583e`：Board 工作清单
- `57f9a5f4d5`：每个 Agent 的 CPU／内存面板
- `316066edb5`：Agent 与 Tab 名称
- `f5318e767a`：新建 Tab 留在当前 Scratch Topic

**以下不受影响**：

- Git 历史没有回滚：当时的 reflog 只有正常前进的提交，没有 `reset`、`rebase` 或 force update；被怀疑的历史 main tip 都是当时 tip 的祖先。
- 源码没有丢功能：上面每个功能都能在 main 历史中找到。
- 没有证据表明 Session、工作面或用户数据受影响；问题只在运行哪一份 bundle。

## 止血措施

先核对正在运行的这个窗口来自哪份包：读取运行进程的真实 executable path 和包内 `package-identity.json` 的 `sourceCommit`／`sourceTree`，与当前 main 比对。身份不一致时，正常退出旧实例，从 canonical 安装路径 `~/Applications/AgentMux.app` 启动当前候选，并核对实际加载身份，做法见 [macOS 打包与安装《最短交付路径》](../guides/macos-packaging.md#最短交付路径)第 4 步。不要为此重写代码、删除用户数据或停止健康 Run。

## 引入时间线

本案不是某次提交引入的代码缺陷，而是运行了旧包。时间线记录包身份与功能提交的关系：

- 当时运行的旧 `/Applications/AgentMux.app` 中，`package-identity.json` 记录的 `sourceCommit` 早于上面第一批功能提交；审计时用 `git merge-base --is-ancestor <sourceCommit> HEAD` 确认它仍在当时的历史中，用 `git log --ancestry-path <sourceCommit>..HEAD` 列出其后落地的功能提交，它比当时的 main 落后 84 个提交。该 `sourceCommit` 在后续历史清理后无法在 main 上唯一定位，本文不再给出它的哈希。
- 功能本身没有被删除，而是从未进入正在运行的那份 bundle。

## 根因分析

- **直接原因**：启动的是旧安装副本。仓库里的 `apps/desktop/release/` 和 `apps/desktop/out/` 可能来自不同时间；启动路径如果拿了旧 `release`、开发缓存或 `/Applications` 下另一个同名 App，即使当前 checkout 已是最新，用户仍会看到旧行为。
- **根因**：判断“功能在不在”时，流程只核对源码和版本号，没有把运行实例的包身份当成事实来核对。安装与启动又没有唯一入口，多份同名副本可以并存而不报告。
- **为什么没被更早发现**：当时没有包身份文件，也没有比较候选、安装副本和运行进程的工具；功能“消失”的第一反应是查 Git 历史，而不是查正在运行的是哪份 bundle。

## 改进措施

以下是当时采取的动作。现行打包与安装做法以 [macOS 打包与安装](../guides/macos-packaging.md) 和 [Desktop updates《Artifact identity》](../architecture/desktop-updates.md#artifact-identity) 为准；并发协作中的提交边界见 [AGENTS《并行协作与交付》](../../AGENTS.md#并行协作与交付)。

1. **把包身份当成事实，不把版本号当事实。** 每个候选写入 `sourceCommit`、`sourceTree`、应用版本、平台和架构；安装前后以及运行 ready receipt 核对同一组字段。
   - 是否足够 root：覆盖“磁盘副本身份不明”这一类；不覆盖“磁盘新、进程旧”，复发证明了这一点。
   - 能否彻底避免：只能更早发现装错包，不能阻止启动错副本。
   - 是否降低系统熵：增加一份身份文件；被否掉的更简方案是只看版本号，它无法区分同一版本号下的不同源码。
2. **收敛唯一发布入口。** 只接受同一次 clean build 产生的 `apps/desktop/release/mac/AgentMux.app` 和同批 DMG；`out` 是构建中间产物，旧包和临时 App 不能直接安装。
   - 是否足够 root：覆盖 `release`／`out`／临时 App 混用这一类入口。
   - 能否彻底避免：本可阻止安装中间产物或旧产物。
   - 是否降低系统熵：降低，删去多个可安装入口。
3. **收敛唯一安装与启动路径。** 安装到 canonical `~/Applications/AgentMux.app`；排障时同时读取运行进程的真实 executable path。同名副本只报告 mismatch，不把它解释成源码回滚，也不删除用户数据。
   - 是否足够 root：覆盖“多份同名 App 并存”这一类；进程侧的旧实例由复发段的措施补齐。
   - 能否彻底避免：本可阻止从错误副本启动。
   - 是否降低系统熵：降低，只保留一个安装位置。
4. **发包前做功能来源审计。** 对关键能力核对“设计约束 → 生产实现 → 测试调用者”；只有运行 bundle 与当前源码身份一致仍缺功能时，才进入删除或替代调查。现行调用链检查方法见[测试策略](../testing/strategy.md#任务验收与假绿防护)。
   - 是否足够 root：只覆盖发包前的已知关键能力。
   - 能否彻底避免：只能更早发现，不能阻止运行旧包。
   - 是否降低系统熵：增加一步审计；被否掉的更简方案是“看到功能缺失就先查 Git 并重写”，它把运行身份问题误当成代码问题。
5. 并发协作的提交边界现归 [AGENTS《并行协作与交付》](../../AGENTS.md#并行协作与交付)。

## 验证

- `pnpm --filter @agentmux/desktop report:package`：比较候选、canonical 安装副本、其他同名副本和运行 executable path 的 `package-identity.json`，确认是否启动了错包。
- `git merge-base --is-ancestor <sourceCommit> HEAD` 与 `git log --ancestry-path <sourceCommit>..HEAD`：确认包对应的源码提交在当前历史中，并列出其后落地的提交。
- `git reflog`：确认没有 reset／rebase／force update，排除历史被回滚。
- 进程侧守卫：`pnpm exec vitest run apps/desktop/test/package-install-restart.test.ts`，判据见复发段改进动作 7。当时针对含信号升级的旧实现用 7 个变异验收，各自只打红一条；把承重的那次等待换成 `remaining = []` 时，只查函数名是否出现的判据 5 条全绿。现行实现已无信号升级，承重以当前测试为准。

## 遗留

以下按本复盘时（`d062cb1655`）的状态记录；锚点之后的变化逐条注明提交。

- **PARTIAL：旧包的源码身份。** “旧包早于功能提交、落后 84 个提交”只来自当时的审计输出，现已无法复核。按标题匹配到的 `bacd8d6925`，以及历史清理前的旧对象 `3809d360c9`（main 上不可达），都已包含上面 7 个功能提交，与该结论矛盾，所以本文不给哈希。
- **强制退出升级方案。** 本复盘时，`quitInstalledApplication`（`apps/desktop/scripts/package-macos.mjs`）在优雅退出超时后依次发 SIGTERM、SIGKILL。锚点之后，`0589bf6267` 去掉了这段信号升级，并让测试断言该函数体不含 SIGTERM／SIGKILL；`44462e9953` 与 `445f473ce6` 随后把复发段措施 6 标为已废止。

## 复发：磁盘是新的，进程是旧的

同一根因的第二种形态。用户报告：在终端里点击 Claude Code 输出的链接，没有出现目的地选择器，而是直接弹出 `Do you want to navigate to …? WARNING: This link could potentially be dangerous` 的原生框。这一次磁盘侧每一项校验都通过：`package-identity.json` 的 `sourceCommit` 指向当时最新的 main，即包含 OSC 8 链接修复的提交（该修复在历史清理中并入 `d062cb1655`）；打包时 `source_status=clean`；包内 renderer bundle 里两条 link provider 都在，并指向同一个 activate 出口；xterm 只打包了一份。

真正的原因是正在运行的进程：主进程在安装前三小时十九分已经启动，安装时仍未退出。`installApplication`（`apps/desktop/scripts/package-macos.mjs`）用 `rename` 原子替换目录，旧目录整体移入 `~/.Trash`；已运行的进程按 inode 持有已打开的文件，目录改名不影响这些 inode，于是旧实例从废纸篓里继续运行，没有任何报错或提示。安装步骤当时只输出 `installed_app=` 和 `previous_install_trashed=`，没有一行提示“还有旧实例在运行，你验证的不是这个包”。

第一次给出的五条改进动作全部落在磁盘身份上（写入身份文件、收敛发布与安装路径、`report:package` 比较副本、发包前来源审计）。第一次的失败形态是“装了旧包”，磁盘本身是旧的，查磁盘就能发现；这一次是“装了新包但旧进程仍在运行”，磁盘是新的，那五条动作都不会触发。排查因此绕了远路：沿用本文当时的方法，三层验证都在验磁盘。

### 诊断信号（从快到慢）

1. **报错行里的 chunk 名。** 用户贴来的一条无关 xterm 报错是 `at index-BZqWMMh5.js:47172`，而已安装包里的对应 chunk 叫 `index-B2vn2ya2.js`，可以直接区分。`find` 找不到前者也是佐证：旧文件已被替换，只存在于进程内存中。运行时自报的身份比从磁盘推断的身份更可信。
2. **进程启动时间与安装时间。** 用 `ps -eo pid,lstart,args | grep 'AgentMux.app/Contents/MacOS/AgentMux'` 对比 `stat -f '%Sm' ~/Applications/AgentMux.app`。必须过滤掉 `Helper`：renderer helper 崩溃重启会换 PID、启动时间看起来很新，但仍来自同一份已加载的 app，这一点当时误导了一轮排查。
3. **`ps` 中 ctxmuxd 的路径**指向 `${PACKAGE_TEMP_ROOT}/…`，说明该实例由旧包启动。

### 改进动作（承接上面第 3 条，补上进程那一侧）

6. **历史方案已废止：曾建议优雅退出超时后升级到 SIGTERM／SIGKILL。** 当时的完整方案是请求旧实例退出、等待进程消失、替换目录、重新拉起并核对进程身份；其中的强制升级不能作为当前操作步骤。现行安装沿 [Desktop updates《Restart boundary》](../architecture/desktop-updates.md#restart-boundary) 正常退出，超时就停止安装，保留原应用、工作面与健康 Run。已安装目录与实际加载身份仍须分别核对，目录替换不代表新代码正在运行。

7. **判据是执行顺序，而不是文本在场。** 守卫是 `apps/desktop/test/package-install-restart.test.ts`，它解析 `installApplication` 与 `quitInstalledApplication` 的 AST，按调用位置判断顺序：
   - 退出旧实例（`quit`）必须早于 `rename(next, destination)` 这次目录切换，重新拉起（`launch`）必须晚于它；
   - 上一次安装的进程存活时，安装必须明确失败；
   - 请求优雅退出后必须等进程真的消失，旧实例未退干净就不能继续；函数体内不得出现信号升级（断言 `not.toMatch(/SIGTERM|SIGKILL/)`）；
   - 自检：把退出和重新拉起两次调用从源码中删掉——这正是本次事故的源码形状（只换磁盘，不管进程）——守卫必须能识别出来，避免空集合假绿；
   - 本节标题、`rename` 与 `inode` 机制以及守卫文件名由同一测试核对，保持文档与检测器可以互相追溯。

   文本 `toContain` 在这里不够：只检查某个函数名“出现过”，无法发现承重的那次等待被去掉。
