# 等待图标的 Native 布局边界

合同：[动态视觉的渲染边界](../../../../../docs/design/presentation/shared-rules.md#动态视觉的渲染边界)、[动态视觉的浏览器成本验证](../../../../../docs/testing/strategy.md#动态视觉的浏览器成本验证)。

```sh
node apps/desktop/scripts/verify-wait-icon-layout.mjs --mutations
```

场景编译产品 `FullPageLoadingSurface → WaitingActivity → SemanticIcon`、`SurfaceState`、原主题 runtime / sprite / 全部产品 CSS、原 DOM semantic adapter 和真实 xterm。普通 Native Electron 窗口不抢焦点，明确关闭遮挡后台节流，以持续呈现的 120 Hz / 实际显示环境观察；不访问用户 App、原 Session 或健康 Run。

先固定 2 个可见沙漏与输出负载，将无关留存工作面从 200 增加到 16000；再增加到 8 个可见沙漏，以及原 2 个沙漏与 xterm 持续输出共存。每场景观察完整 4.8 秒自然周期，同时保存缩放合格的沙漏像素与实际 SVG use user-agent shadow tree 内 4 个部件的矩阵、透明度和动画政策。Trace 记录部件失效源、Layout 根、Style / Layout / Paint / Layerize / Commit 与去重主线程任务成本；小范围 SVG 动画的局部 Layout 是正常几何更新，1 Hz 计秒文字仍允许对应的 document Layout。固定相关消费者后，无关规模不能把布局带回 document 或显著放大同轮成本。

承重变异仅将共享组件 owner 的 `display: inline-block` 恢复为 `inline-flex`，其余 containment、动画、绘图树、尺寸、主题、工作面和输入保持；同一范围 / 成本判据须红，恢复后须绿。采集与候选绑定实际源码 / CSS hash、Renderer PID、Electron 版本、窗口与 GPU 事实。

行为检查使用原消费者：深浅三套主题、用户自定义 path、原 `--icon-motion-play-state` 暂停政策、reduced-motion、显式隐藏、原 workbench parking / IntersectionObserver、app / region 与窄窗。真实 xterm 在持续输出下向上 / 向下滚动，接受 Chromium 输入与组字提交；动作仍可点击。该输入只进入隔离终端本地接收端，不证明物理键盘、OS IME、Provider / Core / ctxmux Run 或用户原会话恢复。

命令打印本机 `verification.json`，同目录保留完整 trace、输入身份、Native receipt 与完整截图供独立 Agent 看图；脚本不签审美结论、不打包、不安装。
