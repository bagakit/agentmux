/**
 * 测试里跑起来的 git 不读开发者本人的 gitconfig。
 *
 * `runProcess` 用 `{...process.env}` 派生子进程环境（`packages/core/src/process-runner.ts`），
 * 于是在这里设一次，仓内每一个 `git init` / `git commit` 夹具都拿到同一份干净配置——不用每个
 * 测试文件各抄一遍，也不会有人新写夹具时忘了抄。
 *
 * 起因是**慢**，但真正的毛病是**不封闭**。本机 `~/.gitconfig` 里有一条
 * `core.hooksPath` 指向公司的提交钩子，夹具里那句 `git commit` 于是每次都去跑它：实测单次
 * 2057ms，而夹具其余六步加起来约 100ms。`apps/desktop/test/worktree-service.test.ts` 有 28 条
 * 真 git 用例，65s 的运行时间里 56s 花在这上面。
 *
 * 慢只是症状。同一条继承链上还挂着 `user.useconfigonly`、`includeIf`、若干 `credential.helper`
 * 和一条 `include.path`——这些都是**别人机器上可以长成另一个样子**的东西。一台钩子会拒绝提交的
 * 机器上，这些用例会以与被测代码无关的理由变红；而没有这条钩子的 CI 上它们又是绿的。判据随机器
 * 漂移，就不再是判据。
 *
 * 两个变量都设：`GIT_CONFIG_GLOBAL` 挡 `~/.gitconfig`，`GIT_CONFIG_SYSTEM` 挡 `/etc/gitconfig`。
 * 只设前者，装了 system 级配置的机器仍然会漂。
 *
 * **不动生产代码**是有意的：AgentMux 真的在用户自己的仓库上跑 git，用户的 hooks、aliases、
 * credential helper 在那条路上全都必须生效。要隔离的只有测试夹具这一侧。
 *
 * 已经自己设了这两个变量的用例（`git-remote-error` 指向一个临时 HOME）不受影响：
 * `runProcess` 把 `options.env` 叠在继承环境之上，它们那份仍然赢。
 */
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
