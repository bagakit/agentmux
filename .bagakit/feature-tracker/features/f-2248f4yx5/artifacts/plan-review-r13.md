# f-2248f4yx5 计划修订 13：T-022 拆成"上游要动词"与"我方能自闭环的部分"

日期: 2026-08-30
评审结论: **approved**（用户追问「是有什么需要 ctxmux 改吗?」，查证后确认核心能力在上游）

## 为什么要改 r12 刚立的 T-022

r12 把 T-022 写成了「给 ctxmux Run 状态定 retention 并让它可被回收」，读起来像 AgentMux
自己能实现回收。**这个前提是错的**，当时没验证协议面就落笔。

## 协议面证据（SDK 生成的类型，即完整协议）

`packages/core/vendor/ctxmux/darwin-arm64/ctxmux-sdk-0.0.0.tgz` 解出的
`dist/generated/Request.d.ts` 列出**全部 13 个请求动词**：

```
start | discover_tmux | import_tmux | fork | list | status | input
| recoverable_input | resize | signal | stop | attach_recoverable_stop | attach
```

**没有任何一个能删除、过期或回收已终止的 Run。** `stop` 只是把 Run 推入终止态——
实测那 62 个 Run **全部已终止**，仍占 110 MB。CLI 侧同样无 prune/gc 子命令。

关键约束：`state.sqlite3`（表 `runs` / `replay_chunks`）是 **ctxmux 独占的私有存储**，
在它的 state 目录里。AgentMux 只是走 unix socket 的协议客户端。

## 三条路，只有一条对

1. **绕过协议直接删它的 SQLite** —— 不可接受。跨进程写别人的私有存储、与活着的 daemon
   抢写，随时踩坏 `stop`/`attach`/replay 语义。
2. **删掉整个 endpoint 目录** —— 只对**已无 daemon 存活的旧版本目录**可行，且是全删不是回收。
   这条**我方能自闭环**，它解决的是 `a4108d7` 之后每次 artifact 升级留下的孤儿目录。
3. **上游加回收动词** —— 真正的解法，**不在我方控制范围内**。

## 拆分结果

- **T-022 收窄**为我方能独立闭环的那半：孤儿 endpoint 目录的回收 + 现有容量的可观测。
  不再声称"给 Run 定 retention"。
- **T-023 新增**：等待并消费上游的 Run 回收能力，`status=blocked`（外部依赖）。
  形状对齐已有的 T-021（同样是等 ctxmux public 合同）。

上游需求一句话：**一个能回收已终止 Run 及其 replay 的协议动词**，按时间窗或容量上界，
且必须豁免 running 与正被 attach 的 Run。

## 补充说明

ctxmux **无本地源码**，仅有 vendored 产物（`manifest.json` 记 upstream commit
`073e206407ce28331aa882c2c80e9354cfe2879a`，protocol 13）。因此这是提上游需求的路径，
不是我方改代码的路径。
