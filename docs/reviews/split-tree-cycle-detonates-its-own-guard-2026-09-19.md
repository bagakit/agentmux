# split tree 成环时，守卫自己先炸——走不到它那句 throw

状态：已实测证实；**不是**渲染进程跑飞的元凶（见下"排除"一节）
日期：2026-09-19
来源：渲染进程跑飞归因过程中的副产物，本机实测

## 事实

`packages/layout/src/split-tree.ts:185-191` 的 `collectLeafIds` 是无条件自递归，
**没有 visited 集合、没有深度上界**：

```ts
export function collectLeafIds<Leaf>(root, leafId): string[] {
  if (root.type === 'leaf') return [leafId(root)]
  return [...collectLeafIds(root.first, leafId), ...collectLeafIds(root.second, leafId)]
}
```

实测（探针跑完即删，未入库）：构造 `branch.second = branch` 的自引用节点，
`collectLeafIds` 结果是 **`RangeError: Maximum call stack size exceeded`**。

## 要害：守卫的第一步就是它

`packages/layout/src/workbench-layout.ts:363` 的 `assertGroupInvariant` 是一条**无条件 throw 的生产断言**，
本意是拦住"树叶与记录表不对应"这种不可见孤儿 Tab Group。但它的**第一行**是：

```ts
const tree = groupIds(layout.root)   // groupIds 是 collectLeafIds 的转发壳
```

于是一旦树成环，**断言自己先栈溢出**，永远走不到它精心写的那句 throw，也给不出那条诊断消息。
守卫在这一种输入上从"拦住"变成"引爆点"：用户拿到的是一句 `Maximum call stack size exceeded`，
而不是"哪个 id 多了 / 少了"。

区域侧的对偶 `assertRegionInvariant` 同构，同样先走 `regionIds`。

## 全仓没有任何一条判据说这棵树无环

搜 acyclic / cycle / visited / 深度上界：`packages/layout` 与 `apps/desktop/test` 均无命中
（命中的都是 `depth` 等词的子串误命中）。`apps/desktop/test/workbench-region-invariant.test.ts`
判的是**叶子集合与记录表多重集相等**，不判成环——两棵树的不变量都假定了"它是一棵树"，
而没有人守这个前提本身。

## 排除：这不是渲染进程跑飞的元凶

渲染进程 pid 73291 的现场是**稳定 344 层深、持续 85–128% CPU 跑了 7h49m 不抛**。
而成环的表现是**立刻 RangeError**。两者形状相反，所以：

- 成环 → 立即抛 → 不可能维持 7 小时；
- 跑飞 → 固定深度**反复重入**（微任务队列里自我续喂），不是无界递归。

**深度稳定不增长**这一条是鉴别器：它同时排除了「无界递归」与「定时器驱动的浅栈循环」。
元凶仍待定，下一个判据是渲染进程 devtools console 里那句话：
`Maximum call stack size exceeded` → 成环那一支；`getSnapshot should be cached` / React #185 → selector 那一支。

## 修的方向（约束，不是实现步骤）

1. **遍历要能在成环时给出可读结论**，而不是栈溢出。判据落在共享收口处（`collectLeafIds` 一处），
   不要在 N 个调用方各加一道。
2. **守卫不能把自己的前提交给被守对象**。`assertGroupInvariant` 要先能安全地取到叶子集合，
   才谈得上比对——否则它对最坏的那类输入恰好失效。
3. 判据要**可证伪**：变异判据是把无环检测去掉，对成环输入该测试必须红。
   注意别写成空集合上的谓词（`[].every` 恒真）。

## 关联

- 渲染进程跑飞证据：`docs/reviews/evidence/renderer-mainthread-runaway-2026-09-19.sample`
- 通知去重被易变诊断打穿：`docs/reviews/notice-dedup-defeated-by-volatile-diagnostic-2026-09-19.md`
- 既有守卫盲点：`apps/desktop/test/store-selector-snapshot-stability.test.ts` 只看 selector **字面返回表达式**，
  返回 `helper(state.x)` 而 helper 内部新建数组的形态它看不见（今天那些 helper 恰好返回稳定引用，
  但守卫并不验证这一点）。
