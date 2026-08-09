# f-22u8fc2g6 计划评审

Feature: `f-22u8fc2g6` — Composer Surface and Honest Interrupt
计划修订: 1 · 评审结论: **approved**

## 用户原话

> 「对话框到周围不要那么大 margin, 搞得平面一点, Stop 按钮有歧义且功能不对, 应该是 ■ 表示 interrupt
> 对话, 而不是终止 session 吧. 终止 session 在顶部已经有按钮了」

## 核实结果一：按钮的**行为是对的，文案是错的**

`AgentComposer.tsx:102` 的按钮调 `onInterrupt` → `store.interrupt`(`store.ts:2799`) →
`api.sessions.interrupt`。**它中断的是当轮，不终止 session** —— 也就是说用户的判断准确：功能实现没错，
但标签写着 "Stop" 让人以为会终止整个 session，而终止 session 的入口**确实已经在 Tabbar 上**
（设计合同：`Active Run 的 Stop 是 Tabbar 内的图标动作`）。

两个不同动作用同一个词，是**歧义**而非 bug —— 但歧义会让人不敢按，或按错时以为丢了整个 session。
按用户说法改成 **■**（一个明确表示"停下这一轮"的记号），并与 Tabbar 的终止入口在措辞上分开。

## 核实结果二：`.composer` 有一道描边，这正是它"不平面"的原因

`styles.css:1595`:
```
.composer { margin: 6px 8px 8px; ... border: 1px solid #333c3f; ... }
```

两个问题都在这一行：

1. **margin `6px 8px 8px`** —— 用户说"到周围不要那么大 margin"
2. **`border: 1px solid`** —— 设计合同明写「描边不作为控件的主要视觉手段；Surface 填充、明度差、
   顶部高光和状态色承担层级」，而 Composer 一节更具体：「Composer 表面透明，只用边界、工具动作和
   focus ring 表达层级，不使用黑色填充或黑色投影」。这道 1px 描边正是"平面感"的反面。

同时要注意合同里的一条约束：**审批卡片刻意不用描边**，理由是「描边会与紧邻其下的 Composer 争夺同一条
边界」。所以收掉 Composer 的描边不仅更平，还消除了那处冲突的根源。

## 明确不做

- 不动 Tabbar 上终止 session 的入口（它是 Run owner 的既有动作，也是合同规定的位置）
- 不把 interrupt 与终止合并成一个按钮：它们作用于不同对象（一轮 vs 一个 session）
- 不因为"更平"而去掉 focus ring 或工具动作的可见性——合同要求它们承担层级
