# 独立 Agent 看图评审

界面改动交付前，先在真实产品场景里操作、采图，再由独立 Agent 实际看图判断。两份设计 SSOT 定义约束；截图和意见保留在同一轮证据中。修正后重新拍同一场景、重新看图，不能用测试全绿或采图成功代替审美评审。

首个实际场景是 [Message Tool 的 composer-visual probe](../../apps/desktop/scripts/fixtures/agent-region-identity-menu/composer-visual.md)：正常与窄双分屏，输入短草稿，依次打开工具行和长文本输入，打开再关闭连续推进详情，最后收回一行。场景说明列出真实入口、当前 SSOT 章节、操作、观察对象和 preview 数据边界。

```sh
pnpm --filter @agentmux/desktop capture:visual
```

命令打印本次 `receipt.json` 与 `review.md` 路径。`review.md` 列出场景、截图与私有编译身份；逐张打开 PNG 看完整画面。命令只采集，JSON 明确 `captureOnly: true`、`aestheticReview: not-performed`；它不打包、不安装、不修改产品源码或操作用户 Session/Run。preview API 的真实 Renderer 证据不证明真实 CLI、Native 或整个产品。采图失败如实记录并修复采集步骤，不关闭健康 Agent。

可直接交给独立 Agent 的请求：

> 请先读两份设计 SSOT 的有关约束，再逐张实际打开本轮 review.md 所列完整截图。结合实际场景与操作顺序，判断任务主次、紧凑、对齐、留白、信息可读性和控件清晰性。写一份短评审：实际看过哪些图、具体位置有什么观感、是否需要修改以及建议。明确未知和未确认范围；不要以像素距离、差异分数、CSS 在场或固定评分替代判断。未看见截图时不能签通过。

评审者直接使用已有图像观察能力，短报告链接本轮截图和采集结果。发现问题后实施修正并复采同一场景；旧图与旧意见保留。后续界面复用其已有真实 probe，并在各自 fixture 目录放场景说明，引用当前需求 SSOT、记录实际操作与模拟边界；SSOT 变化后由 Agent 检查场景对应性。不增加中心注册表或评分框架。

打包、`update:local` 或 `update:renderer` 前，交付 Agent 必须消费本批候选的独立看图意见，并在交付说明中给出结论和边界。候选代码改变后重新采图；仅增加评审文档不要求重拍。没有图、没有实际看图或仍需修改时，如实保留未完成，不宣称审美已验收。当前发布入口尚未机械检查审计证据，不能据此宣称已有每次自动执行的保证；执行保证的约束见交互 SSOT《Agent 主观审美的端到端验证》。
