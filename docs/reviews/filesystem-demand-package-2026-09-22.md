# Filesystem Demand package review

## 当前事实

仓库当前已经有 Board 的 `Demand` 类型、`demand.*` Core 控制操作和
`agentmux demand` CLI，但它们的事实来源仍是 Desktop Renderer Store。Store
把 `demands` 写入 `agentmux-workbench-v1` 的 localStorage；Core 只负责校验
控制请求并把请求转回 Desktop。这个形状不能被其他 Client 使用，也不能让
Leader Topic 和 Board 共享一个宿主无关的文件事实。

`packages/core` 的职责是 Provider、Session、Run、PTY、ordered bytes 和
Runtime 生命周期。`apps/desktop` 的 `global-demand-board.ts` 只是投影层；它
不应继续成为 Demand 的持久化拥有者。`packages/layout` 是一个可参考的平行
宿主无关包，但它不是 Demand 的存储或控制边界。

## 决定（proposal）

新增独立包 `packages/demand`（发布名 `@agentmux/demand`）。它不依赖
Electron、React、Desktop、`@agentmux/core` 或 ctxmux，只依赖 Node 文件系统和
标准库。它同时提供：

- 宿主无关的 TypeScript API：创建、列出、读取、更新 Demand，显式关联/解除
  Project、Session，追加活动与结构化决策记录，以及只读订阅变更。
- 独立 CLI：`agentmux-demand` 读取同一 API；CLI 接受显式 `--root`，不从当前
  工作目录猜测事实根。未来若有聚合 CLI，`agentmux demand` 只能转发到这一个
  实现，不能在 Core 再写一份 Demand 逻辑。

Demand 是跨 Project/Session 的产品事实。`sessionIds` 为空是有效状态，多个
Session 也有效；Session 的运行、退出、恢复和状态不由 Demand 包推断。关联
只保存稳定 ID；当前找不到的 Session 仍显示为历史/unknown，不得伪造运行事实。
状态由显式 Demand 操作维护，固定为 `backlog`、`todo`、`in_progress`、
`in_review`、`blocked`、`done`、`cancelled`。Project、负责人、优先级、描述、
活动和决策属于 Demand；分配 Executor 与关联 Session 是不同操作。

## 文件边界

API 要求调用方明确传入 `root`；Desktop 由 Main 进程把它解析为应用的 durable
user-data 子目录，CLI 由 `--root` 指定。包不把 Topic 目录、Renderer
localStorage 或任意当前 cwd 当成隐式事实根。

首版格式是严格的 `agentmux.demand-store.v1` 单快照：

```text
<root>/store.json
<root>/store.lock
```

`store.json` 记录 `schema`、单调 `revision`、`updatedAt` 和完整 Demand 数组。
每次变更在进程内串行化，并在跨进程写入前以独占 lock 文件取得短锁；写入先
落到同目录临时文件、`fsync` 后原子替换。读取或校验失败返回带阶段和路径的
类型化错误，绝不用空数组覆盖调用方已经读到的事实。锁超时也返回可识别错误，
不静默丢写。

包不提供兼容 migration 或隐式 fallback。旧的 Renderer `demands` localStorage
字段不是新的事实；切换时由 Desktop 清除该投影写入路径，首个 package 快照
由显式 API/CLI 创建。若要保留旧数据，必须在另一个经批准的迁移 Feature 中
明确规定输入、输出和验收，不能偷偷塞入本 Feature。

## Desktop 与 Leader Topic 接入

Main 进程持有 `@agentmux/demand` store 和 IPC adapter；Renderer 只消费
adapter 返回的快照/receipt。Board、Leader Topic 和任何未来 Client 都调用
同一个 adapter/包 API，不能把 Demand 再写入 Zustand 的 durable `demands`
字段。Leader Topic 的 CUI/JSON 能力直接调用 package API，失败时在服务窗
保留已读 Demand；它不得在 Topic 目录或消息中另存任务副本。Core 保留现有
Runtime 控制职责，完成接入后删除 Core 内重复的 Demand domain/control
handler，而不是加一层 `task.*` 或双写兼容协议。

## 非目标与风险

本 Feature 不实现网络同步、远端数据库、自动从 Session 状态推导 Demand
状态、Agent 进程管理、第二套 Board 投影或聊天 UI。主要风险是旧 localStorage
Demand 不会被隐式迁移，以及跨进程锁的故障处理；两者都必须在实现测试和
服务窗中明确可见。

**Review status: approved.** 按项目“不保留向后兼容”的原则，不隐式迁移旧
Renderer localStorage；若未来需要保留旧数据，另立迁移 Feature。CLI 先提供独立
`agentmux-demand`；若未来需要 `agentmux demand` 聚合入口，只做薄转发，不在 Core
复制 Demand 领域逻辑。
