# Mote 初始化与 Profile 就地编辑

运行 `node apps/desktop/scripts/verify-mote-initialization-renderer.mjs`。

完整生产 App 和普通 Store 初始化复用原 shared-space-frame 场景；本场景只控制公共配置、Files、快捷偏好和空主对话数据。原 Mote 有一个持久 Launcher Tab，未有 Main Agent，预选 cck3。真实 Electron/Chromium 输入依次打开 Profile、Edit profile、首次 Quick mode、展开高级设置并保存继续；宽窄与明暗均采完整画面。

Profile 输入取消后写入原 Launcher 持久草稿；第二个独立 Electron 进程复用同一私有 profile 和同一编译产物，核对原 Tab 与资料草稿并再次打开。禁止创建、停止、写入或发送任何用户 Agent/Run；这是受控公共数据的 Renderer 和持久工作面证据，不证明 Core/Native Runtime 恢复。

约束来自 [Mote 行为](../../../../../docs/design/behavior/motes-and-coordination.md)、《Profile 与完整 Space》的 [呈现合同](../../../../../docs/design/presentation/motes-and-coordination.md) 和 [独立看图流程](../../../../../docs/guides/agent-visual-e2e-review.md)。
