# AgentMux 文档导航

从任务选择入口，按文档职责找事实。长期约束、当前实现、验证结果和历史证据各有来源；写法及维护规则见 [文档事实与维护规范](guides/document-truth-and-maintenance.md)。

## 先理解项目

| 要了解什么 | 入口 |
| --- | --- |
| 产品定位、安装与 Core 使用概览 | [项目 README](../README.md) |
| Agent 的目标、边界和交付责任 | [AGENTS.md](../AGENTS.md) |
| Core 公共 API、Provider 与 Session | [Core 接入说明](../packages/core/README.md) |
| 分屏树代数 / 目标存储 | [Layout](../packages/layout/README.md)、[Demand](../packages/demand/README.md) |

## 按改动定位规则

| 任务 | 唯一规则或机制入口 |
| --- | --- |
| 产品对象、行为、身份、恢复、终端连续阅读 | [交互设计 SSOT](design/agentmux-desktop-interaction.md) |
| 视觉、密度、主题 token、控件语言 | [Surface 与密度 SSOT](design/agentmux-surface-density.md) |
| 终端复制、粘贴、键盘、IME、链接的机制判别 | [终端交互分层](design/agentmux-terminal-interaction-layers.md) |
| 字节到画面、Attachment 与 viewport 链路 | [Terminal Runtime 架构](architecture/terminal-runtime.md) |
| Renderer 更新、应用安装与 Native 保全 | [Desktop 更新架构](architecture/desktop-updates.md) |
| 防止流程失败阻断健康能力 | [红线判定](../RED-LINES.md) |
| 任务验证、变异、调用者、假绿防护 | [测试策略](testing/strategy.md) |
| UI 场景采图与独立审美评审 | [视觉验收指南](guides/agent-visual-e2e-review.md) |
| Agent 用 CLI 操作原工作面 | [对象操作指南](guides/agentmux-cli-object-control.md) |
| 新增设置能力 | [Settings 贡献约定](settings-module-contributions.md) |
| Browser 展示媒体接口与资源 | [ABI](specs/browser-presentation-abi.md)、[资源合同](specs/browser-presentation-resource-contract.md) |

## 当前事实从哪里读取

- 包版本、平台和依赖：各包 `package.json` 与根 `pnpm-lock.yaml`。
- 随包 ctxmux 源码身份、协议、SDK 和二进制：唯一 [vendor manifest](../packages/core/vendor/ctxmux/darwin-arm64/manifest.json)。实际 serving Runtime 身份另由公开 Runtime 事实确认。
- 实现与接线：当前源码及其定义文件外的消费入口；源码存在不代表已经安装或通过行为验收。
- 任务状态与 acceptance：官方 `feature-tracker.sh` 读取 `.bagakit/feature-tracker/`；提交、合并和安装事实各按自己的 owner 核对。
- 验证结果：绑定候选、场景、命令和范围的实际 receipt。测试策略描述方法，不是当前候选的通过报告。

## 历史与本机过程资料

[事故复盘](casestudy/) 保留当时现场和改进动作；[Benchmark 协议](benchmarks/agentmux-daemon-cutover.md) 定义测量方法，历史数值不成为当前预算或排名。

计划、评审、交接、交付清单、状态快照和原型属于本机过程资料，目录规则见 [过程目录](process-directories.md)。它们帮助追溯，不取代长期设计或官方任务状态。受控仓库中的长期入口应独立可读；本机资料缺席须明确缺证，不把缺席伪装成通过。
