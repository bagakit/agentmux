# 同一 Session 恢复后，待发消息只能移至草稿

## 定性

**P0 事故。** 用户在原 Agent Session 中发送一条普通消息，首次写队列失败，随后 Session 语义恢复并换了 Run。旧版 Core 拒绝继续这条尚未派发的消息，Composer 又把重试入口换成「移至草稿」。原 Agent 恢复后能接收新输入，但用户无法在原待发项上继续已经授权的发送。草稿保住了文字，却要求用户另建一次发送才能恢复工作。本文以修复后验收提交 `6b6ad94fde` 为基准。

## 用户可见症状

用户看到「消息绑定的 Run 已变更」，原发送动作变成了「移至草稿」。用户指出：“从用户的角度来说，他根本就不知道这里的 run 换了，而且 session 也是同一个，他凭什么不让继续发呢？”

隔离 Core RPC 复现先拒绝一次队列写入，再让同一 Session 语义恢复。恢复旧拒收逻辑后，重试返回了下列诊断。`not_applied` 和 `confirmedInputBytes: 0` 描述这一次调用，整条原操作的历史仍由 Core 查证。用户截图能确认界面动作，现场原投递记录没有进入此次证据。

```text
STALE_AGENT_SESSION
The original input Run changed before saving.
detail: {"stage":"before-save","expectedRunId":"<runId>","currentRunId":"<currentRunId>"}
controlFailure: {"disposition":"not_applied","confirmedInputBytes":0}
```

同一身份混淆还有一个独立复现。允许 Core 向恢复后的 Run 派发，但让 RPC 解码器沿用旧 Run 核对派发记录，调用方会收到 `CONTROL_PROTOCOL_ERROR`，文案为 `Core RPC result is malformed or belongs to another object.`。这一形态出错时，输入可能已经派发。它是隔离验收中的发现，现场用户报告的是待发项失去发送入口。

## 影响面

- **受影响。** Core 的普通人工输入可以停在首次保存前，Desktop 的待发卡和邮箱会把对应失败导向草稿，Mobile 的待发动作也有按 Run 变化转草稿及拒绝重试的逻辑。公共 `agent.input.submit` 还可能在读返回值时，把新 Run 的有效派发记录判为外来结果。缺陷在通用输入链上。隔离验收覆盖终端派发、一种受管原生对话和本机人工 `agent.send`，其余 Provider 的现场表现未知。证据见 `ee1d3c18dc`、`c1169276c0` 及 `6b6ad94fde:packages/core/test/session-input-recovery.test.ts:151`。
- **仍可工作。** 在旧版本，同 Run 的同一请求可继续，恢复后的健康 Session 也可接收独立新输入。前者由 `a7607d26c4:packages/core/test/session-input-recovery.test.ts:148` 覆盖，后者由 `5fd2e23113` 的红线评审明确记录。部分应用、结果未知或带明确原条件的请求仍有原回执核对通路，这些边界由修复后的测试继续覆盖，见 `6b6ad94fde:packages/core/test/session-input-recovery.test.ts:371` 与 `6b6ad94fde:apps/desktop/test/message-delivery-retry-logid.integration.test.tsx:369`。

## 止血措施

在旧版 Desktop，先从原待发项核对原输入。原操作符合旧版草稿转移条件且 Core 确认未找到原记录时，可点「移至草稿」，审阅文字后另行发送。这样会保留历史，并以新操作发送。原投递结果未知时，继续查原回执。旧版没有在这张卡上继续同一次普通发送的通路。含 `ee1d3c18dc` 和 `c1169276c0` 的版本可直接在原待发项重试，由 Core 判定这次能否首次派发。

## 引入时间线

以下历史根据准确代码段追溯。`-L` 的行号属于命令最后给出的父提交，`--follow` 将该组件的历史锚定在移除旧动作以前。

```sh
git log 6b6ad94fde -S 'The original input Run changed before saving.' --oneline -- packages/core/src/client.ts
git log --no-patch --pretty='%h %s' -L 7562,7566:packages/core/src/client.ts ee1d3c18dc^
git log --no-patch --pretty='%h %s' -L 866,868:packages/core/src/rpc-native-codec.ts ee1d3c18dc^
git log --no-patch --pretty='%h %s' -L 985,1001:apps/desktop/src/renderer/src/store.ts c1169276c0^
git log --no-patch --pretty='%h %s' -L 337,344:apps/mobile/src/conversation/use-mobile-prompt-controller.ts c1169276c0^
git log --no-patch --pretty='%h %s' -L 396,398:apps/mobile/src/conversation/use-mobile-prompt-controller.ts c1169276c0^
git log --follow --pretty='%h %s' c1169276c0^ -- apps/desktop/src/renderer/src/components/ComposerOutbox.tsx
```

| 提交 | 当时的改动及为何漏过 |
| --- | --- |
| `dccf18d6c2` `fix(input): retain original native messages through preparation waits` | **引入保存前拒收。** 在保留原生准备等待和同一输入记录时，以 Run 相等作为尚无保存记录的首个准入条件。首次写入失败后恢复同一对话也命中了它。 |
| `65c99a3ac7` `feat(core): preserve contextual prompts through input transactions` | 为有上下文的请求补强 RPC 结果校验，将输入 key 和派发记录的 Run 都与原请求对齐。严格校验的原则正确，但两种 Run 在语义恢复后可以不同。 |
| `4fbbb91e29` `fix(input): resume retained human waiting through the Core owner` | 给已保存的人工等待接上 Core 恢复通路。第一次保存失败的操作在进入这条通路之前已被拒收。 |
| `651b858ae7` `fix(mobile): cancel undispatched input when its Reader closes` | 调整 Mobile Reader 关闭时取消未派发动作的边界。相邻重试逻辑仍用原 Run 控制是否能调用 Core。 |
| `5fd2e23113` `fix(input): recover drafts after the original Run changes` | 从原记录核对后转草稿，保全正文和诊断。评审继续按退役 Run 能否接收输入来判定，Desktop 因此把转草稿作为唯一恢复动作。 |
| `a7607d26c4` `test(input): cover recovery of drafts after the original Run changes` | 把换 Run 后拒收、转草稿写成回归期望。测试保护了原记录与草稿，却把用户失去原发送入口固定成了通过条件。 |
| `1f2dde4c71` `fix(input): Resume original Core delivery from Desktop and Mobile` | 用原回执接通两端继续投递，Mobile 仍让无 continuation 回执的跨 Run 待发进入草稿分支，漏过首次保存失败。 |
| `1ec3c0febf` `perf(desktop): Scope Composer updates to original input facts` | 缩小 Composer 更新范围，保留了原转草稿资格。性能检查的通过未覆盖恢复后的投递资格。 |
| `ee1d3c18dc` `fix(input): Continue ordinary sends on the recovered Session` | 修正 Core 首次保存与派发回执的身份判定，也接通本机人工的公共消息入口。 |
| `c1169276c0` `fix(composer): Keep original retry available after Session recovery` | 两端恢复普通消息的原重试动作，并移除对应的转草稿特例。 |
| `6b6ad94fde` `test(input): Verify the original send and receipt across Session recovery` | 把同一发送意图成功延续及其真实回执加入回归期望，再分别恢复旧拒收与旧解码条件，证明测试能抓住两种失败。 |

## 根因分析

**直接原因。** Core 在首次保存前把原 Run 变化当成必然拒收，Desktop 与 Mobile 又在客户端消化这类失败，移除原重试动作。返回值解码器在另一处也沿用了同一个假设，于是合法的派发记录也可能被拒绝。原请求 key 里的 Run 记录的是这条输入的逻辑起点。派发资格取得后，实际执行 Run 才跟随本次派发记录冻结。

**判断出了什么错。** 评审把「这条输入能否继续原用户意图」缩成了「能否给退役 Run 写字节」。`5fd2e23113` 的提交说明写道 “Bypassing the existing old-Run fence cannot send to the retired target. It would misroute the original operation. A draft move sends no input.” 当时查证了转草稿不会写字节，却漏问了能否在恢复后的 Run 首次派发。只要 Core 能确认同一 Session 已恢复且原操作未派发，就可以沿同一个 operationId 继续判定资格。旧规则把对退役 Run 的字节保护扩展成了对整个输入意图的拒绝。

**为什么没早发现。** 红线要求确认实际危险和可继续工作的动作。评审有回答，却把用户可另发新消息当成了原能力仍在。旧测试也用「必须转草稿」表达正确性，覆盖了历史保全，没有覆盖「写入失败 → 同一 Session 恢复 → 同一操作成功首次派发 → 读到原回执」这条正向链。结果是 Core、解码器和两端视图能分别守住自身断言，用户却完成不了一次连续的发送。[健康能力与未知状态](../../AGENTS.md#健康能力与未知状态) · [红线四问](../../RED-LINES.md#写拦截前回答四个问题)

## 改进措施

本次沿首次保存、派发结果读取和两端重试路径确认了四处同类误判。当前产品规则统一从队列行为合同读取。[Composer 消息队列与紧凑状态](../design/behavior/conversation-input.md#composer-消息队列与紧凑状态)

1. **由 Core 统一判定原人工输入的首次派发。** `ee1d3c18dc` 用原语义恢复证据、当前权限和相关 Run 上的原认领记录判定资格。保留输入 key、operationId、原文及原去重记录，实际派发目标单独冻结。
   - **是否足够 root。** 处理四处中的 Core 保存准入一处，普通终端输入、受管原生对话和本机人工消息复用原等待与恢复机制。
   - **能否彻底避免。** 符合原资格的发送可继续。已知部分应用或仍未知的输入继续核对各自原记录。
   - **是否降低系统熵。** 删除「Run 一变就拒收」这一无条件策略，复用已有语义恢复与认领检查。增加了必要的相关 Run 查证，查证范围来自这条输入的恢复链。
2. **按各自身份核对 RPC 结果。** 同一提交用原 key 核对逻辑输入，用实际派发 key 核对派发记录和其来源。
   - **是否足够 root。** 处理四处中的 RPC 解码一处，覆盖提交结果携带实际派发记录的情况。
   - **能否彻底避免。** 有效的新 Run 回执能交给调用方，原对象和实际来源的校验仍然生效。
   - **是否降低系统熵。** 复用原回执已有的派发身份，消除一种 Run 必须同时代表两件事的假设。
3. **还原两端原待发项的操作。** `c1169276c0` 让 Desktop 和 Mobile 都用原待发项、原文和原操作调用 Core，界面显示 Core 确认的状态。
   - **是否足够 root。** 处理四处中的两端重试两处，覆盖 Desktop 待发卡和邮箱，以及 Mobile 待发项。Mobile 同时去掉按 Run 变化拒绝请求的额外条件。
   - **能否彻底避免。** 用户可贯通原重试路径。核对失败时，当前进度与原待发项继续可见。
   - **是否降低系统熵。** 删除两端的普通跨 Run 草稿转移分支，复用原发送和核对动作。
4. **用同一次发送成功下达的正例配对未知结果的反例。** `6b6ad94fde` 覆盖上面四处的消费路径，并对两种独立的 Core 错误条件做源码变异。
   - **是否足够 root。** 四处均有消费证据。测试把原输入、真实派发与回执分开断言，也覆盖旧结果未知时的保守行为。
   - **能否彻底避免。** 运行相应回归时能提早发现这类错误，生产中的恢复由前三项实现负责。
   - **是否降低系统熵。** 更新原有测试的行为期望，复用既有测试配置与实际消费入口。变异代码留在测试配置内。

## 验证

- **措施 1、2、4。** `6b6ad94fde` 的定向 Core suite 共 29 项通过，使用实际公开 RPC 和 SQLite journal，在 Runtime／Provider 边界使用受控测试替身。先模拟第一次写入失败，再分别验证同 Run、同一语义恢复、恢复后的原生对话和目标未经确认。确认同一 key 返回实际派发 Run 的回执，重复读取原结果时没有重复派发。实际 Core 生命周期触发恢复及本机 `agent.send` 也在该 suite 内。可见 `6b6ad94fde:packages/core/test/session-input-recovery.test.ts:151`、`:196`、`:371`、`:403`。
- **措施 1 的承重变异。** `reject-uncaptured-resume` 实际加载并恢复 Core 的旧拒收条件。同一 Session 已确认语义恢复的用例在保存前失败，报 `STALE_AGENT_SESSION`。
- **措施 2 的承重变异。** `compare-receipt-with-old-run` 实际加载并恢复 RPC 解码器的旧 Run 比较。相同用例到达再次读取提交结果时失败，报 `CONTROL_PROTOCOL_ERROR`。
- **措施 3、4。** 同一候选的 Desktop 定向 suite 30 项、Mobile 定向 suite 15 项通过。两端挂载实际 Composer、待发项和操作控制器，在 Core 回执边界使用替身。Desktop 从待发卡和邮箱点击，证明原记录读取失败时保留原入口和已有草稿，并等待成功核对。Mobile 重开页面后仍能在同一原待发项重试。两端均核对重试使用原正文及 operationId。可见 `6b6ad94fde:apps/desktop/test/message-delivery-retry-logid.integration.test.tsx:390` 与 `6b6ad94fde:apps/mobile/test/manual-input-receipt.test.tsx:161`。

在 `6b6ad94fde` 的独立源码副本重跑语义恢复用例，基线通过，两项变异分别报上述错误码。加载记录确认测试执行了由该提交源码生成的变异。可在仓库根复跑，按需用 `AGENTMUX_SESSION_INPUT_LOADED` 指定新文件保存加载记录。

```sh
env -i PATH="$PATH" NODE_OPTIONS=--disable-warning=ExperimentalWarning \
  node_modules/.bin/vitest run --config packages/core/test/vitest.session-input-recovery.config.mts

for mutation in reject-uncaptured-resume compare-receipt-with-old-run; do
  env -i PATH="$PATH" NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    AGENTMUX_SESSION_INPUT_MUTATION="$mutation" \
    node_modules/.bin/vitest run --config packages/core/test/vitest.session-input-recovery.config.mts \
    -t 'queue write fails with semantic resume'
done
```

## 遗留

以下按本复盘时（`6b6ad94fde`）的状态记录。

- **PARTIAL，用户现场。** 修复在本地 main 的准确候选上通过 Core 与客户端消费验收。用户截图对应的设备版本和原投递没有取得同一操作的安装、运行及回执证据，现场以原 Session 和原操作的回执为准。
- **PARTIAL，Provider 范围。** 通用边界由受控终端与一种受管原生对话验证。各 Provider 及机器上的语义恢复和派发能力仍沿其原协议证据确认，未逐一实机复验。[输入环境判定与复用边界](../design/behavior/agent-capabilities-and-messaging.md#输入环境判定与复用边界)
