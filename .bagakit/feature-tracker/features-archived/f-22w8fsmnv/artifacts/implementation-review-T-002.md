# f-22w8fsmnv 独立实现审查（T-002）

日期：2026-08-29
审查者：主 session（未参与 T-001 的实现——T-001 由上一轮并行 agent 落地）
审查对象：工作树当前状态（含未追踪文件）

## 审查范围

T-002 的两条实质要求：
1. 全仓核实不存在第二处构造默认 worktree 路径的代码；若存在，已收敛。
2. 测试是否真能在错误路径下变红（即不是空测试）。

## 发现 1：路径构造点唯一 —— 通过

对 `apps/desktop/src` 与 `packages/core/src` 全量 grep `.worktrees`（排除测试），只有两处命中：

- `apps/desktop/src/renderer/src/lib/workspace-projects.ts:65`
  —— 唯一的路径构造点：`` `${root}${separator}.worktrees${separator}${segment}` ``
- `apps/desktop/src/main/workspace-files.ts:19`
  —— 不是构造点，是文件树遍历的忽略名单条目 `IGNORED_NAMES`，与本 feature 无关。

结论：**不存在第二处构造默认 worktree 路径的代码**，无需收敛。

## 发现 2：测试是载荷性的，不是空测试 —— 通过

不接受「测试通过」作为证据，实际做了变异验证：把 `workspace-projects.ts:65` 的
分隔符去掉一个，人为注入正是这个 feature 要修的缺陷——让路径塌回与项目同级的
兄弟目录 `<repo>.worktrees/<segment>`：

```
- return `${root}${separator}.worktrees${separator}${segment}`
+ return `${root}.worktrees${separator}${segment}`
```

结果：`apps/desktop/test/workspace-projects.test.ts` **2 failed | 2 passed**。
随后已还原源文件并确认第 65 行回到正确形态。

结论：该测试在错误路径下确实变红，能守住这条不变量。

## 处置

无 blocking 发现，无需修复。T-002 的两条实质要求均已满足。
剩余的「统一门禁通过（类型、测试、构建）」由最终候选上的 `pnpm check` 承担。
