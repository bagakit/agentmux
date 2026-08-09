# f-22y8fh4jr 计划评审

Feature: `f-22y8fh4jr` — Move a Session View to Another Worktree
计划修订: 1 · 评审结论: **approved**

## 用户原话

> 「我们还支持一个功能，是把某一个窗口转移到另一个 worktree 的界面里头去。
>
> 原因是有的时候我们会在一个地方去创建 worktree，但这个创建 worktree 的会话自己本身却不在那个新的
> worktree 上面，这样的话就会导致很难管理
>
> 但是又不能自动帮他做，因为没有办法假设这个 session 就是应该要移过去的」

最后一句是本 Feature 最重要的约束，直接决定了它必须是**显式动作**而非自动行为。

## 核实结果：能移的是「投影」，不是 Agent 的工作目录

两个 `workspacePath` / `workspaceId` 分别属于不同层：

- **`session.workspacePath`**（Core，`types.ts:113`）是 Agent 进程的 **cwd**。进程已经跑在那个目录里，
  一个运行中的 PTY 进程的工作目录**改不了**——试图"移动 session 到另一个 worktree"若被理解成改 cwd，
  那是做不到的事。
- **Tab / Region 的 `workspaceId`**（Renderer，`workbench-tabs.ts`）是**展示身份**。

设计合同已经给出正确形状（`agentmux-desktop-interaction.md:38`）：

> 「一个 Session 可以没有 View，也可以投影到多个 View。」
> 「Desktop 只持久化 Session/Run 在哪张 View 的哪个 Region，不复制 PTY、Replay、Agent 状态或进程生命周期。」

所以本 Feature = **把某个 Session 的投影搬到另一个 workspace 的 View 里**，Agent 的 cwd 原样不动。
这也正好对上用户的措辞——他说的是「把某一个**窗口**转移到另一个 worktree 的**界面**里」，讲的是界面
归属，不是进程。

## 必须让用户看清「cwd 没变」

这是本 Feature 唯一的诚实性风险：搬完之后，那个 Agent 仍然在原来的目录里工作。若界面让人以为它现在
在新 worktree 里干活，就是撒谎，而且会导致真实的误操作（以为改的是新分支的文件）。

因此转移后该 Session 必须仍然如实显示它自己的工作目录，而不是继承所在 View 的 workspace 名字。

## 为什么不自动

用户点破的正是这一点：在 worktree A 里创建了 worktree B,不代表这个 session 应该搬到 B——它可能正是
那个"负责创建 worktree 的" session，就该留在 A。自动搬会把一个**猜测**变成不可见的副作用。

## 明确不做

- **不改运行中 Agent 的 cwd**（做不到，且合同禁止 Desktop 触碰进程事实）
- **不自动转移**：创建 worktree 不触发任何搬移
- **不复制 Session**：转移是移动投影，不是产生第二个 Session 或第二份 Registry
- **不动 PTY / Replay / Run 生命周期**：Desktop 只持久化"投影在哪"
