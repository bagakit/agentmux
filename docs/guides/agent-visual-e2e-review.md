# 独立 Agent 看图评审

所有界面设计改动的高审美独立评审、修正复拍直至明确满意／可交付的约束唯一见交互 SSOT[《Agent 主观审美的端到端验证》](../design/behavior/shared-rules.md#agent-主观审美的端到端验证)。交付前在真实产品场景里操作、采图，由独立 Agent 实际打开完整截图并判断；两份设计 SSOT 定义约束，截图、意见、修正和最终满意结论保留在同一轮证据中。测试全绿或采图成功不能代替审美评审。本页唯一持有评审的操作流程、采图入口、复拍条件与交付前消费意见；[AGENTS](../../AGENTS.md#需求与验收) 与[测试策略](../testing/strategy.md#gate)只引用本页。

首个实际场景是 [Message Tool 的 composer-visual probe](../../apps/desktop/scripts/fixtures/agent-region-identity-menu/composer-visual.md)：正常与窄双分屏，输入短草稿，依次打开工具行和长文本输入，再打开 Mailbox，填写并关闭持续推进设置，收回一行后查看持续推进各状态，最后检查 Mailbox 的悬停访问与最近顺序。场景说明列出真实入口、当前 SSOT 章节、操作、观察对象和 preview 数据边界。

```sh
pnpm --filter @agentmux/desktop capture:visual
```

手机 Web client 使用自己的采图入口，步骤见下文[手机 Web client 采图](#手机-web-client-采图)；其他表面必须覆盖的场景见[各表面的场景要求](#各表面的场景要求)。

命令打印本次 `receipt.json` 与 `review.md` 路径。`review.md` 列出场景、截图与私有编译身份；逐张打开 PNG 看完整画面。命令只采集，JSON 明确 `captureOnly: true`、`aestheticReview: not-performed`；它不打包、不安装、不修改产品源码或操作用户 Session/Run。preview API 的真实 Renderer 证据不证明真实 CLI、Native 或整个产品。采图失败如实记录并修复采集步骤，不关闭健康 Agent。

可直接交给独立 Agent 的请求：

> 请先读两份设计 SSOT 的有关约束，再逐张实际打开本轮 review.md 所列完整截图。结合实际场景与操作顺序，判断任务主次、紧凑、对齐、留白、信息可读性和控件清晰性。写一份短评审：实际看过哪些图、具体位置有什么观感、是否需要修改以及建议。明确未知和未确认范围；不要以像素距离、差异分数、CSS 在场或固定评分替代判断。未看见截图时不能签通过。

评审者直接使用已有图像观察能力，短报告链接本轮截图和采集结果。发现问题后实施修正并复采同一场景；旧图与旧意见保留。后续界面复用其已有真实 probe，并在各自 fixture 目录放场景说明，引用当前需求 SSOT、记录实际操作与模拟边界；SSOT 变化后由 Agent 检查场景对应性。不增加中心注册表或评分框架。

打包、`update:local` 或 `update:renderer` 前，交付 Agent 必须消费本批候选的独立看图意见，并在交付说明中给出结论和边界。只有影响已评审界面的代码改变后才重新采图；无关提交、仅增加评审文档或打包本身不要求重拍，也不构成打包前的重复图审（打包边界见 [macOS 打包指南](macos-packaging.md#必要核对与触发式补查)）。没有图、没有实际看图或仍需修改时，如实保留未完成，不宣称审美已验收。当前发布入口尚未机械检查审计证据，不能据此宣称已有每次自动执行的保证；执行保证的约束见交互 SSOT[《Agent 主观审美的端到端验证》](../design/behavior/shared-rules.md#agent-主观审美的端到端验证)。

## 各表面的场景要求

以下是各表面在本页流程之上必须覆盖的实际场景；界面约束本身仍归各自的设计专题。

所有表面通用：

- 宽窄视觉验收以实际工作面为输入，并核对健康 Run 没有因开合、尺寸变化或联动被停止或重复创建。
- 有开合或过渡反馈时，独立评审须实际查看操作中的中间帧，以及宽、窄和减少动态效果下的静态终态；只有动画声明或终态截图，不能证明连续反馈已达到要求。
- 受控图像、受控 Session、旧的空页面、CSS 数值或采图成功，都不能代替新设计在实际工作面上的结果。数据与真实进程恢复仍用独立的行为证据，不以截图代替，也不用截图冒称真实厂商材质或全部平台的效果。

[Launcher](../design/behavior/workface-launcher.md)：

- 测试与实际界面验证须包含默认或已保存目标的归档、长名称、窄 Region 和恢复失败，并核对创建目标、原草稿与健康 Run 都被保全。
- 宽、窄、矮 Region，Options 展开，scope 切换，Terminal 收起与展开，Browser 搜索，Note 编辑和 Mote 联动都要有可复查的实际状态。

[Survey 与 Recall](../design/presentation/knowledge-workflows.md)：

- 覆盖正常、窄、短窗口与明暗下的真实内容：多 Group／Tab／混合 Region，多条长 Topic 关系，来源项目，当前操作混合或未知，关联的添加或取消，保存未确认，以及非空管理；层级、滚动、命中、焦点、材料与内容清晰须一起可见。
- 覆盖 Notebook 的切换与创建浮层、树／卡片／图谱视图、空白与长文编辑、归档与来源；并核对 Survey 中已经没有知识模式切换、底部 Webpage 创建、条目动作、折叠图标 rail 与成果保存确认。

Stop、保留 Session、取消等[恢复相关的确认弹层](../design/behavior/session-recovery.md)：从真实挂载的调用方打开，采集完整的明暗、窄、矮、长对象名和忙碌场景；同时保留变异变红、恢复后变绿、非定义调用者与失败的证据。采图与实现 Agent 的自检不代替独立看图；未经独立验收时如实标为未完成。

[Folder 图标的近期活跃色调](../design/behavior/spaces-and-layout.md#folder-图标的近期活跃色调)：以实际 Space Folder 行可见对应色调为准，受控图像和受控 Session 的测试通过不能代替。

### 手机 Web client 采图

检查重点见[手机客户端的呈现](../design/presentation/mobile-client.md)。

1. **实际操作与采图。** 从仓库根目录运行 `node apps/mobile/scripts/fixtures/mobile-product-redesign/capture-ui.mjs`，经受控 Chromium 操作真实的 `MobileApp`；尺寸、深浅主题、专项参数和模拟边界见 [scenario.md](../../apps/mobile/scripts/fixtures/mobile-product-redesign/scenario.md)。保留完整 PNG、`receipt.json`、`review.md` 与编译身份。选取实际受影响的场景；共享选择器变化须覆盖它的真实消费者，缺少的场景先补齐，不能用一次默认采图代替全部覆盖。
2. **独立看图。** 未参与该实现的 Agent 逐张打开完整截图，结合切换、面板、输入和错误状态的操作顺序，判断主次、密度、对齐、遮挡与操作可达；结论写明具体位置和未确认的范围。
3. **修正与复拍。** 需要修改时复拍对应场景，直到明确可交付，保留旧图与旧意见。局部画面、CSS 在场或采图成功都不能代替全屏的审美结论；动效按[动态视觉的浏览器成本验证](../testing/strategy.md#动态视觉的浏览器成本验证)取得真实渲染证据。
4. **行为不退化。** 状态、提醒或动作的变更，须经真实 `MobileApp` 消费者证明未知仍可见、恢复仍可达、触控与阅读空间仍保留，并用实际加载的变异证明改坏会变红。

受控 Chromium 不等于真机。iOS／Android 的输入法、系统键盘、安全区、前后台切换与 Safari 绘制需要设备证据；交付说明写明已测和未测的范围。
