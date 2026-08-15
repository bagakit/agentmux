# 删 worktree 时对「已提交但没推上去」的产出保持沉默

Contract: `bagakit.feature-goal.v1`
Feature: `f-2658fuxjd`

## 状态：**已实现并入库**（2026-09-14，提交 `7b2880e7`）

本 Feature 创建时 status 是 `proposal`、零个 task，而它要的东西现在已经在跑了。这份文档的作用是
把「做完了什么、没做什么、判别命令是什么」钉死，防止下一个人照着标题再做一遍。

## 原文提出的问题（成立）

移除 worktree **不删分支**——真 git 验过：`git worktree remove` 之后 `git rev-parse` 仍给得出 sha，
`git branch` 里也还在。所以提交不会丢。但记录撤下、那一行从界面上消失，用户得自己敲 git 才找得回来。
**找得回 ≠ 会去找。** 而确认框此前只说「分支不受影响，仍然可用」，这句话是真的，但它没回答用户真正
要判断的那件事：**那条留下来的分支，是不是某份产出唯一的容身处。**

## 原文的开放问题「ahead relative to what?」——已经答了

答案在 `apps/desktop/src/shared/base-ref.ts`。这个问题不是措辞问题，它是这个 Feature 最危险的地方：

- `origin/HEAD` 是远端自己声明的默认分支，**唯一的权威答案**。它经常缺席（`git clone` 会写，本地建库
  再推的仓从来没有——本仓自己就没有，实测 `git symbolic-ref refs/remotes/origin/HEAD` fatal）。
- 缺席时退路猜的是字面量 `main`。**猜出来的 base 绝不许拿去数独有提交**，因为两个方向的错代价不对称
  （一次性 repo、真 git 实测）：

  | 猜的 base 与真 base 的关系 | 真实独有数 | 按猜的数出来 | 后果 |
  | --- | --- | --- | --- |
  | 猜的是条过时分支 | 1 | **2** | 多报，偏安全 |
  | 猜的分支已经含有这条 lane | 1 | **0** | **少报，致命** |

  `0` 在产品里的意思是「查过了，没有独有提交，删得放心」。而此时那批提交只活在本地 ref 上。

所以规则是：**猜来的 base 直接降级成「没查出来」，不给数字。** 这条规则由类型系统强制——
`orphanCommitCountArgs` 只收 `CountableBaseRef`，而只有 `orphanCountableRef` 铸得出它（提交
`2ed5032b`）。绕过必须显式写一句 `as CountableBaseRef`，那已经不是疏忽而是签字。

## 交付了什么

| 部件 | 位置 | 职责 |
| --- | --- | --- |
| 数独有提交的实参与解析 | `apps/desktop/src/shared/lane-orphan-commits.ts` | 纯函数；`--not <base> --remotes` |
| 三档措辞 | 同上 `branchRetentionNote` | 有几条 / 别处也有 / **没查出来** |
| base 判定与分级 | `apps/desktop/src/shared/base-ref.ts` | `origin/HEAD` vs 猜测；铸 `CountableBaseRef` |
| 跑 git 的探针 | `WorktreeService.orphanCommitNote`（main） | renderer 是沙箱，跑不了进程 |
| IPC 通道 | `workspaces:worktreeRemovalNotice` | **开框时就问**，不是删完才说 |
| 上屏 | `worktreeRemovalPrompt` 的 `note` 字段 | 纯函数；没拿到就不说 |

三个设计决定，每个都有代价，写下来免得被当成随手为之：

1. **单独一个 IPC 通道，而不是塞进 `removeWorktree` 的返回值。** 塞进返回值时已经删完了，话说晚了。
2. **先开框、再补那句话。** 反过来做会让右键菜单在慢仓上静默卡几百毫秒，用户以为没点中。这一问的
   作用是让用户**改主意**，只要在他读完、按下之前到达就有效。
3. **永不阻断删除。** 任何失败都回「没查出来」。为了一句提示挡住用户的删除操作，属于 AGENTS.md
   原则 11 第 2 类——我们自己这段流程降级了，不该因此收走用户还拥有的能力。

## 判别命令（问 git，不问工作区）

| 要判的事 | 命令 | 期望 |
| --- | --- | --- |
| 探针在 main 侧且真跑 git | `git grep -n "orphanCommitNote" HEAD -- apps/desktop/src/main/worktree-service.ts` | 有命中 |
| 通道在开框时被问 | `git grep -n "worktreeRemovalNotice" HEAD -- apps/desktop/src/renderer/src/components/BranchesPanel.tsx` | 有命中 |
| 那句话真的接到了文案上 | `git grep -n "request.note" HEAD -- apps/desktop/src/renderer/src/lib/worktree-removal-request.ts` | 有命中 |
| 猜来的 base 数不了（类型强制） | `git grep -n "CountableBaseRef" HEAD -- apps/desktop/src/shared/lane-orphan-commits.ts` | 有命中 |
| 真 git 用例在场 | `git grep -c "删 worktree 之前，先说清这条分支会留下什么" HEAD -- apps/desktop/test/worktree-service.test.ts` | ≥ 1 |

对照命令（证明上面那些零/非零是有意义的，不是 pathspec 写错）：

```
git grep -c "orphanCommitNote" HEAD -- apps/desktop/src/main/worktree-service.ts
```

必须有命中。同一 pathspec 下对照有命中、目标零命中，零命中才算数。

## 已知仍然开着的

- **没有启动时的对账。** 建 worktree 时 git 成功、落记录失败（`02acc703` 那一档）会在盘上留下一个
  记录不知道的目录。重启后没有任何东西去发现它。这不属于本 Feature，但它和本 Feature 共用
  `WorktreeRetention` 那套分类。
- **`ConfigStore.save` 没有 compare-and-swap**，仍是全仓 lost-update 的根。与本 Feature 无关，但每次
  碰这条路都会再看见它一次。
