# 关掉的错误又回来：去重键被易变诊断打穿

状态：**已修**（2026-09-20）。实现：`errorIdentity`（error-presentation.ts）+ `reportError` 双侧取键
（store.ts:4974-4975）。三条变异判据全部实测变红，详见文末「修完之后」。
日期：2026-09-19
来源：用户报告（原话见下）+ 本机实测

## 用户原话

> 然后这个错报了以后，消息队列就变成异常状态了，这不应该吧？即使当时发不出去，它也应该还是在队列里面一直等着，对吗？
> 然后这个错报一次、关掉了以后，就不应该再报了，对吗？
> 现在设计上好像有点问题，感觉得 review 一下整个这一块的设计，然后把类似于这样有问题、交互有问题的地方都改掉

两条主张都成立，且**第二条有明确的单点根因**（本文件）；第一条（队列该继续等）属于另一条链，由 review 另行给结论。

## 现场那条错误

```
The prompt was not sent because this Run has no consumable composer readiness yet.
The Agent Run is still running; wait for the Stop/screen readiness observation to finish, then send again.
Diagnostic: runId=f652d14b-… readinessId=none readinessSource=none readyThroughByte=pending
            latestOutputBytes=549373 reason=epoch-missing
```

## 根因：去重键按整串消息比，而消息里含单调增长的字节数

`store.ts` 的 `reportError` 就是为「同一条瞬时故障被重复上报」写的，注释也明说了意图：

> Replayed runtime events and polling can report the same transient failure repeatedly.
> Once the user dismissed that exact message, do not resurrect it…

判据是**整串相等**：`if (current.errorDismissed && current.lastError === message) return`。

而这条消息的 `Diagnostic:` 段里带着 `latestOutputBytes`——它是输出游标，**单调增长**
（`packages/core/test/prompt-submission-diagnostics.test.ts` 记着这条链：
`outputCursorBytes = Math.max(run.latestOutputBytes, readyThroughByte)`，按构造只增不减）。
Agent 每多打印一个字节，这个数就变；于是**同一个原因**每次上报都是**一串不同的文本**，
`lastError === message` 永不命中，用户的「关掉」被逐次击穿。

用户没做错任何事：他关掉的是**这个原因**，代码理解成「关掉这串字符」。

## 为什么测试是绿的（这才是要留住的教训）

`apps/desktop/test/error-presentation.test.ts` 的 `transient error lifecycle` 用的是一串
**常量**消息（`'Readiness observation is still pending'`），report → dismiss → reopen 全过。
它从不构造「同一原因、诊断数字变了」这一种——也就是**唯一会失败的那一种**。

替身/输入写成常量，被测性质（去重键对易变字段是否稳健）就整条不可见。断言全绿、行为全坏。
同族记忆：`frozen-fake-hides-the-property`、`weak-assertion-patterns`。

## 修的方向（不是实现步骤，是约束）

1. **去重要按「原因」去重，不按呈现文本去重。** 诊断数字是给人看的上下文，不该参与身份。
   一条错误的身份应由稳定字段构成（reason code / runId / 失败的那一步），
   易变游标只进展示层。
2. **易变字段进消息这件事本身要有守卫。** 只修这一处，下一个把单调计数拼进用户可见文案的人
   会重新打穿同一个闸。判据应当能从来源反推（扫消息构造点），而不是维护一份手写清单。
3. **那条 lifecycle 测试必须喂「同一原因、诊断变了」。** 现在的常量输入让它对本缺陷全盲；
   变异判据：把去重键改成整串相等（即今天的实现），该测试必须红。

## 修完之后（2026-09-20）

实现是一条**身份函数**：`errorIdentity(message)` 剥掉 `Diagnostic: …` 尾段，`reportError` 对
**两侧**都调它比对。不存新字段——把算好的键存在 `lastError` 旁边就是同一个缺陷上移一层：两处各自
决定身份，哪天有个写入点忘了其中一处就开始漂。

**没有按 `AgentMuxError.code` 去重。** 本模块头部记着理由：同一个 code 在不同抛出点含义不同
（`AGENT_PROMPT_READINESS_CONFLICT` 横跨两件无关的失败），按 code 去重会**过度**去重——把一个真的新
故障静默吞掉，比重复报一次更糟。而且 code 过不了 `ipcRenderer.invoke`，本缺陷恰好就报在这条路径上。

### 两处我自己写错、被实测纠正的地方

**(1) 那条守卫的第一版性质是假的。** 我先写的是「凡在完整消息后追加的标签都必须从身份里剥掉」，
从 `src/` 扫构造点。扫描当场把它推翻：`${primary.message} Cleanup also failed: ${presentError(e)}`
（store.ts）追加的是**另一个原因**，两次不同的清理失败是两件事，剥掉就是过度去重。
**源码文本分不出 `${diagnostic}`（易变游标）和 `${presentError(e)}`（稳定原因）。**
所以守卫收窄成真正会静默断的那一环：标签在 **main** 侧拼、在 **renderer** 侧剥，两个文件之间没有
共享常量。改名一侧今天什么都不会红，横幅就重新开始复活。守卫从构造点读出标签再证身份剥得掉它。

**(2) 我给 reopen 写的注释是错的。** 我写「reopen 拿到最新那份诊断」，探针实测是**第一份**
（549373，不是 549512）——被抑制的那次上报根本不写。原来的断言 `toContain('latestOutputBytes=')`
在两种行为下都绿，正好把这件事盖住了。现在钉死具体数字，并记下这是**有意**的：刷新记忆文本等于
每个回放事件写一次 store，而过时的只有那个字节数，`runId`／`readinessId`／`reason=epoch-missing`
两份完全一样，没有丢任何可诊断的东西。

### 三条变异判据（全部实测）

| 变异 | 结果 |
|---|---|
| `reportError` 退回整串相等（即修之前的实现） | 1 failed ✅ |
| `errorIdentity` 返回常量（过度去重那一侧） | 2 failed ✅ |
| main 把 `Diagnostic:` 改名 `Details:`（跨文件链断） | 1 failed ✅ |

## 关联

- 渲染进程主线程跑飞（85–128% CPU、7h49m 不退、调用图 344 层深）：
  证据留档 `docs/reviews/evidence/renderer-mainthread-runaway-2026-09-19.sample`。
  与本条是否同一缺陷**尚未证实**——若通知在 render 期 raise 并触发重渲染，两者会是一件事；
  未证实之前不要合并结论。
- readiness 拒绝本身（`reason=epoch-missing` 却自称 "The Agent Run is still running"）属
  AGENTS.md 第 11 条第 2 类：Agent 没坏、是我们的观测没走通，**这一类不得阻断**。另案。
