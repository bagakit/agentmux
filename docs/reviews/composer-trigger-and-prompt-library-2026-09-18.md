# Composer 触发收敛与本地 prompt 库复核（2026-09-18）

用户就 Composer 提了三个概念问题加一条新能力。四条逐一对码核实后**全部成立**，且根因互相咬合——删掉重复入口同时缓解窄宽度排版。本文只记复核结论与被驳回的做法；需求约束本身写在设计 SSOT（`docs/design/agentmux-desktop-interaction.md`「Agents、队列与 Message Tools」「本地 prompt 库与识别词」两节、`docs/design/agentmux-surface-density.md`「Composer 状态与队列密度」），不在此重抄。

## 核实结论

**一、收起入口确实有两个，且共用同一枚图标。** `AgentComposerTools.tsx:38` 的 `.composer-tool--mode` 与 `AgentComposer.tsx:266` 的 `<summary class="composer__disclosure">` 都渲染 `<SemanticIcon name="message-tools">`，同映射到 `SlidersHorizontal`（`semantic-icons/index.tsx:58`）。用户的判断「概念上重复」成立：两者管的是同一件事，而图标不给用户任何区分线索。

**二、窄宽度排版坏在「折行」与「绝对定位避让」叠加。** 左簇今天最多 10 项；`.composer__toolbar` 是 `flex-wrap: wrap`（`composer.css:50`），窄了折行；而 `<summary>` 在 `[open]` 态绝对定位（`:56`），靠 `.composer[open] .composer__toolbar { padding-left: 42px }`（`:58`）给它让位。折行后让位与绝对定位一起错位。删掉第二入口即同时拆掉这个 42px 契约。

**三、两套 prompt 并存，且合并它们的那段代码是死的。** 这条是本轮唯一「看着已经修好、实际从未生效」的缺陷，值得单独记：

`COMPOSER_PROMPT_PRESETS`（`composer-semantic-reference.ts:50`）只能从两枚常驻按钮到达。看起来负责把它并进 `/` 候选的是这句——

```ts
const preset = COMPOSER_PROMPT_PRESETS.find((entry) => entry.text === item)
```

（`AgentSessionComposer.tsx:266`，`ObservationSurfaceGallery.tsx:102` 同款）

它**恒返回 `undefined`**。`item` 来自 `commands`，而 `commands` 只装 Provider catalog 声明的命令；13 家内置 Provider 加起来是 `/compact /context /cost /diff /help /model /status`，无一等于 `/review-changes` 或 `/summarize-progress`。**今天用户打 `/review`，一条候选都不会出现。**

判别器（可复用）：判「两套东西是否真的已经合并」不能读桥接代码的意图，要从**消费侧的数据来源**反推——数一遍 `commands` 实际装什么。`tsc` 干净、测试全绿、review 看不出，因为那句 `.find()` 长得就是「已经合并了」的样子。同族记忆：判在场 ≠ 判可达。

**四、识别词不需要新依赖。** 已装的 `@tiptap/core@3.31.3` 自带 `addDecorations()` 钩子（`addDecorations?: (this: {…}) => DecorationSpec | null`）并导出 `Decoration`，下划线装饰无需加包也无需手写 ProseMirror 插件。替换动作有现成实现可抄：`InlineComposer.tsx:46-48` 的 subcommand node view 即「就地换成 `draftDocument(reference)`」。

## 决定与被驳回的做法

**内置那两条 prompt 降为可改可删的默认项，落进用户配置**（而非「内置只读 + 用户自定义并列」）。用户原话是「应该只有一套」；保留一档不可删的内置就是保留两套数据所有权，只是把重复从界面挪到了数据层。删掉即永久没有，不回填。

**不 bump `CONFIG_VERSION`。** 新字段可选即可——`notifications`、`terminalFontSize`、`agentAutomation`、`appLinkSchemes` 四个字段都是这样落地的。缺席就地解析成 `[]` 且**不回写盘**，同 `appLinkSchemes` 的理由：空与缺席同义，补一次盘只是白写。

**keyword 一个字段供两处识别**（`/` 候选与裸词），不建第二份注册表——否则两份清单必然漂移，且漂移时自己不会响。

**窄宽度先只做删除，不预防性加响应式机制。** 删掉绝对定位入口与两枚最宽的按钮后先真机看窄宽度，仍不行再降级为图标态。若最终要用容器查询，须注意 `container-type: inline-size` 隐含 layout containment，会让 `.composer` 成为 fixed 定位后代的包含块，而 `.composer__queued-card` / `.composer__context-card` 正是 `position: fixed` + `position-anchor`——**必须真机验证过再落**，不按推理写。窗口级 `@media`（仓内 4 处）量的是窗口不是 Region 宽度，对可分屏的 Composer 是错的尺子。

## 验收补充

- **`.composer[open] .composer__toolbar` 的例外条目必须随删除一起移除**（`surface-scale-contract.test.ts` 的 `LAYOUT_GEOMETRY`）。该测试的 `names its exceptions` 断言每个例外选择器真在样式表里，留着即假红。
- **`min-height` 不得新增第二处**：`agent-composer.test.tsx:641` 断言全表匹配 `.composer`+`.tiptap` 的 `min-height` 恰好一处，且穿透 `@media`。大输入框态只动 `max-height`。
- **设置页关键词不得含 `tmux` / `worktree`**：`settings-search.test.ts:38-39` 硬钉这两词各只出一个 section。
- **裸词候选不能沿用 `item.text !== trigger` 排除**，否则打全 `eli5` 后候选消失、Tab 无从下手。
- **keyword 列表必须实时读**：`useEditor` 的 extensions 用 `[]` memo，闭包捕获快照会让改了设置编辑器不跟着变；走既有 `latest.current` ref 传 getter。
- 变异测试对**下划线判定**、**Tab 只在命中时拦**、**候选来源并集**各做一次，且必须是块级变异。零调用者检查尤其要覆盖新配置字段——纯描述字段没有消费者等于谎言免检。
