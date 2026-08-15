# 看不到哪个 Agent 快把上下文窗口用完了

Contract: `bagakit.feature-goal.v1`
Feature: `f-25e8fm2tf`

## 状态：主交付物**已经在跑**，本 Feature 的真实剩余范围只有两小块（2026-09-14 逐条核对）

**原文的核心前提是假的。** 它写着「没有任何『窗口还剩多少』的信号」「只能在 Agent 开始截断上下文
之后才知道它满了」——而那个信号 **2026-09-06 就已经上线并挂在生产界面上**，比本 Feature 的创建时间
（2026-09-13 06:15）早了整整一周。照原文实现，会把一个正在用户眼前跑着的东西重做一遍。

这份文档的作用就是挡住那次重做，并把范围收到真正还没做的那两块。

### 已经有的（不要再做）

`AgentContextUsage.tsx` 组件，挂在生产的会话输入框上（`AgentSessionComposer.tsx:213`
`contextUsage={<AgentContextUsage usage={...turnUsage} />}`）。它已经：

- 同时给出 **`{used}% used` 和 `({remaining}% remaining)`**，两者由同一个取整数派生
  （`remaining = 100 - used`，:38），所以永远加起来是 100，不会出现 99；
- 分母取自 **运行时真实上报** 的 `context.capacityTokens`，不是查表猜的；
- 容量或已用量缺失时显示 "unavailable"，**绝不编一个假的 0%**（:27 明确写了这条）。

也就是说，原文设计里那套「modelId → 窗口容量查表（基线 200k / `[1m]` 变体 / 旗舰 1M），运行时真值
优先，两者都没有就只显示已用量」——**整套都不需要了**。真值这条路已经通了，查表是在真值缺席的假设下
设计的退路，而那个假设不成立。引入查表反而会带来一张需要跟着模型发布维护的常量表，以及"表说 200k、
运行时说别的"时谁赢的二义。

### 真正还没做的（这才是本 Feature 的范围）

1. **roster 行上没有这个信号**。`AgentContextUsage` 只在输入框里，名册行里没有。而"监督一群 Agent"
   恰恰要在**名册**上一眼扫过去——这是原文真正成立的那半个诉求。
2. **没有阈值着色**。组件里没有任何 70/90 之类的分档，也没有 amber/red。快满了和刚开始在视觉上一样，
   所以"预警"这件事确实还没有发生。

判别命令（问 git，不问工作区——文件在本机磁盘上恒在，那证明不了它入了库）：

| 要判的事 | 判别命令 | 期望 |
| --- | --- | --- |
| 「剩余量」信号已在生产界面上（原文前提为假） | `git grep -n "contextUsage={<AgentContextUsage" HEAD -- apps/desktop/src` | 有命中 |
| 它真的给出 remaining，不是只有 used | `git grep -n "remaining}% remaining" HEAD -- apps/desktop/src/renderer/src/components/AgentContextUsage.tsx` | 有命中 |
| 它早于本 Feature 存在（所以是重做风险，不是新需求） | `git log --format=%ci -1 --diff-filter=A -- apps/desktop/src/renderer/src/components/AgentContextUsage.tsx` | 2026-09-06，早于 09-13 |
| 分母来自运行时真值，不需要查表 | `git grep -n "capacityTokens" HEAD -- apps/desktop/src/renderer/src/components/AgentContextUsage.tsx` | 有命中 |
| **剩余范围一**：名册行里还没有 | `git grep -n "AgentContextUsage" HEAD -- apps/desktop/src/renderer/src/components/AgentRoster.tsx apps/desktop/src/renderer/src/lib/agent-roster.ts` | **零命中**（做完后应有命中） |
| **剩余范围二**：还没有阈值着色 | `git grep -nE "\b(70\|90)\b\|amber" HEAD -- apps/desktop/src/renderer/src/components/AgentContextUsage.tsx` | **零命中**（做完后应有命中） |

最后两条是**零命中判据**：它们现在返回空、退出码 1，而这正是"还没做"的证据。

零命中要配**对照命令**才算数——一条命令返回空，可能是"东西不在"，也可能是"路径写错了、正则被表格
转义搞坏了"，两者退出码都是 1。本仓刚栽过这个跟头：一份报告用 `-- AgentContextUsage.tsx`（裸文件名，
对着 git 树永远解析不出来）当"阈值不存在"的证据，命令确实返回空，但空得毫无意义。所以：

```
git grep -c "used" HEAD -- apps/desktop/src/renderer/src/components/AgentContextUsage.tsx
```

它必须**有命中**（实测 14）。同一个 pathspec 下对照有命中、目标零命中，零命中才是"东西不在"。
上表第二条零命中命令里的 `\|` 是 markdown 表格的转义；直接粘到终端时写成 `\b(70|90)\b|amber`，
两种写法实测都是零命中、退出码 1。

只引用有命中的命令，文档就只会说"已完成"；零命中的那条才让"没做完"这件事同样可被机器检查。
做完之后它们会翻成有命中——那一刻就是这两块的验收。

### 复用而不是新写

名册行要判"知不知道容量"时，`project-activity-row.ts:49` 已经照抄了 `AgentContextUsage` 的
`known`/`used` 判定，并在 :51 留了 `ponytail:` 注记说明「若第三处也要它，再抽到 agent-usage.ts」。
名册就是那个第三处。**先抽出共用函数，再写名册的显示逻辑**，不要抄第三份——三份同源判定漂移是本仓
反复栽过的坑。
