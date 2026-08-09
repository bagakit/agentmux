# f-22w8fsmnv 计划评审

Feature: `f-22w8fsmnv` — Worktree Path Inside the Project
计划修订: 1 · 评审结论: **approved**

## 用户原话

> 「默认 worktree 目录现在不对, 应该是 项目/.worktrees/... , 而不是 项目.worktrees/」

## 已核实的 bug（一个缺失的分隔符）

`apps/desktop/src/renderer/src/lib/workspace-projects.ts:62`:

```ts
return `${root}.worktrees${separator}${segment}`
```

`root` 之后**少了一个 separator**。于是 `/repo/agentmux` 拼出
`/repo/agentmux.worktrees/feature-a` —— 那是与项目**同级的兄弟目录**，而不是项目内的
`/repo/agentmux/.worktrees/feature-a`。

后果不只是难看：worktree 落在项目外面，意味着它不受项目的 `.gitignore` 覆盖、不随项目目录一起被移动
或删除、也不出现在项目自身的文件树里。

## 测试里固化了错误行为

`apps/desktop/test/workspace-projects.test.ts:41,50` 用的正是 `/repo/agentmux.worktrees/feature-a`。
所以这不是"补一个测试"，而是**先纠正被固化的期望**——否则改对代码会让测试变红，而红的原因恰是它在
守护 bug。

## 与扇出的关系

`f-22q8f25qd` 的扇出计划把 lane 建在 `worktreeRoot` 下（`fanout-plan.ts`）。若扇出使用这个 helper，
修正后所有 lane 会随之落进项目内——这是修它的额外理由，且要顺带核实扇出的默认根是否也走这里。
