# Plan Review r1 — Launch Argument Tokenisation (f-2348f78d7)

Meta: `f-2348f78d7` reviewed task plan (revision 1) 的评审依据。本轮为 bug 修复，代码在计划落盘前已完成
并通过针对性测试；本文件记录根因与验收，使这次修复留下可追溯的账。

## 用户原始报告（逐字）

> error: unknown option '--dangerously-skip-permissions --model 'default' --effort 'ultracode''
>
> 启动指令加引号的时候，位置加错了。应该先把空格划分开，然后再去给它追加引号

## 根因（已核实）

`AgentSettingsPane.tsx` 保存 executor 时对 Arguments 文本框做的是 `draft.args.split('\n')` ——
**只按换行切分**。用户在一行里写多个 flag，整行就成为**一个** argv 元素，下游 CLI 把它当作一个未知选项拒绝。
用户的诊断准确：切分必须先发生，且要按 shell 的方式理解空格与引号。

`--dangerously-skip-permissions` 与 `ultracode` 在整个仓库中不存在，证实这串来自用户在该文本框里的自由输入，
而非 AgentMux 内部拼装。声明式的枚举选项那条路（`resolveLaunchOptionArgv`）产出的本就是已切分数组，未受影响。

## 修复取向

用成熟库 `string-argv` 而非手写切分：引号是 shell 语法而非值的一部分，转义与混合引号的边界由被维护的解析器承担。
换行仍作为分隔符，因此旧的"每行一个 flag"写法继续可用——这不是兼容层，而是同一套 shell 语义的自然结果。
UI 提示同步从"one per line"改为"space or newline separated"，否则界面仍在教用户用会出错的写法。
