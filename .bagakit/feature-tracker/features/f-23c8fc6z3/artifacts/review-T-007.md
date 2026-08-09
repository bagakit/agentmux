# T-007 独立 review 结论

- feature: f-23c8fc6z3
- task: T-007 「左边/右边/上面/下面」在查看时也能落到 Tab，不只是 Region
- 被 review 的提交: `cad9ad4`
- 修复提交: `4652090`
- 日期: 2026-08-30
- 形式: 独立 subagent（对抗式），明确要求「找出哪些变异能活下来」而不是找赞同

## 结论

七条功能验收全部由代码满足，几何逻辑（EPSILON 容差、跨轴重叠判定、最近候选排序、
origin 缺失路径）未发现正确性缺陷。Desktop 侧接线是真的被守住的：从
`inspectWorkbenchControlRegion` 或 `inspectWorkbenchControlTab` 任一处剪断 `neighbors`，
`control.test.ts` 会红，且（不加 cast 的话）`tsc` 也会失败。

## 一条真缺陷（已修）

**主机侧的邻居校验没有任何断言经过，而我的提交信息声称它有。**

`control-host.ts` 的 `parseNeighbor` / `parseNeighbors` 代码本身是对的，但全仓库喂给它的
`neighbors` 值清一色是四个 `{kind:'none'}`，于是 `region`、`tab` 两个分支与 up/down 拒绝规则
**零覆盖**。Reviewer 给出三个存活变异，我逐条独立复现确认：

| 变异 | 结果 |
| --- | --- |
| `parseNeighbors` 整段换成返回全 none（什么都不校验） | 存活（绿） |
| 删掉 `control-host.ts` 的 up/down-tab 拒绝 | 存活（绿） |
| `parseRegion` 不再带 `neighbors`（接线剪断） | 存活，且 **`tsc` 也过** |

最后一条尤其值得记下：重载签名的非 inspected 分支没有 `neighbors` 字段，所以类型系统在这里
**兜不住**——与 desktop 侧的行为不同。这正是本仓库反复栽的那个 false-green：删掉一个接线点，
全绿。

严重性判断：邻居是 Agent 会直接喂回 `focus` / `send` 的**地址**。校验形同虚设意味着放行一个
没人验证过的寻址目标，因此这是信任边界而不只是数据校验。

**修复**：`control-host.test.ts` 新增用例，把真实邻居推过 `parseAgentMuxControlReceipt`——
合法 region/tab 原样通过；`self`、空串、含换行的 id 被拒；up/down 携带 Tab 抛错；未知 kind、
缺字段、整段缺失均被拒而不是当成「没有邻居」放过。四个变异（含 `identity()` 降级为裸 cast）
现在全部会红。

## 一条次要意见（已采纳）

`DirectionalNeighbor` 是 `AgentMuxRegionNeighbor` 的纯重命名，文件外无消费者——已删除，
它承载的说明移到 `directionalNeighbor` 的注释上。

`regionNeighbor` / `tabNeighbor` 的 `export` 仅被测试消费，但直接测这两个是合理的粒度，
保留（reviewer 同此意见）。

## 未采纳

无。
