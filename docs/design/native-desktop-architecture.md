# 原生层目标架构

本页描述[原生层需求](behavior/native-desktop.md)的目标实现边界；源码与安装状态以实际产物和验收为准。

| 模块 | 责任 |
| --- | --- |
| `@agentmux/native-desktop` | 与 Electron 无关的原生能力合同、Node 请求连接与结果解析、网页图像端口、macOS 源码与构建 |
| AgentMux Native | 以 AgentMux 稳定代码身份运行的 macOS 程序；解释 AppKit／AX／ScreenCaptureKit、原生剪贴板和真实输入 |
| Core Native 端口 | 公共方法、Host／调用者授权、原 operation 与 unknown 传递；由宿主注入实现 |
| Desktop Native 适配 | 安装路径、程序启动、资源保存与原 UI 调用接线；不复制原生能力或另存权限事实 |
| Browser owner | 原页面／视口／导航及 GUI capturePage、原 CDP 会话；通过原生层图像接缝输出同一来源的 PNG |

原生进程不成为通用 Run Runtime。只移植 OS 操作必要的连接身份校验与请求关联；上游 Agent session ownership 与特定产品识别不成为 AgentMux 的 Session 真值。控制事实沿机器协议，展示文案不参与授权或状态迁移。

网页像素与屏幕像素分开提供来源，共用图像结果和宿主消费。页面渲染端口由原 Browser owner 注入，保持捕获前后身份检查；没有原生进程或录屏权限时仍能使用网页端口。原生键鼠操作不替换 Browser 原准确 WebContents 输入协议。

macOS 原生应用与主 App 共用既有签名资格入口，各自验证准确标识和默认 DR。Node 连接保留原请求 ID，使用私有 socket 与连接凭据；日志不包含凭据或用户输入全文。客户端取消观察不等于原生动作未发生，未知动作不自动补发。

来源固定到准确的上游 commit；许可和本地修改说明随源码与产物保留。上游后续更新按模块边界评估，不在打包时拉取浮动源码。
