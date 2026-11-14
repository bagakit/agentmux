# AgentMux 原生层

`@agentmux/native-desktop` 让 AgentMux 观察和操作 macOS：列出应用、窗口和显示器，读取窗口的辅助功能（AX）树，点击、输入、按键、滚动和拖拽，截取屏幕与窗口，读写剪贴板。系统能力由独立的 `AgentMux Native.app`（`dev.agentmux.native`）持有；本包提供不依赖 Electron 的 Node 客户端，以及与框架无关的页面 PNG 端口。宿主传入准确的应用路径，原生进程在第一次系统请求时才启动。它不持有 Agent Session、Run、PTY 或 Browser 导航。Agent 通过 `amux native` 使用这些能力，见 [`native` 指南](../core/guides/modules/native.md)。

```ts
import { NativeDesktop, capturePageImage } from '@agentmux/native-desktop'
const native = new NativeDesktop({ appPath: '/exact/path/AgentMux Native.app' })
const frames = await native.captureDisplays()
// captureDisplays({ includeHostWindows: true }) keeps visible host pixels and lists the host; only helper windows are filtered.
// The default false excludes helper + host pixels by PID, including panels, without hiding or fading either process's UI.
// Every active display's frozen PNG from one grab, or that display's issue; Desktop draws selection over them.
const display = await native.captureScreenshot({ mode: 'display', displayId: frames.displays[0].displayId })
// state: captured / failed; transport loss throws with original operation.
await native.dispose()

// A page's original GUI/CDP owner supplies pixels; no OS process or permission query.
const image = await capturePageImage({ capture: async () => ({ png: await originalPage.capture() }) })
```

## 能力

`NativeDesktop` 为截图和剪贴板提供带校验的便捷方法（`captureDisplays`、`captureScreenshot`、`readClipboardText`、`writeClipboardText`、`readClipboardImage`、`writeClipboardImage`），其余方法通过 `request(method, params)` 调用。协议方法的完整参数与回执见 [macOS 协议](macos/PROTOCOL.md)。

| 类别 | 方法 | 说明 |
| --- | --- | --- |
| 发现 | `listApps`、`listWindows`、`listDisplays` | 应用以 PID 加进程启动时间标识，窗口以原生窗口号标识；名称和标题只用于显示 |
| 观察 | `getAppState`、`permissionStatus` | 读取准确进程与窗口的 AX 树，每个元素带原生动作名和窗口内坐标；默认不附截图 |
| 输入 | `click`、`performSecondaryAction`、`setValue`、`typeText`、`pressKey`、`hotkey`、`pasteText`、`scroll`、`drag` | 每个动作都带操作 ID，回执说明走的是 AX、合成事件还是剪贴板路径，以及效果是否经回读核验 |
| 采图 | `captureDisplays`、`captureScreenshot` | 每块屏一次抓取并附同一时刻的窗口列表；或截取指定显示器、矩形或窗口 |
| 剪贴板 | `clipboardRead`、`clipboardWrite` | 文本或 PNG；写入以系统 pasteboard 的回执为准 |

几项设计上的保证：

- **目标准确。** 动作前重新核对进程启动时间和准确窗口；键盘、滚动和拖拽的每个事件都会再次核对接收者，接收者变化时停止，不会把剩余事件投给别的窗口。
- **不重放。** 每次写入带 `instanceId`、`requestId` 和 `operationId`。超时或断线后不重放，`inspectOperation(operationId, instanceId)` 只查询，不会启动替代进程；同一 owner 生命周期内提交过的 operation ID 不能再次执行。`completed` 只表示收到了原生请求回执，动作的实际效果以回执中的 `verification` 为准。
- **结果有界。** 迟到的业务结果仍可取回；结果总共保留 32 MiB、最多 1024 条终态回执，被淘汰的明确标为 unavailable / expired，不能据此推断动作没有发生。
- **授权分开。** AX、录屏和剪贴板的系统资格互相独立。`permissionStatus` 只读系统预检结果，不弹授权，也不阻止实际操作去尝试；实际操作的结果才是准。
- **截图像素与窗口列表同源。** macOS 14+ 的每次 `captureDisplays` 只枚举一次 `SCShareableContent`，所有显示器共用同一份按 `SCWindow.owningApplication.processID` 得到的过滤列表。included 只排除 helper；excluded 排除 helper 和准确的 `--parent-pid` host，包含 panel 与其他可捕获窗口，不误排其他 PID，也不需要先隐藏或淡出 host。窗口元数据仍只列 normal layer，并应用同一组 owner 过滤。macOS 12/13 的 CoreGraphics included 可正常抓取；excluded 遇到某块屏上有可见 host 时，该屏返回 `host_window_exclusion_unavailable`，不含 host 的屏仍可使用，绝不会把仍含 host 的 CoreGraphics 像素标成 excluded。
- **阶段耗时可校验。** 原生顶层 `timing` 含 `contentMs`、`windowListMs`、`totalMs`，每块屏（包括失败屏）含 `captureMs`、`pngMs`、`base64Ms`、`totalMs`；Node 返回时补充 `requestMs`、`validationMs`。所有值必须是 0–150000 ms 的有限数值，缺失或损坏会以 `invalid_display_frames` 拒绝。`requestMs` 包含连接、socket/NDJSON 传输和原生工作，未把这些传输成本伪拆成额外指标；SDK 不为计时再序列化一次 JSON。计时诊断不含像素、路径或草稿文本。

PNG 使用与 Desktop 相同的上限：18 MiB、单边 16384 像素、总计 32M 像素，页面热路径上不重新编码。长期行为见[原生层行为合同](../../docs/design/behavior/native-desktop.md)。

## 连接与构建

`NativeConnection` 连接当前用户的私有 Unix socket，用一次性 token 并核对原生端的准确父进程完成认证。宿主自动连接时经 LaunchServices 启动应用；独立开发可以显式传 `executablePath`，没有任意命令或 shell 参数入口。

构建原生层需要 macOS 上的 Xcode 或 Command Line Tools，以及 Swift 6 工具链（`macos/Package.swift` 声明 `swift-tools-version: 6.0`，最低部署目标 macOS 12）。`node scripts/build-macos.mjs --configuration debug --bare` 只构建开发用的裸程序；release 构建输出 `AgentMux Native.app`，两种 profile 互不替代。构建脚本只组装未签名的 app，签名由 Desktop 打包统一完成；构建回执只证明构建结果，不证明系统授权。开发与正式入口、签名身份见[原生层机制](../../docs/architecture/native-desktop.md)。

验证分层、各命令能证明什么以及尚未完成的真机证据，见[原生层验证](../../docs/testing/native-desktop.md)。
