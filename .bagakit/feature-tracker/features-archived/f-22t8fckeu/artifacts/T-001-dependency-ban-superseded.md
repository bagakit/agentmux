# T-001 验收文本与代码的矛盾：已核实，判定为「被后续 Feature 有意取代」

日期：2026-08-29
审查者：独立审计 agent（未参与实现）+ 主 session 复核

## 矛盾是什么

f-22t8fckeu T-001 的 acceptance 第 1 条写着「不引入 markdown 依赖」（当时仓库确实没有
marked / markdown-it / react-markdown / remark）。而今天的代码
`apps/desktop/src/renderer/src/lib/agent-markdown.ts:1-3` 明确 import 了
remark-parse / remark-gfm / unified，`apps/desktop/package.json:41-45` 也声明了它们。

字面上，T-001 的验收文本与代码相互矛盾。

## 核实结论：不是缺陷，是有意的后续取代

这个依赖是 **f-22v8frrxw**（Full Markdown in the Conversation）有意引入的：手写解析器
渲染不了 GFM 表格、会压平嵌套列表、把引用块和分隔线当纯文本，因此按项目原则
「优先用成熟的、有人维护的库，没有明确理由别自己重写」换成了 remark，并**删除**了
手写解析器（不保留兼容层，符合原则）。

关键在于 T-001 真正要守的**安全结果没有被破坏**，而且理由是结构性的：

- remark 停在 **mdast 语法树**，从不产出 HTML；
- 不可信文本变成 React 元素，`dangerouslySetInnerHTML` 在全仓从未出现
  （grep 只在两处注释里出现，都是在解释它为何不存在）；
- 因此「无 HTML 产出 → 无需 sanitise」这条性质仍然成立。

选 remark 而不是 marked / markdown-it 正是为了这一点：换成产 HTML 的库，就会连同
它的输出一起引入「永远要正确中和这些输出」的义务——那个义务迟早会被履行错。
这条理由已经写在 `agent-markdown.ts:15-21` 的注释里，是代码自带的 SSOT。

## 处置

**不改代码，不改依赖。** T-001 的实现目标（有界节点树、不产 HTML、无需 sanitise、
恶意 href 逐字保留不执行、畸形输入不抛）全部由现有代码与测试满足
（`apps/desktop/test/agent-markdown.test.ts` 21 passed，断言的是派生结构而非文本包含）。

被取代的只是当时那句「不引入依赖」的**手段性约束**，不是目的。目的是安全边界，
它今天由「解析器只产语法树」这条更强的性质来保证。

记录于此，避免后续审查把这处矛盾重新报成缺陷。
