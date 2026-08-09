# f-2328fmmvk T-001 独立复核：已删除文件的祖先回退

日期：2026-08-29
复核者：主 session（未参与实现）
方法：实测变异验证，不采信实现者自述

## 交付确认

用户原话：「打不开的文件，现在只显示"无法加载文件"，应该在它这里再加上"Reveal in Finder"之类的操作」。

实现走的是**既有**揭示通路（`api.files.reveal` → `files:reveal` → `localPathForReveal`），
没有第二条 IPC、没有第二套路径解析，符合验收第 1 条。

## 最容易做错的那条：已删除文件的祖先回退 —— 已实现且被守住

验收明确点名这是本 task 最容易做错的地方：`localPathForReveal` 原本经
`localExistingPathWithin` 要求目标存在，因此对已删除文件必然失败——而"文件已被删除"
正是"打不开"最常见的成因。揭示父目录仍然回答了用户的问题（它不在那儿了），
报一个二次错误则什么也没回答。

实现新增了 `workspace-files.ts:292 localExistingAncestorWithin`：从目标逐级上溯，
遇 `ENOENT` / `ENOTDIR` 就退到 `dirname`，直到找到存在的祖先。

**安全性没有为此让步**：循环体内每一次 `realpath` 之后都仍然执行
`assertRealPathWithin(realRoot, realTarget, sep)`（:298），所以上溯不可能借符号链接
逃出 workspace 根；`parent === lexicalTarget` 时抛出，不会无限上溯。

## 变异验证

把 `workspace-files.ts:781` 的解析器换回严格版 `localExistingPathWithin`
（即恢复"目标必须存在"，正是本 task 要修的缺陷）：

```
npx vitest run apps/desktop/test/editor-pane-reveal.test.tsx
→ Tests  2 failed | 9 passed (11)
```

断言确实在缺陷回归时变红，不是空测试。变异后已还原并 diff 确认逐字节一致。

**一处记录**：同一变异下 `workspace-files.test.ts` 单独跑是全绿的（22 passed）——
守住这条不变量的断言住在 `editor-pane-reveal.test.tsx`。做变异验证时若只跑前者
会得出"空测试"的错误结论。这说明变异验证必须覆盖**声称守护该行为的那个测试文件**，
而不是随手挑一个相关文件。

## 其余验收

- 远端（非 local host）workspace 不提供该动作——`localPathForReveal` 对非 local host
  明确抛错，测试 :222 断言了这一点。**缺席即表达**，没有画一个必然失败的禁用按钮。
- 揭示失败经既有 `reportError` 浮现，不把编辑器面板替换成第二个错误态。
- 未改动既有文件树右键菜单里的 Reveal in Finder。

T-001 五条验收在代码与测试中均已满足。T-002（设计 SSOT 条款 + 独立 reviewer 签字 +
统一门禁）仍开放，实现者已如实上报未做。

---

## 归档后补充核实（2026-08-29，同日）

并行的独立 Reviewer 报了两条 blocking，均已在归档前由 remediation 落地。事后复核确认：

### 1. 验收命令曾指向不存在的测试文件 —— 已修

原 verification ref 写的是 `apps/desktop/test/editor-pane.test.tsx`，而交付的文件叫
`editor-pane-reveal.test.tsx`。**vitest 对不存在的路径静默忽略并报 pass**：

```
$ npx vitest run apps/desktop/test/editor-pane.test.tsx apps/desktop/test/workspace-files.test.ts
  Test Files  1 passed (1)
      Tests  22 passed (22)      ← 只跑了 workspace-files，reveal 的断言一条没执行
```

那条 gate 证明不了它 "proves" 字段声称的任何一件事。ref 已更正为
`editor-pane-reveal.test.tsx`，本 Feature 归档时跑的 gate 是更正后的版本（33 tests）。

**这是一类值得记住的空 gate**：命令本身是绿的，但它根本没执行目标断言。
配置文件里的测试路径也需要核对存在性——写错文件名不会报错，只会静默少跑。

### 2. 符号链接逃逸守卫曾无断言 —— 已补并变异验证

`localExistingAncestorWithin` 上溯循环里的 `assertRealPathWithin`（workspace-files.ts:298）
是安全边界，但删掉它时 33 个测试全绿——生产代码是对的，不变量却没被测。

已补断言（`editor-pane-reveal.test.tsx:225`）。实现者做了一个正确的判断值得记下：
断言**直接打在 `localExistingAncestorWithin` 上**，而不是经 `localPathForReveal`——
因为后者路径上 local worker 的 `currentDirectory()` 冗余守卫会抛出**同样的错误文案**，
从而掩盖被删除的 confinement，写成那样又会是一条空测试。

事后变异验证：从上溯循环删掉 `assertRealPathWithin` →
`Tests 1 failed | 11 passed`。已还原并 diff 确认逐字节一致。

### 3. 一条 minor（未修，记录判断）

EditorPane 组合层只断言了 "Reveal in Finder" 文案的有无，没有触发 onReveal handler，
因此把参数接错（传 WRONG-WS/WRONG-PATH）不会变红——参数接线只在独立 helper 层被测。
风险有限（helper 本身有测、文案有无也有测），但确实是覆盖缺口，留作已知项。
