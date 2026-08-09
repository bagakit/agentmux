# f-2248f4yx5 剩余范围核实（2026-08-29）

核实者：主 session
目的：确认这个 feature 到底还剩多少真实工作，避免把历史记录当待办去做。

## 结论

真实剩余 **3 个 task**：T-018（进行中）、T-019、T-021。
另外两个显示为 blocked 的 **T-008 与 T-016 不是待办**，它们已被正式取代：

| 已取代的 task | 取代者 | 取代者状态 |
|---|---|---|
| T-008 完成可复现竞品 Benchmark | **T-010** 纠正 mux 决策 SSOT 并冻结止损边界 | done |
| T-016 接入 ctxmux 并一次替换 Run Kernel | **T-020** 完成 ctxmux Local 原子切换与统一 CLI | done |

`tasks.json` 里两者的 `superseded_by` 字段分别指向 T-010 / T-020，
且 T-010 的 `supersedes` 明确列出 `T-008`、T-020 的 `supersedes` 列出 `T-016`。

tracker 自己的派生也是一致的：`show-feature-status` 报
`todo=2 in_progress=1 done=8 **blocked=0**`——它已经把被取代的 task 排除在计数外。
只有直接读 `tasks.json` 的原始 `status` 字段才会看到 `blocked`，那是**历史真相**，
不是执行前沿。

## 为什么值得单独记一笔

这两条的 blocker 文字读起来像硬阻塞，很容易被误当成"必须先解外部依赖才能推进"：

- T-008 的 blocker 是"Mux 决策 SSOT 把用户回复误归因为自建 agentmuxd 选择，
  当前 Benchmark candidate 与已确认的 ctxmux 方向冲突" —— 这个**决策错误已由 T-010 修正**，
  所以在旧 candidate 上重跑 Benchmark 本身就是错的方向。
- T-016 的 blocker 是 `ctxmux@b2bbc7a` 缺少 public License/版本化 Package、SSH transport、
  幂等与恢复保证等 —— 这是**外部依赖阻塞**，而 T-020 已经用当时可用的 public 合同
  完成了 Local 的原子切换。SSH 那一半则由**尚未开始的 T-021** 承担。

即：外部依赖当年确实卡住过，但范围已被重新切分——Local 部分做完了，
SSH 部分是 T-021 的活，不再是 T-016 的活。

## 因此

推进这个 feature 时**只做 T-018 / T-019 / T-021**。
不要去"解 T-008/T-016 的 blocker"——那等于在已被推翻的决策上重做工作。
