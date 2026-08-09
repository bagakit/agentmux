# f-2248f4yx5 计划修订 12：给 ctxmux Run 状态补 retention

日期: 2026-08-30
评审结论: **approved**（用户在会话中要求「如果不是的话，就需要在 Tracker 里面插入一个 Task 来做了」）

## 起因

用户问：「即使进程没启动，也可以通过 CLI 来进行管理，是吗？这样可以避免一些泄露之类的情况吧？」

前半句成立：ctxmux daemon 是独立的 detached 进程，App 不在跑也能用
`ctxmux --socket <sock> runtime|list|status|stop|interrupt|input|attach` 管理，
`runtime` 就是启动前查 endpoint 归属的 pre-flight。

后半句不成立——查证时反而**证实了用户担心的泄露真实存在**，于是按用户指示立 T-022。

## 实测证据（2026-08-30，本机 uid 501）

旧 endpoint `/private/tmp/amx-501-5e67346cf1fedd60eba15e2b`：

| 项 | 值 |
| --- | --- |
| `state.sqlite3` | 110.2 MB / 28221 页 / freelist **0** 页 |
| `runs` 行数 | 62，**全部已终止**（exited 42、interrupted 20），running 0 |
| `replay_chunks` 行数 | 280184 |
| 已终止 Run 占的 replay | **44.8 MB**（interrupted 独占 44.6 MB） |
| `replay_truncated` | interrupted 里 9 个 |
| `auto_vacuum` | 2 = INCREMENTAL |

两条判断：

1. **单 Run 有上限，Run 总数没有。** 9 个 truncated 说明单 Run 的 4 MB 级窗口在起作用；
   但 Run 条目本身从不回收，所以总量随 Run 数**线性增长**，没有上界。
2. **freelist = 0 说明至今一次删除都没发生过。** 因此 auto_vacuum 虽然是 INCREMENTAL，
   「删了文件会不会缩」这件事**从未被验证**——落地时必须实测 `incremental_vacuum` 真被执行，
   否则页只进 freelist、文件不缩。

## 回收能力目前不存在（不是「有但没调」）

- `ctxmux` CLI 用法里没有 prune/forget/gc：只有
  ping/runtime/start/tmux-list/tmux-import/fork/list/status/input/resize/interrupt/attach/stop。
- `packages/core/src/ctxmux-run-adapter.ts` 里 grep
  `retention|prune|reap|gc|cleanup|vacuum|forget|discard` 只命中 activation 失败时的
  daemon cleanup，与 Run 状态保留无关。

## 为什么现在变严重

state 根在 `/private/tmp`（`runtime-paths.ts:30-31`），本机无 daily tmp 清理脚本，不会自动消失。
`a4108d7` 让 endpoint 随 artifact manifest 派生之后，**每次 artifact 升级都会留下一个完整的旧目录**——
leak 从此按版本数叠加。这是那次修复被明确接受的代价（「孤儿 daemon 要单独清理」），
但当时只记了 daemon，没记它身后这份 110 MB 的状态。

## 范围

T-022 只做保留策略与回收，不改 replay 语义、不动 running Run。
running Run 永不被回收要写成显式契约，避免回收逻辑日后被"顺手扩大"。
