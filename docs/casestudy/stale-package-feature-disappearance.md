# 功能已经做过，界面却像没做过：启动了旧 App 包

## 看到的现象

用户看到 Scratch/Topic 的体验退化了：Topic 隔离、Topic Agent 头像、底部状态栏与
资源统计、新建 Tab 继承当前 Topic 等功能像是从版本里消失。直觉很容易指向“并发
Agent 把代码回滚了”。

## 先排除什么

这次不是 Git 历史回滚：reflog 只有正常前进的提交，没有 `reset`、`rebase` 或 force
update；被怀疑的历史 main tip 都仍是当前 tip 的祖先。源码历史也能直接找到这些功能：

- `72369ef`：workbench 隔离 Topic tabs
- `466ad4e`：Topic Agent 头像
- `6a021dc`：按 Provider 的状态栏
- `c00f984`：Board worklist
- `0e6659f`：每 Agent CPU/内存面板
- `53bbb0e`：Topic/Agent/Tab 名称
- `5902240`：新建 Tab 留在当前 Scratch Topic

因此“功能没在 Git 里”这个假设先被排除。只有在运行实例与源码身份相同之后，才有
必要继续查删除记录和生产调用链。

## 真正根因

机器上运行的旧 `/Applications/AgentMux.app` 是 8 月 29 日 15:05 打出的包，
`package-identity.json` 里的 `sourceCommit=3809d36`，早于上面第一批功能提交；审计时
它比当前 main 落后 84 个 commit。功能不是被删了，而是根本没有进入正在运行的那份
bundle。

还存在一个会重复制造同样假象的路径问题：仓库里的 `apps/desktop/release/` 和
`apps/desktop/out/` 可能来自不同时间。启动路径如果拿了旧 `release`、开发缓存或
`/Applications` 下的另一个同名 App，即使当前 checkout 已经是最新，用户仍会看到旧行为。

## 改进动作

1. **把包身份当成事实，不把版本号当事实。** 每个候选都写入
   `sourceCommit`、`sourceTree`、应用版本、平台和架构；安装前后以及运行 ready receipt
   都核对同一组字段。
2. **收敛唯一发布入口。** 只接受同一次 clean build 产生的
   `apps/desktop/release/mac/AgentMux.app` 和同批 DMG；`out` 是构建中间产物，旧包和
   临时 App 不能直接安装。
3. **收敛唯一安装与启动路径。** 安装到 canonical `~/Applications/AgentMux.app`，
   启动排障同时读取运行进程真实 executable path；同名副本只报告 mismatch，不把它
   解释成源码回滚，也不删除用户数据。
4. **发包前做功能来源审计。** 对关键能力逐一核对“设计约束 → 生产实现 → 测试调用者”；
   只有当运行 bundle 与当前 source identity 一致仍缺功能时，才进入删除/替代调查。
5. **让并发协作服务于最终正确和吞吐。** 共享工作树和共享 `git add` 都可以，提交带上
   另一 Agent 已完成的改动不是事故；关键是 add 后看 staged diff、识别半成品、避免破坏性
   清场，并让自己的完整改动尽快落成提交。

## 留下的证据

- `git merge-base --is-ancestor 3809d36 HEAD`：旧包对应的源码提交仍在当前历史中。
- `git log --ancestry-path 3809d36..HEAD`：列出其后落地的功能提交。
- `git reflog`：没有 reset/rebase/force update，排除历史被回滚。
- `pnpm --filter @agentmux/desktop report:package`：比较候选、canonical 安装副本、
  其他同名副本和运行 executable path 的 `package-identity.json`，确认是否启动错包。
- `docs/plans/agentmux-desktop-package.md`：记录唯一打包入口、canonical 安装和
  `out` 非安装事实。

## 记住这一例

看到“已经做过的功能没了”，第一反应不是重写代码，也不是追责并发 Agent；先问：**我
现在看到的这个窗口，source commit/tree 到底是哪一份？** 包身份对不上时，这是启动
错副本，不是 Git 回滚。

## 复发（2026-09-01）：磁盘是新的，进程是旧的

同一个问题的第二种形态。用户报告终端里点 Claude Code 输出的链接不出目的地选择器，
直接弹一个 `Do you want to navigate to …? WARNING: This link could potentially be
dangerous` 的原生框。这一次磁盘侧**每一项**校验都通过：`package-identity.json` 的
`sourceCommit` 是最新的 `c287610`、打包时 `source_status=clean`、包内 renderer bundle
里两条 link provider 都在场并且指向同一个 activate 出口、xterm 只打进去一份。

真因是运行的**进程**：主进程 18:35:25 启动，安装发生在 21:54:19，进程比安装早三小时
十九分。`installApplication` 用 `rename` 原子换目录，旧的整份被 `mv` 进 `~/.Trash`；
已运行的进程按 **inode** 持有它打开的文件，目录改名不影响那些 inode，于是旧实例
**从垃圾桶里静默继续跑**，零报错零提示。安装那步当时只输出 `installed_app=` 和
`previous_install_trashed=`，没有任何一行说“有个旧实例还在跑，你验的不是这个包”。

**上面那句“先问这个窗口是哪一份”是对的，但当时给出的五条改进动作全部落在磁盘身份上**
（写 identity、收敛发布/安装路径、`report:package` 比对副本、发包前来源审计）。第一次的
失败模式是“装了旧包”——磁盘本身就是旧的，所以查磁盘就能查出来；这一次是“装了新包但旧
进程还活着”，磁盘是新的，那五条动作一条都不触发。同一句结论，两种失败模式，而工具只
覆盖了其中一半。这也是排查为什么绕远路：沿用本文档留下的手法，三层验证全在验磁盘。

诊断信号（从快到慢）：

1. **报错行里的 chunk 名**。用户贴来一条无关的 xterm 报错 `at index-BZqWMMh5.js:47172`，
   而装好的包里那个 chunk 叫 `index-B2vn2ya2.js`——一眼分开。`find` 找不到前者反而是佐证：
   旧文件已被覆盖，只活在进程内存里。运行时自报的身份比我们从磁盘推的身份更可信。
2. **进程启动时间 vs 安装时间**。
   `ps -eo pid,lstart,args | grep 'AgentMux.app/Contents/MacOS/AgentMux'`（必须过滤掉
   `Helper`：renderer helper 崩溃重启会换 PID、时间看着很新，但仍从同一份已加载的 app 起，
   这一点当时误导了排查一轮）对 `stat -f '%Sm' ~/Applications/AgentMux.app`。
3. **`ps` 里 ctxmuxd 的路径**指向 `/private/tmp/agentmux-package-<旧>/…`，说明那个实例是
   旧包起的。

### 改进动作（承接上面第 3 条，补上进程那一侧）

6. **`--install` 的交付物是一个跑着新包的进程，不是一个被换掉的目录。** 热更新是产品的
   设计前提，所以重装默认走完整条路：请旧实例优雅退出（`osascript … quit`，走 Cmd+Q 那条
   路以便桌面端 flush 布局；直接 SIGKILL 会丢用户当前的 Tab/Region 布局）→ 等进程真的
   消失（超时才升级到 SIGTERM/SIGKILL）→ 换目录 → `open -a` 重新拉起 → 断言此刻跑在
   已装路径上的每一个进程都是这次拉起的。不留“要不要重启”这种由调用方决定的开关。
7. **判据是执行顺序，不是文本在场。** 守卫见
   `apps/desktop/test/package-install-restart.test.ts`：解析 AST 求各步在
   `installApplication` 函数体里的位置，要求退出早于 `rename(next, destination)`、重新拉起
   晚于它、幸存者检查以“这次拉起的 pid”为白名单。文本 `toContain` 在这里不够——同一个
   函数里 `waitForProcessExit` 出现三次（请求退出后一次、两次信号升级后各一次），实测把
   **承重的那一次**换成 `remaining = []`（发完退出请求就往下走，进程还没死就换目录，正是
   本次事故的一半）而“这个名字出现过”这种判据 5 条全绿。七个变异各自打红一条且只红一条
   才算收工。
