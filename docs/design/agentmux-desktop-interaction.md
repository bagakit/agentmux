# AgentMux Desktop 交互设计合同

本页是交互与行为约束的 canonical 入口，正文按稳定对象与读者问题组织。视觉、密度与控件语言归视觉合同；这里不复制专题正文。

已确认约束、当前实现、历史证据与待确认方案分别表达；专题正文定义要求，不自动证明实现或产品运行已经验收。

[文档导航](../README.md) · [文档事实与维护规范](../guides/document-truth-and-maintenance.md) · [视觉与密度合同](agentmux-surface-density.md)

## 按主题阅读

| 读者问题 | 唯一正文 |
| --- | --- |
| 全局原则、保护边界及文档归属 | [共同原则、设计事实与 Owner](behavior/shared-rules.md) |
| Mote／Work／Know 产品分组、空间模型及 Space 入口、实体寻址与导航布局 | [空间、导航与工作面](behavior/spaces-and-layout.md#空间模型) |
| Launcher 的环境、工具开合、草稿、Mote 创建委托与 Resume | [Launcher 工作起点](behavior/workface-launcher.md) |
| Recall 的 Notebook、页面、块知识与可设置笔记目录 | [Recall 与笔记目录](behavior/knowledge-workflows.md#recallnotebook-与块知识) |
| Survey 的浏览探索与向 Recall／Topic 输送成果 | [Survey 工作流](behavior/knowledge-workflows.md#survey临时-zone-工作面与知识入口) |
| Topics 的分类、主题、讨论、知识沉淀与本地承接 | [Topics 知识库的层级与沉淀](behavior/spaces-and-layout.md#topics-知识库的层级与沉淀) |
| 持久 Mote、PMO、快捷面和原协调上下文 | [Mote 与 PMO 协调](behavior/motes-and-coordination.md) |
| 目标对齐、结果核对、Demand、Board 与 Task | [Goals 与 Demand 闭环](behavior/goals-and-demand.md) |
| 执行焦点、项目泳道、历史与时间音轨 | [Focus 执行上下文](behavior/focus-context.md) |
| Session/Run/View、健康能力、重启和启动事实 | [Session、恢复与启动交付](behavior/session-recovery.md) |
| Composer、Message Tools、阅读、草稿和输入动作 | [Agent 输入与对话](behavior/conversation-input.md) |
| 交互模式与外部群聊的共同语义、状态与投递边界 | [共同对话协议与外部交流入口](behavior/conversation-input.md#共同对话协议与外部交流入口) |
| Provider 能力、语义身份、AgentMux 注入上下文、A2A 与持久消息 | [Provider、身份与 Agent 消息](behavior/agent-capabilities-and-messaging.md) |
| ordered bytes、连续历史阅读、几何和相关成本 | [Terminal、历史与成本](behavior/terminal-reading.md) |
| 协议、导航、自动化、控制交接与批准 | [Browser 工作面](behavior/browser-workface.md) |
| 真实文件、格式、保存、worktree 与 Git 操作 | [文件、编辑与 Git](behavior/files-and-git.md) |
| 配置入口、状态、通知、资源与 Toolkit | [设置、状态与观测](behavior/settings-and-observation.md) |
| 跨模块诊断接入、证据关联、历史/采样边界与错误码 | [Diagnostic Evidence 设计](diagnostic-evidence.md) |
| 对象优先 CLI、公共服务、自操作和跨客户端合同 | [公共控制与跨客户端接入](behavior/public-control.md) |
| Topics CUI 的准确目标、内容修订、转分类与承接回执 | [Topics 知识库的公共接入](behavior/public-control.md#topics-知识库的公共接入) |

## 更新与保全

新约束原位合入所属专题，同一事实只定义一次，其他正文链接到 owner。入口只维护主题导航，不按日期、Task 或聊天轮次追加完整需求。

修改时同步受影响引用，保留原要求的权限、恢复、健康 Run、工作面、相关成本及交付责任；纯文档证据不替代产品行为验收。过程资料只留本机，其 Git 与留存边界见 [过程目录](../process-directories.md)。
