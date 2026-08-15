# f-22p8f93c8 计划修订 2：把 gate 写成真正可执行的命令

Feature: `f-22p8f93c8` — Attention Surfaces and Failure Visibility
计划修订: 2（supersedes 1）
评审结论: **approved**
日期: 2026-08-28

## 为什么要修

修订 1 的每个 task 都把 `verification[].ref` 写成 `package.json#scripts.test:fast`
这种"指向某个 npm script"的引用式写法。但 tracker 的 `run-task-gate` 会把这个字段
**原样交给 shell 执行**（`run_shell(cmd)`），于是 shell 找不到名为
`package.json#scripts.test:fast` 的命令，直接返回 **exit 127**。

也就是说修订 1 的 gate 从来跑不起来，不是环境问题，是计划本身写错了。

## 修了什么

只改 `verification[].ref`，从"引用"改成"命令"。task 的 id、标题、目标、验收标准、
依赖关系全部不变，执行状态与既有 gate 证据（包括那两次 127 失败记录）原样保留：

| 原引用 | 改为 |
| --- | --- |
| `package.json#scripts.test:fast` | `pnpm test:fast` |
| `package.json#scripts.check` | `pnpm check` |
| `apps/desktop/package.json#scripts.typecheck` | `pnpm --filter @agentmux/desktop typecheck` |
| `packages/core/package.json#scripts.typecheck` | `pnpm --filter @agentmux/core typecheck` |

共 10 处。`proves` 文本不变——它们描述的证明内容没有改变，只是兑现方式从一个不可执行
的指针变成了真实命令。

## 顺带发现的既有问题（不在本 Feature 范围）

同一份仓库里既有 feature 的 gate 也是这种引用式写法，因此在当前契约下同样跑不起来。
`f-2278ffae4` T-001 的 receipt 里 `pnpm check => fail` 是旧策略时期留下的历史记录，
不是当前契约下的有效证据。此外它的 gate 还引用了
`test -s docs/refproj-agent-runtime-notes.md`，而该文件已不存在，故那条 gate 必然失败。

这两点已记录，留给各自 feature 的 owner 处理，不在本次修订中一并改动——那会把别人的
执行真相卷进这次修复。

## 同时清理的运行时策略

`runtime-policy.json` 的 `gate.ui_commands` 与 `gate.non_ui_commands` 是已退休的键，
tracker 明确拒绝它们并要求把完成命令移进 tasks.json 的 `kind=command` 条目。两个键已
移除，gate 命令的唯一真相因此落在每个 task 自己的 verification 上。
