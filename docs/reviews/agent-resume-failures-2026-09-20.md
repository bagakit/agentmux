# 旧 Agent 恢复失败排查

用户已要求查清并修复当前版本多条 Agent resume 失败，打包后继续已确认需求池。

批准的范围：辨明真实原因、修复复现的恢复缺陷、保留 Session/Run 连续性与工作面，提供回归和变异证据；不批量重做旧任务，不停止健康 Agent。

现场证据：2026-09-20 20:14 的 55 条 Core Session 中，30 条旧 Run interrupted，均带 daemon_restart，24 running，1 exited。多数 Provider transcript 尚在。红叹号投影丢掉 interruptionReason，统一说 owner interrupted。一个保留 transcript 的会话界面呈 Resuming，尚无结论证明具体在哪一步等待。不能把推测当根因。

计划 review：approved；依据用户明确要求修复恢复问题及后续继续推进。

## 隔离复现与修复

- 用户确认主要表现是一直 Resuming。真实 Core + HookServer 的隔离复现：旧 Stop Hook 的只读 status 不返回，HTTP 两秒后 503 且 signal 已 abort，但 callback 未结束；resume 的旧 binding.close 因此等待，reservation 已建立而 kernel.start 从未到达。
- 只让这个只读观察响应已有 AbortSignal，即可使旧 Hook 真正 drain、同一 AgentSessionId 和 Provider handle 恢复到新 Run。迟到 status 不再写 hookReceipt/semanticStatus。保留 close 的真实收尾，不假装后台操作已经结束。
- 另一条已证缺陷：30 秒过期可让另一个 Core client 认领仍活着的 owner 的 reservation；只读 CLI 的 connect 同样会触发 recovery。现在以活 owner 为保护边界，过期不是已放弃的证据，进程确实死亡仍能接管。
- 145 项 Core/Hook/Store/连续性及 Desktop runtime-controller 回归通过；取消等待退回旧实现、恢复过期抢占、禁止死 owner 回收三个变异均红。
- caller：observeHookRun 被 acceptHookEvent 的 Stop 观察消费；claimStaleLifecycles 由 registry → client.open/recoverStaleLifecycles 使用，非纯函数孤岛。
- 这证明该等待形状已修，未从旧 App 的 heap 直接取到当时悬挂的 Promise；安装后需要在真实旧 Session 上验证。原 Run/记录/布局不得删除以换取表面成功。
