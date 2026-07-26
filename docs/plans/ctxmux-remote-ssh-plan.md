# CtxMux Remote and SSH Contract

## 规划边界

这个 Feature 只负责在 ctxmux 发布版本化 public Remote 合同后，消费该合同并把
SSH/Remote 接回同一 AgentMux Run/Agent Session API。AgentMux 不自建 proxy wire、
不复制私有协议、不静默安装远端守护进程，也不把 Local 猜测成 Remote。

## 拓扑

```text
R-001  准备并核验 ctxmux Remote 外部依赖卡点
  └── R-002  等待 ctxmux public Remote SDK 合同（external_blocker）
        └── R-003  准备 Remote Host/Build/Capability identity
              ├── R-004  准备显式 SSH 部署、升级与连接生命周期
              ├── R-005  准备 partition recovery、Input/Output/Stop/GC conformance
              └── R-006  准备 AgentMux integration 与 fallback 删除审计
                    └── R-007  准备 package、consumer 与 release verification
```

R-001 是已有核验记录的准备任务；R-002 是真实外部等待，不得改成“内部实现中”。
R-003 以后全部依赖 R-002，避免在上游合同缺失时预造不可持续的适配层。R-007
只在真实 Remote candidate 存在后执行。

## 现有证据与剩余风险

- `T-021-external-blocker-verification.md` 已核实当前 vendored `@ctxmux/sdk` 没有
  Remote/SSH/Host/Capability/deployment/recovery public 类型；当前
  `REMOTE_UNSUPPORTED` 是有意的 fail-closed 行为。
- `docs/plans/ctxmux-cutover.md` 规定唯一 ctxmux Kernel 与删除 fallback 的边界。
- R-002 的解除条件必须是可审计的版本化 SDK、Remote RunBackend/connector、身份和
  recovery 合同；仅有私有实现、文档承诺或本地 mock 不算解除。
- 每个执行任务保留 command gate；外部等待任务的 gate 只验证依赖仍未满足并记录
  blocker，不把等待本身报告为通过。

