# f-22s8fc9kd 独立实现审查（T-003 收尾）

日期：2026-08-29
审查者：主 session（未参与实现）
方法：对着工作树真实代码核对，不采信自述

## 只声明枚举过的值 —— 通过

`packages/core/src/agent-launch-option.ts:274` 起 `CLAUDE_LAUNCH_OPTIONS` 声明两项：

- **model**：fable / opus / sonnet，各自 argv `['--model', <id>]`
- **effort**：low / medium / high / xhigh / max，各自 argv `['--effort', <id>]`

这与 `claude --help` 实际给出的值一致。用户原话是「这两个 flag 的值 claude --help
真的枚举了」，所以据实声明成立。

**两者都不带 tier**（对比同文件的 codex/cursor sandbox 选项带 tier）。这是对的：
tier 分级的是**权限与沙箱危险**，而 model/effort 是能力选择，不是危险选择。

## 另两家保持无按钮 —— 通过

`CODEX_LAUNCH_OPTIONS:216` 与 `CURSOR_LAUNCH_OPTIONS:420` 都只声明 sandbox / 权限类选项，
**没有 model 或 effort 条目**。codex 与 cursor 的 `--model` 收任意字符串、CLI 未枚举，
因此按「未声明即不渲染」保持无按钮——不为它们手写一份模型清单。

这条边界的价值在于：手写模型清单会在厂商改阵容时**立刻过期**，而过期的清单比没有清单更糟
（它会把用户导向一个已经不存在的模型）。

## 一处用词精度的提醒（非阻塞）

`claude --help` 对 `--effort` 给出的是严格 possible-values 枚举；
对 `--model` 是例举式表述（an alias for the latest model, e.g. fable/opus/sonnet）。
两者严格程度不同。设计 SSOT 条款宜以「稳定别名」表述 model，
不要把例举式说成严格枚举——否则合同本身就在宣称一个 CLI 没有给出的保证。
这三个别名指向最新模型且稳定，全名不声明正是因为全名会过期。

## 门禁

`pnpm check` 实测全绿：typecheck + 1208 passed / 0 failed / 3 skipped + build 成功。

## 结论

无 blocking 发现。声明面与 CLI 实际枚举一致，另两家确实无按钮，model/effort 不带 tier 有据。
