# 公共控制与客户端的呈现

本文保存本主题的视觉、密度与控件约束；行为、身份和动作资格引用交互合同，不在这里复制。原有未确认范围按正文状态阅读。

[返回视觉与密度合同](../agentmux-surface-density.md) · [同主题交互](../behavior/public-control.md)

**本页章节**

- [Agent-first 的 Space 工作入口](#agent-first-的-space-工作入口)
- [手机版 Relay 连接的呈现](#手机版-relay-连接的呈现)

## Agent-first 的 Space 工作入口

Space / Zone / Tab / Region、Project 与 Workspace 的统一含义只定义在交互 SSOT[《统一概念与空间寻址》](../behavior/spaces-and-layout.md#统一概念与空间寻址)；`agent open` 与 `space mv` 的行为只定义在[《Agent-first 的 Space 工作入口》](../behavior/public-control.md#agent-first-的-space-工作入口)。工作面、原执行目录与失败说明沿用现有 Tab/Region、服务窗和身份展示语言；本轮统一合同并闭合 CLI，不新增 Renderer 控件或视觉层，不把全仓改名当成概念统一。


## 手机版 Relay 连接的呈现

行为、分层、连接、工作面与恢复唯一见交互 SSOT[《手机版 Relay 连接》](../behavior/public-control.md#手机版-relay-连接)。手机独立外壳适配触摸、软键盘和窄/矮视口，共用原对话组成与终端阅读语言；身份、输入能力、请求与unknown清楚可达，不仅缩小Desktop。真实操作采图与独立审美沿既有视觉E2E，采图成功不代表通过。

手机整体沿 AgentMux 的安静、紧凑工具语言。底栏五个主入口等宽，Mote 正中作为身份锚点，不做浮起的创建按钮；选中态同时用表面填色、图标或文字强调以及可访问的当前页面事实。辅助能力由左上菜单揭示，原工作面保持挂载。

比原手机外壳缩小标题、正文、元信息与段落留白：标题约17px、正文13px、元信息11px，内容横向留白12px，行和章节优先用轻分隔表达结构，避免每段都套卡片。视觉尺寸与点击范围分开，主要触摸目标至少44px；编辑字段保持16px以避免iOS聚焦自动缩放。五入口在320px宽度仍完整可读，菜单、长名称、未知回执和软键盘不挤掉编辑器或关键操作；减少重复身份标题和终端切换按钮。安全区、键盘收起底栏与矮视口滚动沿原viewport owner。
