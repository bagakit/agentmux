# f-22v8frrxw 独立审查发现与处置：四项头号构造曾无任何断言

日期：2026-08-29
发现者：独立 Reviewer（未参与实现）
复核与修复：主 session（实测验证，非采信自述）

## 发现

本 Feature 存在的全部理由是「表格变成一堆竖线、嵌套列表被压平、引用块和分隔线当纯文本」。
但独立 Reviewer 指出：**这四项构造在全仓没有任何断言**。

`apps/desktop/test/agent-markdown.test.ts` 的输入串里既无表格竖线、无引用块 `>`、
无水平线 `---`、也无两级嵌套列表；`activity-view.test.tsx` 的 turn 用例只喂纯文本，
走 `looksLikeMarkdown === false` 分支，根本不进解析器。

## 复核：实测证实，不是误报

不采信 Reviewer 的自述，实际做了变异验证。把 `agent-markdown.ts` 的
`case 'blockquote'` 与 `case 'thematicBreak'` 两个分支**整段删除**：

```
npx vitest run agent-markdown.test.ts activity-view.test.tsx
→ Tests  32 passed (32)
```

**全绿**。把这个 Feature 的一半功能删掉，没有一条断言变红。这坐实了空测试。

## 处置：补断言，并逐条做变异验证

在 `agent-markdown.test.ts` 补了 5 条针对派生结构（而非文本包含）的断言：

- GFM 表格：`kind:'table'`、`align === ['left','right']`、header/rows 长度、
  单元格保留 inline 文本而非竖线
- 嵌套列表：顶层只有 1 个 item，其 blocks 内含嵌套的 `kind:'list'`
  （压平的话会变成 2 个 item）
- 引用块：`kind:'quote'`，其 children 首块为 paragraph
- 水平线：`kind:'rule'` 存在，且任何 paragraph 的 children 里不残留 `---`
- 渲染层：宽表落在 `md-table-scroll` 容器内，且 `data-align` 两端都出现

补后 26 passed。**逐条做了变异验证**：

| 注入的缺陷 | 结果 |
|---|---|
| 删除 blockquote + thematicBreak 分支，并压平嵌套列表 | **3 failed** / 23 passed |
| 把表格的 `align` 恒定返回 `[]`（丢列对齐） | **2 failed** / 24 passed |

两次变异后均已还原源文件，并 diff 确认与变异前逐字节一致。

## 教训

这是本轮第二次出现「实现者自己验证过、却没看见」的缺陷
（上一轮是跨 workspace 通知被静默抑制、以及会注销无关 worktree 的 prune）。
共同模式：**实现是对的，测试却没有守住实现**——功能手测正常，于是断言写成了
只覆盖 happy path 的形状，把生产代码改坏也不会红。

因此「独立 Reviewer + 变异验证」这两道工序缺一不可，自审不能替代。
判断 done 的标准不是"测试通过"，而是"把实现改坏，测试会不会红"。
