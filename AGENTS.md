# 目标

本项目有两个层次的目标，优先级从核心包到编辑器依次递减。

## 1. 通用本地 Agent 核心包

首要目标是在 `packages/core` 实现一个可独立发布、无 UI 依赖、与宿主框架无关的本地 Agent Runtime。它统一管理 Codex、Claude、TraeX、Hermes、Pi 等 Agent CLI 的能力，并且可以通过清晰的 Provider 扩展新 Agent。

核心包向上提供一套类型安全、稳定、与 Agent 无关的 API，负责 Agent 的发现与配置、启动与停止、会话与进程生命周期、输入输出、状态与事件、权限与交互请求等通用能力。任何项目都应该只需安装该包、选择或注册 Provider、传入工作区，就能将本地 Agent CLI 接入自己的 client，不必重复实现进程管理、终端传输和各 Agent 的协议差异。

`packages/core` 不得依赖 Electron、React 或本项目的编辑器实现。新增 Agent 原则上只需新增 Provider，不应迫使 client 改写交互逻辑。

## 2. Agent 原生编辑器

第二个目标是提供一个对标 a mature workbench 和 a mature workbench 的好用编辑器。它不是另一套 Agent Runtime，而是 `packages/core` 的第一方 client 和完整参考实现，用真实的编辑、终端、会话、工作区、worktree 与多 Agent 协作流程验证核心包的可用性。

编辑器要保持 Agent-first 和 terminal-first：Agent 状态清晰可见，人机交互顺畅，工作区和多会话管理高效，并在信息架构、交互细节和视觉完成度上达到成熟产品水准。所有 Agent 生命周期能力都必须通过 `packages/core` 的公开 API 实现，编辑器不得绕过核心包直接管理 Agent 进程。

# 原则

1. 不保留向后兼容。过时的直接删，别加兼容层、别写migration、别留fallback。
2. 选能满足当前需求的最简单实现。不要预防性抽象，不要多此一举的配置层。
3. 系统分层长。先跑通一个最小的端到端版本，再往上加东西。绝不为了未完成的复杂度拆掉能跑的东西。
4. 组件保持模块化，关注点分离。
5. 优先用成熟的、有人维护的库。没有明确理由别自己重写。
6. 先翻项目里已有的依赖能做什么，再考虑加新包或自己写。别上来就假设库里没有。
7. 架构决策往长了做。不接受"先这样以后再换"的临时方案。
8. 先看成熟产品怎么解决同一个问题，用已验证的模式，别从零发明。
9. 和用户讨论过的内容，要及时更新到需求文档，并尽量用贴近用户原始说法的表述方式。
10. `ctxmux` 是可独立发布和使用的通用 Run Runtime，AgentMux 是它的高级 Client。PTY、进程、
    Run lifecycle、ordered bytes、Replay、Gap、Attachment 与权威 Runtime 事实由 ctxmux 持有；
    Provider、AgentSession、Hook、Permission、Prompt readiness、Agent status 与 semantic resume
    由 AgentMux 持有。不得在任一侧保留第二份实现或把 Level B 暗中降为 Level A。
