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
| **剩余范围一**：名册行里还没有 | `git grep -nE "contextPressure\|contextPercent" HEAD -- apps/desktop/src/renderer/src/components/AgentRoster.tsx apps/desktop/src/renderer/src/lib/agent-roster.ts` | ~~零命中~~ → **已有命中（51f7a184 起）** |
| **剩余范围二**：还没有阈值着色 | `git grep -nE "PRESSURE_THRESHOLDS\|\b(70\|90)\b" HEAD -- apps/desktop/src/renderer/src/lib/agent-usage.ts` | ~~零命中~~ → **已有命中（agent-usage.ts:75-77）** |

**上面两条判别命令在 51f7a184 之后被改写过，因为原来那两条测不到交付物**（审计发现，记在这里而不是
默默改掉）。原文两条都指向 `AgentContextUsage.tsx`：
- 范围二原命令在那个组件里找 70/90——但阈值落在了 `agent-usage.ts` 的 `PRESSURE_THRESHOLDS`。
  那条判据**永远翻不了绿**，而事情早已做完。
- 范围一原命令搜 `AgentContextUsage` 这个名字——它有 1 处命中，但那是 `AgentRoster.tsx:39` 的一句
  **注释**。判据命中注释、报出"已完成"，实际并没有验证任何交付：真实实现是复用
  `agent-usage.ts` 的 `contextUsedPercent`/`contextPressure` 两个函数（正是下面「复用而不是新写」
  一节要求的路子），而不是 import 那个组件。

这正是零命中判据的反面教训：**判据要钉交付的性质落在哪儿，而不是钉实现前猜的那个落点**。猜错了
落点，零命中就从"还没做"的证据退化成"这条命令问错了地方"，而两者退出码都是 1。

其余四条（前提类）仍然成立，未改动。

最后两条**当初**是零命中判据：它们返回空、退出码 1，而那正是"还没做"的证据。两块现已交付
（51f7a184），所以它们今天都有命中——下面这段讲的是当时怎么把"没做完"写成可机器检查的形状，
连同它踩过的坑一起留着。

零命中要配**对照命令**才算数——一条命令返回空，可能是"东西不在"，也可能是"路径写错了、正则被表格
转义搞坏了"，两者退出码都是 1。本仓刚栽过这个跟头：一份报告用 `-- AgentContextUsage.tsx`（裸文件名，
对着 git 树永远解析不出来）当"阈值不存在"的证据，命令确实返回空，但空得毫无意义。所以：

```
git grep -c "used" HEAD -- apps/desktop/src/renderer/src/components/AgentContextUsage.tsx
```

它必须**有命中**（实测 14）。同一个 pathspec 下对照有命中、目标零命中，零命中才是"东西不在"。

只引用有命中的命令，文档就只会说"已完成"；零命中的那条才让"没做完"这件事同样可被机器检查。
**但这套办法还差一环，本 Feature 自己就栽了**：对照命令只证明 pathspec 解析得开，证明不了这个
pathspec 就是交付物会落的地方。上面那两条的对照都有命中（同一个文件里确有 `used`），零命中因此
读起来完全可信——而交付物落到了另一个文件里。所以判据除了要能翻绿，还得在**落点变了的时候被改**。

### 复用而不是新写

名册行要判"知不知道容量"时，`project-activity-row.ts:49` 已经照抄了 `AgentContextUsage` 的
`known`/`used` 判定，并在 :51 留了 `ponytail:` 注记说明「若第三处也要它，再抽到 agent-usage.ts」。
名册就是那个第三处。**先抽出共用函数，再写名册的显示逻辑**，不要抄第三份——三份同源判定漂移是本仓
反复栽过的坑。
