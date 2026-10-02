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

网页产物在 `apps/mobile/dist`。Mac Host 通过显式配置的 `mobileBuildDirectory` 提供这份产物，不能把 Vite 开发服务当作已授权的私网入口。Host 的启动与配置来源见 [Host 入口](../host/src/index.ts)；证书准备入口见 [prepare-private-access.ts](../host/src/prepare-private-access.ts)。

原生工程需要先同步这份网页产物：

```sh
pnpm --filter @agentmux/mobile native:sync
open apps/mobile/ios/App/App.xcodeproj
```

用完整 Xcode 选择签名团队和实际 iPhone 后构建、安装。Android 工程位于 `apps/mobile/android`，用 Android Studio 构建。原生工程采用系统 TLS 校验与设备安全存储；网页构建成功不证明原生安装或手机系统信任已完成。

## 连接

1. 在 Mac 的 Hosts 设置查看实际私网 HTTPS 地址、证书指纹和配置状态。未配置时，按页面提供的真实证书准备入口创建显式 IP / TLS 配置，再由 Host 加载；页面复制的模板需要先填写自己的 IP 和目录。
2. 在手机系统中确认该 Mac 证书的信任，打开手机 App，填写同一 HTTPS 地址并核对 Host 信息。
3. 从 Mac 创建设备邀请；手机提交加入请求后，在 Mac 核对设备与确认码，并通过本次系统确认批准。邀请和凭证不会进入工作面导出文件。
4. 选择已有会话。终端默认为观看；进入控制才发送输入，尺寸调整需要明确提交。发送回执不确定时先核对实际结果，不自动重发。

工作面导出保存会话引用、布局、阅读位置和本机草稿；重新打开时先保留工作面，再核实 Host 与原 Session / Run。文件导入、手机前后台切换、键盘输入和系统信任需要在实际设备上验收。

公开接口的准确合同沿 [Core hosted 入口](../../packages/core/src/hosted.ts)、[公共 HTTP 入口](../../packages/core/src/public-rpc-http.ts) 和 [共享 Client UI](../../packages/client-ui/README.md)，不在手机端维护另一份 dispatcher 或 Runtime。
