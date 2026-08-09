# T-021 外部依赖核实：ctxmux public SDK 目前没有 Remote 合同

日期：2026-08-29
核实者：主 session
结论：**T-021 现在无法诚实交付**，因为它依赖的外部合同尚不存在。

## T-021 要什么

验收第一条：

> ctxmux public SDK 提供版本化 Remote connector、Host/Build/Capability 身份、
> 显式部署/升级和 partition recovery；AgentMux 不复制 Private Key、不静默安装、
> 不开放未授权监听端口，也不自建 proxy wire。

即：Remote 能力必须**来自 ctxmux 的公开合同**，AgentMux 不得自建 proxy wire。

## 核实：那个合同不在

解包仓库内 vendored 的 `@ctxmux/sdk@0.0.0`
（`packages/core/vendor/ctxmux/darwin-arm64/ctxmux-sdk-0.0.0.tgz`，
经 `pnpm-workspace.yaml:10` 以 file: 协议链入），其公开 d.ts 面为：

```
attachment  client  control  index  integration  stop-operation  validation  wire
```

对全部 d.ts grep `ssh` / `Remote` / `remote` / `RemoteConnector` / `remoteHost`：
**零命中**。没有 Remote connector，没有 Host/Build/Capability 身份，
没有部署/升级或 partition recovery 的公开类型。

与之一致的是 AgentMux 自己的现状：`packages/core/src/execution-host.ts:62` 的
ssh host 在 `:86`、`:93` 直接返回 typed `REMOTE_UNSUPPORTED`——
这是**有意的诚实占位**，不是遗漏。

## 因此

T-021 属于 `external_blocker`，与 T-016 当年被阻塞的是同一个根因
（`ctxmux@b2bbc7a` 缺 public License/版本化 Package、SSH transport 等）。
区别在于范围已被重新切分：Local 那一半由 **T-020 完成并已 done**，
SSH 这一半仍等待上游。

**不应该做的事**：为了让 task 数归零而自建 SSH proxy wire 或绕过公开合同。
那会同时违反 T-021 自己的验收（"不自建 proxy wire"）与项目原则
（"架构决策往长了做，不接受先这样以后再换"），并制造一个上游合同落地后
必须拆掉的第二运行时。

**正确处置**：把 T-021 标为 blocked 并记录 `external_blocker` 与本核实，
等 ctxmux 发布带 Remote 合同的版本化 SDK 后再解锁。
现有的 typed `REMOTE_UNSUPPORTED` 已经如实表达了"还不支持"，
产品不会因此对用户撒谎。
