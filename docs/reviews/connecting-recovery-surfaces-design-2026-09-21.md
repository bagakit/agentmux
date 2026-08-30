# Connecting 与 Terminal 恢复页设计评审

日期：2026-09-21
范围：`f-27x8fkd5k` 的 Connecting、Terminal 恢复和恢复边界
设计 packet：本地 design packet `connecting-recovery-surfaces`（非仓库内容）。

## 结论

采用“当前 Region 的全页状态舞台”作为 Connecting 的主形态。它保留窗口级 Titlebar、Tab、分屏边界与原工作面，只占满正在等待的 Region；因此用户知道自己仍在原来的工作面里，而不是被送进独立启动页。

Terminal 恢复不固定采用全页遮挡：没有可显示的当前终端画面时使用同族的全页恢复舞台；已有画面或 Run 仍健康时交还画面，用边缘恢复层和服务窗说明未完成的握手、尺寸确认或输出通道步骤。健康终端不能因为我们的流程卡住而永久显示 restoring。

## 视觉方向

- Graphite 深色 Surface，Mint/Green 表示建立或重建，红色只表示真实失败。
- 解构切片、注册标记、斜向扫描线和不对称留白组成中层动势；Executor、阶段标题和初始 Prompt 是稳定的前层锚点。
- 动画表达“建立秩序”，不表达虚构进度。禁止百分比、倒计时、整屏闪白、随机 glitch、持续抖动和装饰性进度条。
- 真实 attach 或 replay→live 边界到达后才收敛退出；动画结束不能被当成 Runtime 完成。

## 行为与可访问性边界

- Connecting、restore、replay、size-confirmation、output-channel-reconnect 要用事实性文字区分。
- Prompt 始终可读、可选择、可复制；窄分屏纵向滚动，不让动效遮住文本或控件。
- `prefers-reduced-motion` 冻结为仍能读出状态的一帧，去掉运动但保留注册标记和事实文案。
- 320px、420px 需要保留标题、Executor/Terminal 身份、Prompt 复制命中区和恢复动作。
- 超时放行时保留 Region 和服务窗，诚实说明“画面已交还、哪项能力仍未知或未恢复、下一步怎么做”。

## 评审决定

本方向作为实现前的设计约束通过，后续实现必须补真实浏览器的窄分屏与 reduced-motion 证据，并覆盖“已有健康终端时不被全页恢复层永久遮挡”的行为。
