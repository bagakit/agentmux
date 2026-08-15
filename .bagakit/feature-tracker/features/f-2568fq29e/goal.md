# 登录 shell 探针降级时不再静默丢掉 .zshrc 的 PATH

Contract: `bagakit.feature-goal.v1`
Feature: `f-2568fq29e`

## 状态：已落地（2026-09-14 逐条核对）

**这份 Feature 停在 `proposal`、`tasks: []`，但它描述的修复三条全在生产代码里。**
照着原文再做一遍等于重写一个已经在跑并且有 14 条测试守着的模块。本文档的作用就是挡住那次重写。

判别命令（三条各自独立，任何一条打不出下面的东西再来怀疑这份结论）：

| 原文要的东西 | 落在哪 | 判别命令 |
| --- | --- | --- |
| 预算别被两条臂平分死，早返回的把剩余额度让给下一条 | `login-shell-environment.ts` 的 `deadlineAtMs` + `shareMs` | `grep -n 'deadlineAtMs\|shareMs' apps/desktop/src/main/login-shell-environment.ts` |
| 退到 `-lc` 时把继承来的 PATH 并回去，别整段丢 | 同文件 `mergePath`，只在 `-lc` 那一支调 | `grep -n 'mergePath' apps/desktop/src/main/login-shell-environment.ts` |
| 降级要说出来，不能静默 | `loginShellEnvironmentWarning` 的 `mode !== 'interactive-login'` 分支 | `grep -n 'could not be confirmed' apps/desktop/src/main/login-shell-environment.ts` |

测试：`pnpm exec vitest run apps/desktop/test/login-shell-environment.test.ts` → **Test Files 1 passed, Tests 14 passed**。

## 原文里已经不成立的前提（**不要据此重新调研**）

1. **「5 秒预算被两条臂均分，-ilc 只有 2500ms」——不再均分。** 现在是一个总预算配一条
   deadline，`shareMs = (deadlineAtMs - now) / (剩余臂数)`；`-ilc` 早返回时省下的额度归 `-lc`。
   注释里写明了为什么不能反过来（把整份预算给第一条臂）：会挂的恰恰是 `-ilc`，而 `-lc`
   正是那条还能work的后路，全给了第一条就等于把后路也耗光。
2. **「凡由 .zshrc 贡献的 PATH 段整段消失」——不再消失。** `-lc` 那一支返回前会
   `mergePath(parsed.PATH, env.PATH)`：以探针拿到的为主序，继承的补在后面，按 `:` 切分去重。
   只在 `-lc` 支做，`-ilc` 支不做——那条本来就读了 .zshrc，再并一次只会把顺序搅乱。
3. **「两条臂给出不同的 PATH 却共用同一个成功出口」——出口仍是一个，但结果带 `mode`。**
   `{ ok: true, mode: 'interactive-login' | 'login' }`，调用方据此拿到那句告示。
   合并出口是**有意的**：两个出口会让"成功了但不完整"变成第二种成功，调用方迟早只判一种。

## 既定决策

- **降级出的是一句告示，不是一次失败。** `-lc` 捞到的环境是**真的**，只是可能不全——
  把它判成失败会把用户手上还能用的那条路也关掉（原则 11 class 2：我方这一步降级了，但
  Agent 本身没坏）。所以 `ok: true` + 一句说明"交互式配置未能确认"，而不是 `ok: false`。
- **PATH 合并只去重不排序。** 顺序就是优先级，重排会让另一个 `git` 或另一个 `node` 悄悄上位。
- **`_ / SHLVL / PWD / OLDPWD` 四个键显式删掉**：它们描述的是探针那个 shell 自己，不是
  被启动的应用。留着会让每个 Agent 继承一个假的工作目录。

## 还没做的（有意的）

- **不为 executor「Not Installed」单独加一条"可能是环境没加载全"的提示。** 原文把它当症状记的，
  而症状的根因（PATH 丢段）已经修掉；在 executor 那一侧再加一句推测性解释，是在没有判据的
  情况下替用户猜原因——真降级了有那句告示，没降级时这句话就是噪音。

## 边界

这个 Feature 只管**捞环境这一步**的诚实度：捞全了、捞了一半、没捞到，三种要分得开且说得出。
"某个 executor 装没装"仍然只有 executor 探测那一处裁决，本 Feature 不参与那个判断。
