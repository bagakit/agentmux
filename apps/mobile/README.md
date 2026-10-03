# AgentMux Mobile

手机是 Mac Host 的 client：继续已有 Agent 的对话、终端观看与明确输入。Agent、Run 和权威历史仍由 Mac 上的 Core / ctxmux 持有。首个连接环境是同一 Wi-Fi，iPhone 优先。

## 构建

从仓库根目录安装锁定依赖，按依赖顺序构建：

```sh
pnpm install --frozen-lockfile
pnpm --filter @agentmux/demand build
pnpm --filter @agentmux/core build
pnpm --filter @agentmux/client-ui build
pnpm --filter @agentmux/mobile build
```

网页产物在 `apps/mobile/dist`。Mac Host 从应用资源提供这份网页和局域网 Relay，不能把 Vite 开发服务当作产品接入。Host 的启动来源见 [Host 入口](../host/src/index.ts)。

原生工程需要先同步这份网页产物：

```sh
pnpm --filter @agentmux/mobile native:sync
open apps/mobile/ios/App/App.xcodeproj
```

用完整 Xcode 选择签名团队和实际 iPhone 后构建、安装。Android 工程位于 `apps/mobile/android`，用 Android Studio 构建。原生包装需要独立的设备验证；网页构建成功不证明原生安装与设备交互已完成。

## 连接

1. 手机和 Mac 连接同一 Wi-Fi。在 Mac 的 Phone & Devices 设置或官方 Phone connection Toolkit 生成并复制完整链接。
2. 手机浏览器打开链接，沿 Paseo E2EE offer 接入；无需填写地址、证书、配对码或返回 Mac 批准。
3. 连通后进入 Mote / Focus / Space。菜单里的手机设置可选择本设备默认主页；连接管理也在菜单中。
4. 按原空间绑定选择已有 Agent。对话和终端为对象的下钻工作面；终端默认观看，控制和尺寸改变均需明确操作。回执不确定时先核对，不自动重发。

工作面导出保存会话引用、布局、阅读位置和本机草稿；重新打开时先保留工作面，再核实 Host 与原 Session / Run。文件导入、手机前后台切换、键盘输入和系统信任需要在实际设备上验收。

公开接口的准确合同沿 [Core hosted 入口](../../packages/core/src/hosted.ts)、[公共 HTTP 入口](../../packages/core/src/public-rpc-http.ts) 和 [共享 Client UI](../../packages/client-ui/README.md)，不在手机端维护另一份 dispatcher 或 Runtime。
