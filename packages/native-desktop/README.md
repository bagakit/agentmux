# AgentMux 原生层

`@agentmux/native-desktop` 提供无 Electron 依赖的 Node 客户端及页面 PNG 端口。macOS 系统能力由 `AgentMux Native.app`（`dev.agentmux.native`）持有；宿主提供准确应用路径，第一次系统请求时才启动它。它不持有 Agent Session、Run、PTY 或 Browser 导航。

```ts
import { NativeDesktop, capturePageImage } from '@agentmux/native-desktop'
const native = new NativeDesktop({ appPath: '/exact/path/AgentMux Native.app' })
const selection = await native.captureScreenshot({ mode: 'selection' })
// state: captured / cancelled / failed; transport loss throws with original operation.
await native.dispose()

// A page's original GUI/CDP owner supplies pixels; no OS process or permission query.
const image = await capturePageImage({ capture: async () => ({ png: await originalPage.capture() }) })
```

`NativeConnection` 连接当前用户的私有 Unix socket，通过一次性 token 与原生端准确 parent peer 验证。宿主自动连接使用 LaunchServices；独立开发可显式传 `executablePath`，没有任意命令或 shell 参数入口。构建脚本只组装 unsigned app，签名由 Desktop 正式持久身份管线统一负责。

每次写有原 `instanceId/requestId/operationId`。超时或断线不重放，查询 `inspectOperation(operationId, instanceId)` 不启动替代进程。`completed` 仅表示原生请求回执到达；动作的实际效果以业务回执中的 verification 为准。迟到业务结果仍可取；结果按 32 MiB 总预算与 1024 条终态回执保留，淘汰后明确 unavailable/expired，不由结果缺失推断未发生。已提交的 operation ID 在 owner 生命周期内不能重新执行。

PNG 沿用 Desktop 的 18 MiB/16384 边长/32M 像素边界，不在页面热路径重编码。AX、录屏、剪贴板的系统资格互相独立。权限查询不发起系统授权，不以预读拒绝物理通路。具体 OS 协议见 [macOS 协议](macos/PROTOCOL.md)，长期行为见 [原生层行为合同](../../docs/design/behavior/native-desktop.md)。

`node scripts/verify-client.mjs` 验证真实 Unix socket、生产客户端、页面源和非空变异；这是协议 fixture，不是系统权限或真实 UI 证据。

`node scripts/build-macos.mjs --configuration debug --bare` 只构建开发裸程序；release 输出 `AgentMux Native.app`，两种 profile 不互相 fallback。Desktop 的 `predev`／`prebuild` 分别消费对应 profile，正式组包核对 Native 的编译文件、复制内容和来源，并与主 App 使用同一准确持久证书分别签名校验。构建回执只证明构建结果，不证明系统授权。

完整验证分层及未完成真机证据的续做方法见[原生层验证](../../docs/testing/native-desktop.md)。
