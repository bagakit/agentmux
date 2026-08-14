# pnpm check 在 HEAD 上遗留的确定性红

Contract: `bagakit.feature-goal.v1`
Feature: `f-2578fv7m6`

## 现状核实（2026-09-13 重新实测，推翻原 goal 的计数）

原 goal 记的是「12 个文件、37 条断言」。**今天重数是 3 个文件、5 条断言**，而且其中一个还不是 HEAD 的问题。
原计数在写下时为真，之后被本轮的其他工作扫掉了大半，但没有人回头改这份描述。

逐个复核（全部从**仓根**跑，`--maxWorkers=2`）：

| 原列的 12 个 | 今天 | 说明 |
|---|---|---|
| tracked-imports-resolve-in-index | ✓ 绿 | 原记的「`.test` 被误当扩展名」已修 |
| schema-enum-ssot | ✓ 绿 | 原记「真缺陷：enum 手抄成员清单」已修 |
| needs-you-predicate-scope | ✓ 绿 | |
| surface-scale-contract | ✓ 绿 | |
| hover-dropdown-menu | ✓ 绿 | |
| session-launch-lifecycle | ✓ 绿 | |
| ui-persistence-writer | ✓ 绿 | |
| workbench-persist-version-bump | ✓ 绿 | |
| agent-hook-command | ✓ 绿 | 本轮 `'Stop'` → `canonicalHookLifecycleEvent` 收敛后转绿 |
| agent-session-store | ✓ 绿 | 同上 |
| terminal-redraw-feedback | ✓ 绿 | **原记录是假红**，见下 |
| type-tree-typecheck | ✗ 红 | **不是 HEAD 的红**，见下 |
| rendered-class-has-rule | ✗ 红 | 真缺陷 |
| working-count-convergence | ✗ 红 | 真缺陷 |

### terminal-redraw-feedback：原记录是测量方式造成的假红

它读 `readFileSync('apps/desktop/src/renderer/src/components/TerminalView.tsx')`——**仓根相对路径**。
用 `pnpm --filter @agentmux/desktop exec vitest` 跑时 cwd 是 `apps/desktop/`，于是 ENOENT；
`pnpm check` 走的是仓根的 `vitest run`（见 package.json 的 `test:fast`），不会红。

**判据本身没问题，是观测方式错了。** 这条记在需求池里会让人去修一个不存在的缺陷。
（教训与 [[git-pathspec-is-cwd-relative]] 同族：路径的相对基准取决于谁在跑。）

### type-tree-typecheck：红来自同事在途的工作树改动，不是 HEAD

它报 `test/control.test.ts (+6)` 新增类型错误。实查：HEAD 版 353 行，工作树版 588 行
（+238 行未提交），6 个 `TS2322: '{ id; kind: "local"; label }' 不能赋给 'HostConfig'`
全在工作树新增的 327-382 行。**HEAD 上这个文件不报错。**

这条不属于本 Feature：它会在那位同事补齐 `HostConfig` 必填字段时自己消失。
若它在对方收尾后仍在，那时才是一个真问题。

## 真正剩下的两件事

### 1. 六个渲染了却没有 CSS 规则的 BEM class（`rendered-class-has-rule` 红）

全部在 HEAD，即今天就在发布的未样式化 UI：

| class | 渲染处 |
|---|---|
| `continuous-progress-panel__summary` / `__decision` / `__actions` | `components/ContinuousProgressPanel.tsx:20,25,26` |
| `launch-surface__message-tools` | `components/NewTabSurface.tsx:339` |
| `log-turn__continue` | `components/ActivityView.tsx:562` |
| `md-image-attachment--unavailable` | `components/AgentMarkdown.tsx:149` |

每一个只有两种正确结局：**补规则**（它承重）或**从 JSX 删掉**（它是没人样式化的死钩子）。
往守卫的豁免表里加一条不是结局——那正是这条守卫要挡的东西。

### 2. 两处新写的「在跑吗」判据未申报（`working-count-convergence` 红）

`components/ProjectActivity.tsx` 与 `lib/activity-groups.ts` 各自新写了
`status.state === 'working'` 的比较。守卫不禁这个字面量，它要求每一处**说清自己回答哪个问题**：
若问的是「有几个在干活」，必须调 `project-board.ts` 的 SSOT（#419/#582 已经收敛过两次，别开第三次）；
若问的是别的，登记进 `NON_COUNT_STATE_COMPARISONS` 并写明理由。

`activity-groups.ts:123` 的 `.some(… === 'working')` 是这里最需要判断的一处：
「组里有没有人在干活」与「有几个在干活 > 0」很可能是同一个问题的两种写法。

## 收尾复核（2026-09-13，晚于上面那次重数）

上面「真正剩下的两件事」**都已入库并实测转绿**，本 Feature 无剩余工作面：

| 项 | 提交 | 今天实测 |
|---|---|---|
| 六个无规则的 class | `72547a3c` | `rendered-class-has-rule` 11 条全绿 |
| 两处未申报的 working 判据 | `72547a3c` | `working-count-convergence` 14 条全绿 |

同跑两个文件：`Test Files 2 passed`、`Tests 25 passed`（仓根，剥掉 `AGENTMUX_*` 环境变量）。

`72547a3c` 的处置与上面写的两种正确结局一致：五个 class 补了规则（含基类
`.continuous-progress-panel` 与 `.md-image-attachment` ——它们自己也没有规则，
所以这不是「完整基类上多余的修饰类」），`launch-surface__message-tools` 从 JSX 删掉
（同元素上的 `composer__toolbar` 已提供全部布局，全仓零引用）。**没有往任何豁免表加条目。**

`activity-groups.ts` 那处 `.some(… === 'working')` 的判断结论：确实与「有几个在干活 > 0」
同一个问题，已改调 `workingAgentCount()`，不登记豁免。另外四处问的是别的问题（逐 Session
排序 rank、单行标签），登记进表并各写理由。

### type-tree-typecheck 仍红，仍不属于本 Feature

今天复测依旧报 `test/control.test.ts (+6)`，归属未变：HEAD 版 353 行、工作树版 588 行，
六个 `TS2322` 全在同事未提交的新增行里（`hosts: [{ id, kind: 'local', label }]` 缺
`HostConfig` 必填字段）。**HEAD 上这个文件不报错**，它会在对方补齐字段时自己消失。

建议：本 Feature 可以关了。剩下这条红若要跟，应挂在拥有 `control.test.ts` 那条功能的
Feature 下，而不是留在这里当「遗留红」——留在这里会让下一个人以为还有活。

## 方法论备注

**需求池里带具体计数的前提，执行前必须重数一遍。** 这份 goal 的 12 变成 3，其中两条还是
误判（一条假红、一条同事在途）。按原描述排任务会产出 12 个任务、9 个立刻「验收通过」——
那是最坏的一种假绿：不是测试骗了人，是需求描述的是已完成状态。

同族教训：[[premise-about-references-needs-counting]]、[[counts-must-come-from-the-final-tree]]。
