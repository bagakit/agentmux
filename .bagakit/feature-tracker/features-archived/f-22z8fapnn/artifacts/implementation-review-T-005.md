# f-22z8fapnn T-005 独立实现审查

日期：2026-08-29
审查者：主 session（未参与 T-001..T-004 的实现——它们由上一轮并行 agent 落地）
方法：对着工作树真实代码核对 + 实测变异验证，不采信自述

## 审查重点（按 T-005 验收原文逐条）

### 1. 零跨度下是否有任何路径产出了时刻 —— 通过，且由类型强制

`activity-ruler.ts:24-25` 把 readout 定义为判别联合：

```ts
| { axis: 'temporal'; index: number; at: number; offsetMs: number }
| { axis: 'ordinal'; index: number }
```

`ordinal` 变体**在类型上就没有 `at` 字段**。因此"零跨度时伪造一个时刻"不是靠约定或
review 纪律来防守的，而是**编译不过**。`:101` 处 `span > 0 ? 'temporal' : 'ordinal'`
是唯一的轴判定点，不存在第二处各自推导。

这是本 feature 最值得肯定的一处设计：把诚实性约束下沉到类型，而不是下沉到注释。

### 2. 可视范围是否真的离开了滚动热路径 —— 通过

`ActivityView.tsx:458` 用 `IntersectionObserver` 驱动可视范围带。
全文件 grep `onScroll` / `addEventListener('scroll'` 无命中——没有每帧 scroll 处理器。
一条阅读用的装饰确实没有成为滚动卡顿的原因。

### 3. 测试能否在伪造精度时变红 —— 通过（实测）

不接受"测试通过"作为证据。把 `:101` 的轴判定改成恒定 `'temporal'`
（即零跨度下也宣称有真实时间刻度，正是本条验收要防的伪造精度）：

```
npx vitest run activity-ruler-mapping.test.ts activity-view.test.tsx
→ Tests  6 failed | 21 passed (27)
```

6 条断言变红。变异后已还原并 diff 确认逐字节一致。

### 4. 参考项目名不得出现在代码注释或设计文档 —— 通过

对 `activity-ruler.ts`、`ActivityView.tsx`、`docs/design/*.md` grep
`deepseek` / `traexon` / `harness` / `a mature workbench` / `a mature workbench`，**零命中**。
机制来源没有被写进 AgentMux 的代码或文档，符合既有纪律。

### 5. 统一门禁 —— 通过

`pnpm check` 实测全绿：typecheck + 1208 passed / 0 failed / 3 skipped + build 成功。
未放宽超时、未放松断言、未改动任何 e2e/打包配置。

## 结论

无 blocking 发现。四条验收要求（门禁、密度合同条款、无参考项目名、独立审查）均已满足。
密度合同的 Activity Ruler 条款已记录可点击跳转、可视范围指示、悬停读出，
并明写零跨度三者退化为序数语义、可视范围更新不在滚动热路径上。
