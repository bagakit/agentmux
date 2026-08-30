# 交接：AgentMux 当前交付与 ModelTrace 测试

## 交接目标

把本轮已完成的 AgentMux 修复、打包状态、ModelTrace 页面操作结果，以及下一项待做需求交给下一位 Agent。仓库路径：`/Users/bytedance/proj/priv/bagakit/agentmux`。

## AgentMux 当前状态

最近一次交付提交：`31b833f8989944f64cb50cd1898766d15d4124d5`（`fix(desktop): keep agent results compact and Claude prompts deliverable`）。

已完成并验证：

- Claude 终端恢复 indexed ANSI / truecolor 颜色；子进程环境使用 `TERM=xterm-256color`、`COLORTERM=truecolor`，并清理会压制颜色的宿主标记。
- Claude Prompt 提交改为先渲染 Composer，再单独发送 Enter；真实新 Claude Session 已验证 payload 与 submit 都收到确认，最终状态为 `done`。
- `Result ready` 面板改为紧凑摘要，详情按需展开，在小 Region 中可关闭，不再遮挡工作面。
- Message Tool 在未到底部时显示“跳到最新消息”，已经到底部时隐藏。
- 重启恢复、Session/Tab/Region 放置等上一轮功能保留，未引入第二套 Runtime 或 Session 所有权模型。

打包与安装：

- 已安装：`/Users/bytedance/Applications/AgentMux.app`
- DMG：`apps/desktop/release/mac/AgentMux-0.1.0-darwin-arm64.dmg`
- 安装包对应提交：`31b833f8...`
- 当时工作树为 clean，应用已重启。

验证记录：

- Core typecheck、Desktop typecheck 通过。
- Claude prompt、provider contract、terminal color、Result ready、Message Tool 等聚焦测试通过。
- 已做三次变异测试，分别证明 Claude submit、extended ANSI palette、Result ready dismiss 均被测试真正覆盖。
- Core 全量测试中，离线 npm cache 缺少 `yaml@2.9.0` 导致 `package-consumer.integration.test.ts` 无法运行；这是环境依赖问题，不是本轮实现失败。`agent-mailbox` 的 Claude fixture 问题已修复并单独通过。

## 尚未实现的新需求

用户提出的新方向：把 `<amux from="amux">...</amux>` 包裹的 AgentMux 出站消息做成特殊视觉语言：

1. 在终端模式中保留原文，同时对这类信封内容特殊着色。
2. 在对话模式中把同样内容识别为重点消息，渲染成特殊卡片类型。
3. 终端和对话模式应共享同一个识别/语义规则，不能各写一套厂商或站点特判。
4. `from="amux"` 只是可伪造的文本声明，不能作为权限、信任或授权依据；入站解析不得把它升级为安全凭据。

这项需求目前只完成了设计方向讨论，尚未修改代码、设计 SSOT 或 Feature Tracker。开始实现前必须：

- 更新 `docs/design/agentmux-desktop-interaction.md` 与 `docs/design/agentmux-surface-density.md`；
- 用仓库规定的 `feature-tracker.sh` 建立或更新 Feature，并提供 approved review artifact、可证伪 acceptance 和 verification command；
- 先定位出站 `<amux>` 信封生成、终端渲染和 `ConversationMessage` / `AgentMarkdown` 的公共入口；
- 为“终端着色”和“对话卡片”分别写行为测试，完成变异测试和零调用者检查；
- 不要把某个具体 Agent 或网站名称写进公共解析逻辑。

已有相关设计依据：`docs/design/agentmux-desktop-interaction.md` 的“AgentMux 对 Agent 说的话”一节已经说明信封的可读性和非安全边界；应在该处增补视觉呈现约束，而不是另造一份事实来源。

## ModelTrace 页面操作结果

页面：<https://xqy2006.github.io/ModelTrace/>

已在 Ego Browser 中完成三次挑战并点击“计算归因概率”：

- 挑战 1：326 个数字，计入；
- 挑战 2：320 个数字，计入；
- 挑战 3：332 个数字，计入；
- 有效查询：`3/3`；
- 最可能模型：`gpt-5.6-luna`；
- 统一库概率：`100.0%`；
- GPT 模型家族概率：`100.0%`。

浏览器页面已保留，Ego Browser TaskSpace 为 `2`，页面标签为 `p1`。如果需要重新查看结果，优先复用这个页面，不要重复生成挑战数据。

## 接手后的第一步

先确认工作树和最近提交，再读取两份设计 SSOT 与本文件的“尚未实现的新需求”。如果继续做 `<amux>` 特殊着色/卡片，先完成设计约束和 Feature Tracker 计划，再进入实现；如果只是复核 ModelTrace，直接查看已保留的 `p1` 页面即可。
