# f-22t8fckeu 独立实现审查（T-004 收尾）

日期：2026-08-29
审查者：主 session（未参与实现）
方法：对着工作树真实代码核对 + 实测变异验证，不采信自述

## T-001/T-002 markdown 渲染 —— 通过（含一处已核实的取代）

解析器 `agent-markdown.ts` 只产 BlockNode/InlineNode 树，从不产 HTML；
全仓 `dangerouslySetInnerHTML` 只出现在两处**解释它为何不存在**的注释里。
渲染只在 turn register 发生（`ActivityView.tsx:352`），机器行保持纯文本（`:327`）。
标题全部同字号，靠字重与留白分级（`styles.css:1608` `font-size: inherit`）。

T-001 acceptance 第 1 条「不引入 markdown 依赖」与代码矛盾，已单独核实并判定为
**被 f-22v8frrxw 有意取代**：安全目的（无 HTML 产出故无需 sanitise）由更强的性质
——remark 停在 mdast 语法树——承担，手段性约束作废。记录在
`artifacts/T-001-dependency-ban-superseded.md`，避免后续审查反复报成缺陷。

同轮另有发现：本 Feature 的四项头号构造（表格、嵌套列表、引用块、水平线）**曾无任何断言**，
已补 5 条并逐条变异验证，详见 f-22v8frrxw 的
`artifacts/implementation-review-T-003.md`。

## T-003 让每个 Agent 知道自己能开分栏 —— 通过（实测）

注入路径唯一且覆盖全部 provider：`client.ts:740` 调
`composeAgentLaunchPrompt(input.prompt, input.injectAgentMuxGuide)`，
结果直接喂进 `provider.buildLaunch({ prompt })`（`:744`），
而 buildLaunch 是把 prompt 放进 ctxmux spawn argv 的那一步——
无论 provider 的 prompt 形态是 positional argv、`--query` 还是 `--prompt-interactive`。

**gate 是行为断言而非文本包含断言**，这正是 acceptance 点名要求的：
`agent-launch-prompt.test.ts:49` 起遍历 `providers.catalog()` 的**每一个**内置 provider，
断言 guide 文本确实落进 `buildLaunch(...).args`。

变异验证：把 `composeAgentLaunchPrompt` 改成直接返回原 prompt（不再前置 guide）：

```
npx vitest run packages/core/test/agent-launch-prompt.test.ts
→ Tests  12 failed | 10 passed (22)
```

12 条变红，覆盖每个 provider。已还原源文件并 diff 确认逐字节一致。

**不新增 surface kind、不新建第二条 agent 驱动 UI 的通路**：分栏方向由既有
`open` / `arrange` CLI 表达（`--left-of/--right-of/--above/--below` 与 arrange 预设，
`agentmux-cli-help.test.ts:32-45` 有断言），提示只负责让 Agent 发现它存在。

一处观察（非缺陷）：resume 路径（`client.ts:1014 buildResumeLaunch`）不重新注入 guide。
这是对的——resume 复用的是一个创建时已经收到过 guide 的 agent，
而 acceptance 针对的是启动/spawn 的发现路径，该路径已覆盖全部 provider。

## T-004 收尾

- 密度合同已记录 markdown 渲染边界（GFM 子集、不产 HTML 故无需 sanitise、
  标题靠字重与留白、宽表自滚、链接经既有 openExternal seam）。
- 交互合同**本次补上**了缺失的 Agent 侧事实：分栏打开经既有 `open`/`arrange` CLI，
  启动提示负责发现，不新建第二条通路，且验收须为行为断言。
  （审计曾指出这条只存在于 ideas/index.md，未进 docs/design。）
- 统一门禁 `pnpm check` 通过。

## 结论

无 blocking 发现。两条行为均已写进设计 SSOT，注入路径覆盖全部 provider 且被行为断言守住。
