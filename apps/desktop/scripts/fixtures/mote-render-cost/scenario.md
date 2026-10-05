# Mote 动态的 Native 渲染成本

合同来自[动态视觉的渲染边界](../../../../../docs/design/presentation/shared-rules.md#动态视觉的渲染边界)与[浏览器成本验证](../../../../../docs/testing/strategy.md#动态视觉的浏览器成本验证)。

```sh
node apps/desktop/scripts/verify-mote-render-cost.mjs
```

场景编译真实 `SpaceObjectIcon → MoteIdentityMotion → MoteFace`、共享 motion owner、原产品样式与真实 xterm。在独立的隐藏 Electron 窗口中保留 8 个可见头像，覆盖原 20、26、45、136 px 槽位。头像的 ambient／gesture 与实际 Session 状态更新／指针跟随分别与终端持续输出、滚动、组字提交共存；无关留存 DOM 从 200 个工作面增加到 16000 个，不卸载、不关闭动效。原 SVG、颜色、溢出、槽位、命中、焦点及 reduced-motion／显式隐藏／IntersectionObserver 停活均有实际消费检查。

Trace 同时记录 SVG 失效源、Layout 根、Style／Layout／Paint 时间与交互回执。终端输出与头像在同帧失效时仍可能共用 document 根，因此不要求全场景零 document Layout。局部 SVG 的成本对照与同轮小场景成本预算共同保护隔离；根名称或 `totalObjects` 本身不代表所有节点重排。预算是同轮受控场景的相对值，不是机器无关的毫秒 SLA。

承重变异在真实页面把 face 的 motion 载体恢复为原 `inline-flex`，使 SVG 再次成为 flex item；其余组件、原关键帧、SVG 树、输出和留存规模不变。同一传播范围／成本判据必须失败；移除变异后必须恢复局部布局。

命令输出本机证据目录，包含消费源码与 CSS hash、Native receipt、完整 trace 与截图。截图供独立 Agent 看图评审，脚本不签审美通过。数据是隔离的 typed Session fixture；输入提交到真实 xterm `onData` 本地接收端，CDP 触发真实浏览器组字事件，不宣称物理输入设备、OS IME、真实 Provider、Core／ctxmux Run、恢复或安装验收。不会访问用户已有 Agent／Run。
