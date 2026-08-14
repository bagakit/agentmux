# Hook 安装状态按实际磁盘配置判定

Contract: `bagakit.feature-goal.v1`
Feature: `f-2598fhh62`

## 缺陷

`diagnoseAgentMux` 把 `integration.hookInstallation` 返回成写死的字面量 `'explicit-managed'`，
从不读磁盘上的配置或安装回执；`probeAgent` 只查可执行文件在不在。于是用户手改或被覆盖掉
provider 配置后，Agent 永远不报状态，而 doctor 仍自信地说已安装。

## 2026-09-13 独立复核（一次韧性审查的发现，与原描述同一缺陷，此处并入）

原描述点名 `doctor.ts:169` 一处。**实测是三处**：该字段在三条代码路径上都返回同一个常量
（doctor.ts 的 64 / 169 / 207），成功路径与失败路径给出完全一样的四个字面量。
`hookIngress` / `permissionDefault` / `semanticEvidence` 同属这一组静态返回。

补上原描述没有的那一半——**为什么这个谎能一直不被发现**：托管 hook 安装失败是**被吞掉**的。
`ensureManagedHooks` catch 住任何错误后只发一条 **transient** `agent-error`
（「launching without status hooks」）而不阻断启动。于是失败没有持久痕迹，doctor 又只报常量，
两件事叠起来，用户手里唯一的信号是一条会飘走的提示。后果：agent 全程没有状态 hook，
永远卡在 `working`，没有完成通知。

**最强的证据是同一个返回值里的邻座字段。** `endpointReclaim` 带自检，其注释写着「回收失败不阻断
启动，所以失败本身是静默的——这里是它唯一能被看见的地方」。`hookInstallation` 有**逐字相同**的
静默失败性质，却只报常量。这说明不是没想到这类字段需要探测，是漏了一处。

（同族：`declared-capability-silently-not-done` —— 纯描述字段没有消费者，等于谎言免检。）

## 两种正确结局

1. **改名/改文档**，让这个字段明确只声称报*策略*而不报*状态*。便宜且诚实，但 doctor 自我定位是
   「事前诊断」（见 crash-capture.ts 的注释），报策略解决不了它该解决的问题。
2. **照 `endpointReclaim` 的先例探测**：按 provider 读回磁盘配置，报
   `installed | not_installed | partial | error | skipped`。判据是现成的——installer 的
   `preview()` 已经算了 `currentHash` / `nextHash`，`uninstall` 路径已经在拿磁盘内容做 hash
   比对（managed-hook-installer.ts）。doctor 今天没 import installer，只 import 了
   `runtime-endpoint-reclaim`。

按 doctor 的职责，(2) 才对得上；(1) 是范围不够时的兜底下限。

## 实现时要注意

- 探测必须**按 provider 逐个**报，不能聚合成一个布尔。部分安装（三个 provider 装上两个）
  是真实状态，聚合成 `true` 或 `false` 都是新的谎。
- 加了探测就要有变异证明它咬：把某个 provider 的磁盘配置改坏，doctor 必须从 `installed` 变成
  `drifted`/`error`。字段值恒定的那种「绿」正是本缺陷本身。
- 别让 doctor 的探测自己变成第二个静默失败点——读盘抛错要报成 `error` 态，不是吞掉当 `missing`。

## 归属备注

2026-09-13 我（supervisor）曾就这同一缺陷另建 `f-25c8fjnmp`，属重复建单，已 discard 并指向本条。
本条先到且描述更完整（已点名 `preview()` 的 hash 是现成判据来源、已给出五态）。
教训：把评审发现转成需求前，先按关键词搜一遍需求池——池子里已有 19 条，重名不显眼。
