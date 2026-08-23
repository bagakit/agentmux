# Review: Terminal 内容层与输入层清晰度

日期：2026-09-22

## Reviewed goal

用户反馈 Terminal 画面出现点阵/装饰层与输出、Composer 混在一起，整体显得脏乱，要求定位并修复真实渲染边界。

## Approved closure

- 只修复通用的 Terminal 内容层、状态层和 Agent Composer 的几何/层级边界，不按某一条命令、Provider 或站点写特例。
- 以真实 DOM/CSS 证据确认 xterm 容器、恢复状态、服务窗和 Composer 的可见区域互不重叠；保留已有输出与健康 Run，不用视觉层掩盖生命周期事实。
- 用窄栏、隐藏/切回、恢复失败和 reduced-motion 场景验证；变异测试证明边界规则实际被调用。

## Constraints

- xterm 是唯一 Terminal 画布 owner；装饰只存在于空内容状态层。
- Composer 独立占据输入行，不能继承或透出 Terminal 的背景纹理。
- 任何流程失败继续走服务窗，不在 PTY 写诊断字符串，也不阻断健康 Session。

## Review decision

状态：**approved**。
