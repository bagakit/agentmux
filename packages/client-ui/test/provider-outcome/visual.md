# 原生失败阅读场景

本场景沿 [原生请求与轮结果](../../../../docs/design/behavior/conversation-mode.md#原生请求与轮结果) 与 [原生失败与中断结果](../../../../docs/design/presentation/conversation-mode.md#原生失败与中断结果) 验证共同阅读表面，不在此重写行为或呈现合同。

执行 `node packages/client-ui/scripts/capture-shared-conversation.mjs --conversation-only`。现有 Gallery 的对话场景通过 Core 公共投影进入生产 `ConversationView`，依次呈现用户输入、部分说明、失败结果和下一轮说明。数据是明确的公开 DTO fixture；实际 Provider 原始记录到共享组件的调用链由相邻测试验证，截图不代表真实模型请求或用户 Session。

采集在私有 Electron profile 中运行，分别使用宽、窄视口。每个宽度先查看默认可见的原始失败原因、原轮标识、原 Agent 链接、恢复说明和下一轮，再点击“错误详情”，核对原生错误码、完整轮次、来源与未展开的原始记录。不发送输入，不操作用户 Run。省略该参数仍采集原有 Composer 场景；仅改对话呈现时无需重采 Composer。

采集结果与完整 PNG 写入脚本打印的本机证据目录。按 [独立看图评审](../../../../docs/guides/agent-visual-e2e-review.md) 实际打开完整图片，判断轻重、密度、换行、上下文连续性和详情控件；采集成功不等于审美通过。
