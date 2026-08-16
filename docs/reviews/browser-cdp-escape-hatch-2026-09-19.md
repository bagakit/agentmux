# Browser CDP escape hatch follow-up

Review: approved

依据：对已归档 Browser drive Feature 的独立复核指出，`browser-page-dispatch.ts` 的 `cdp` 分支只有拒绝路径守卫，没有证明成功结果会回到 Agent 的正向行为测试。这个补漏保持既有 Browser drive Closure，不改变 Runtime、协议或用户界面范围。

约束：`cdp(method, params)` 必须原样转发给当前 Browser CDP session，返回 session 的成功结果；session 报告协议异常时，脚本必须收到失败。实现不得把结果吞成 `undefined`，也不得新增站点或厂商分支。

验收：单元测试证明 method/params 和成功结果均被保留；异常仍浮现；把生产转发改为 no-op 时至少一条测试变红。真实 Electron 的既有 Browser drive 闭环继续通过。
