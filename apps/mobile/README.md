# AgentMux Mobile

手机是 Mac Host 的 client。连上之后，可以继续已有 Agent 的对话、回应问题和权限请求、观看或明确接管终端、处理 Goals、Topics 与 Mote，也可以在指定空间里新建 Agent。Agent、Run 和权威历史仍在 Mac 的 Core / ctxmux 上，手机不保存另一份。目前支持的连接环境是手机与 Mac 在同一个 Wi-Fi 下。

## 能做什么

- **导航。** 一级入口从左到右是 Goals、Topics、Mote、Focus、Space；Survey、连接与设备设置收在菜单里。打开时优先回到本设备最近访问的对话。
- **对话与输入。** 对话、Composer、问题与权限卡片和 Desktop 共用 [`@agentmux/client-ui`](../../packages/client-ui/README.md)。支持附件、命令和 Skills；还没确认的发送和草稿保存在本机，重新打开时先保留，再向 Host 核对。
- **终端。** 默认只观看；接管输入和改变终端尺寸都需要明确操作。
- **新建 Agent。** 在选中的空间里沿 `agent.open` 选择 Executor、执行资源与展示位置，保留创建操作的回执和查询入口。
- **Note、Goals 与 Topics。** 读取和编辑沿 Mac 上的原 owner 与文件修订；冲突和未确认的写入会明确保留。

完整行为见[手机客户端](../../docs/design/behavior/mobile-client.md)，界面的尺度、控件与文案见[手机客户端的呈现](../../docs/design/presentation/mobile-client.md)。

## 连接

1. 在 Mac 的 Settings → Remote → Mobile，或状态栏的 Phone connection 工具里，打开连接二维码（也可以展开完整链接）。
2. 用手机扫码，或在手机浏览器里打开链接。链接中带有 Mac Host 的公钥，手机经 Mac 上的局域网 Relay 建立端到端加密连接（Relay 改编自 Paseo）。不需要填写地址、证书或配对码，也不需要回到 Mac 上批准。
3. 连通后进入最近的对话，或从一级入口选择工作面。菜单里可以设置本设备的默认主页、管理连接。
4. 操作结果不确定时，先核对原操作，不自动重发。

设备身份、授权、撤销与重连见[手机版 Relay 连接](../../docs/design/behavior/public-control.md#手机版-relay-连接)；Mac 上由 [Node Host](../host/README.md#phone-access) 提供手机网页与 Relay。

## 构建

在仓库根目录安装锁定的依赖，然后构建手机网页及其全部依赖包：

```sh
pnpm install --frozen-lockfile
pnpm --filter @agentmux/mobile... build
```

包名后的 `...` 让 pnpm 按依赖顺序先构建 Core 及其依赖包、`@agentmux/client-ui`、`@agentmux/demand` 和 `@agentmux/relay`，最后构建手机网页。产物在 `apps/mobile/dist`，Mac Host 默认从这里提供网页（可用 `AGENTMUX_MOBILE_BUILD_DIRECTORY` 指定其他目录）；Vite 开发服务不是产品接入方式。

iOS 与 Android 原生包装需要先同步网页产物：

```sh
pnpm --filter @agentmux/mobile native:sync
open apps/mobile/ios/App/App.xcodeproj
```

在完整 Xcode 中选择签名团队和实际 iPhone 后构建、安装；Android 工程在 `apps/mobile/android`，用 Android Studio 构建。原生包装需要单独的真机验证，网页构建成功不说明原生安装和设备交互已经完成。

## 设计与验收

改手机界面前先读[手机客户端的呈现](../../docs/design/presentation/mobile-client.md)：手机的尺度、控件、文案、状态与动效由该页定义。共享组件要分清 Desktop 默认与手机适配的范围，不能只把桌面布局缩小。

真实 MobileApp 的操作与采图入口是 [capture-ui.mjs](scripts/fixtures/mobile-product-redesign/capture-ui.mjs)，参数和受控边界见[场景说明](scripts/fixtures/mobile-product-redesign/scenario.md)。完整截图须经[独立看图评审](../../docs/guides/agent-visual-e2e-review.md)；构建与采图成功不等于视觉或真机验收通过。

工作面导出会保存会话引用、布局、阅读位置和本机草稿；重新打开时先恢复工作面，再核实 Host 与原 Session / Run。文件导入、前后台切换、键盘输入和系统信任需要在实际设备上验收。

公开接口的准确合同见 [Core hosted 入口](../../packages/core/src/hosted.ts)、[公共 HTTP 入口](../../packages/core/src/public-rpc-http.ts) 和 [共享 Client UI](../../packages/client-ui/README.md)；手机端不维护另一份 dispatcher 或 Runtime。
