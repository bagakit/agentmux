# 原生层机制

本文说明 AgentMux 原生层的当前模块边界、调用链与构建形态，给出源码文件与 symbol 作为核查入口。原生层必须满足的行为、授权与资源边界唯一见[原生层需求](../design/behavior/native-desktop.md)；源码 fixture、编译、真实系统操作与正式身份的验证边界见[原生层验证](../testing/native-desktop.md)。本文描述源码机制，不代表某个安装副本已通过授权或真机验收。

## 模块与责任

| 模块 | 源码入口 | 责任 |
| --- | --- | --- |
| `@agentmux/native-desktop` | [packages/native-desktop/src](../../packages/native-desktop/src/index.ts)：`NativeDesktop`、`NativeConnection`（[client.ts](../../packages/native-desktop/src/client.ts)），`NATIVE_METHODS`、`NATIVE_MUTATIONS`、`NativeOperation`（[protocol.ts](../../packages/native-desktop/src/protocol.ts)），`PageImagePort`、`pngFromBytes`（[image.ts](../../packages/native-desktop/src/image.ts)） | 与 Electron 无关的原生能力合同、Node 侧请求连接与结果解析、网页图像端口 |
| AgentMux Native（macOS 程序） | [macos/Package.swift](../../packages/native-desktop/macos/Package.swift)、`Sources/AgentMuxNativeMacOS` 与 `Sources/AgentMuxNativeMacOSCore`（如 `NativePeerAuthorizer.swift`、`NativeConnectionRequestLoop.swift`、`UnixSocketPathSafety.swift`） | 以 AgentMux 稳定代码身份运行；解释 AppKit、AX、ScreenCaptureKit、原生剪贴板和真实输入 |
| Core 原生端口 | [public-rpc-native-desktop.ts](../../packages/core/src/public-rpc-native-desktop.ts)：`AGENTMUX_RPC_DESKTOP_NATIVE_METHODS`、`NATIVE_DESKTOP_WRITES`、`parseNativeDesktopParams`；[public-rpc-service.ts](../../packages/core/src/public-rpc-service.ts) 的 `nativeDesktop` 端口 | 公开 `native.*` 方法、Host／调用者授权、原 operation 与 unknown 传递；实现由宿主注入，Core 不依赖 Electron 或 AppKit |
| Desktop 原生适配 | [native-desktop-owner.ts](../../apps/desktop/src/main/native-desktop-owner.ts)：`getNativeDesktopOwner`、`getDesktopNativeUiOwner`；[native-desktop-public.ts](../../apps/desktop/src/main/native-desktop-public.ts)：`createNativeDesktopPublicOwner` | 程序路径、按需启动、资源保存与原 UI 调用接线；不复制原生能力，不另存权限事实 |
| Browser owner | 原 Browser 页面／视口／导航、GUI `capturePage` 与原 CDP 会话 | 通过 `PageImagePort` 输出同一来源的 PNG |

公开方法集合是 `native.capabilities`、`native.apps.list`、`native.displays.list`、`native.windows.list`、`native.snapshot`、`native.permissions.inspect`、`native.capture`、`native.clipboard.read`、`native.clipboard.write`、`native.action` 与 `native.operation.inspect`；其中 `NATIVE_DESKTOP_WRITES` 标出会产生副作用的 `native.capture`、`native.clipboard.write` 与 `native.action`。准确清单以上述常量为准。

## 调用链与平台分派

Desktop Main 只持有一个懒创建的 `NativeDesktop`（`getNativeDesktopOwner`），供全部窗口与公开 Core 端口共用；启动时不做原生预检，`will-quit` 时释放连接。`getDesktopNativeUiOwner` 在每次操作前按 `process.platform` 静态选择：macOS 走 `NativeDesktop`；其他平台只有剪贴板保留 Electron 实现，截图仍调用 `NativeDesktop`，在非 macOS 上如实返回 unavailable（[client.ts](../../packages/native-desktop/src/client.ts) 的平台检查）。一次原生请求失败不会把同一操作改投另一实现。

原生进程不是通用 Run Runtime。只移植 OS 操作必要的连接身份校验与请求关联；上游的 Agent session ownership 与特定产品识别没有进入 AgentMux，也不成为 Session 真值。控制事实走机器协议，展示文案不参与授权或状态迁移。

网页像素与屏幕像素分开取源，共用图像结果和宿主消费：页面渲染端口由原 Browser owner 注入，保留捕获前后的身份检查；没有原生进程或录屏权限时，网页端口仍可用。原生键鼠操作不替代 Browser 原有的准确 WebContents 输入协议。

## 连接、授权与请求关联

Node 连接保留原请求 ID，使用私有 socket 与连接凭据；macOS 侧由 `NativePeerAuthorizer` / `NativePeerPolicy` 校验对端身份，`UnixSocketPathSafety` 负责 socket 路径的归属与私有权限。日志不包含凭据或用户输入全文。客户端取消观察不等于原生动作未发生，结果未知的动作不自动补发；准确结果沿 `native.operation.inspect` 按原 operation 查询。

## 构建、启动与签名

- 开发入口：`app.isPackaged` 为假时，Desktop 从固定的 SwiftPM debug 路径 `packages/native-desktop/macos/.build/debug/agentmux-native-macos` 启动裸程序；[build-macos.mjs](../../packages/native-desktop/scripts/build-macos.mjs) 只允许 debug 配置以 `--bare` 构建。
- 正式入口：打包后从包内固定路径 `resources/AgentMux Native.app` 启动；构建脚本只接受 release 配置的 `AgentMux Native.app`，bundle identifier 为 `dev.agentmux.native`。
- 两种入口不互相查找，也不 fallback；生产授权不提供运行时放宽开关。
- 正式组包由 [native-desktop-package.mjs](../../apps/desktop/scripts/native-desktop-package.mjs) 先以 `verifyNativeDesktopCopy` 核对已编译程序与复制内容，再由既有 Desktop 签名入口从内向外签名，并以 `verifyNativeDesktopSigning` 校验：内外两个应用使用同一个准确证书 leaf 和各自的 bundle identifier，保留系统默认 designated requirement。

## 来源与上游

macOS 实现改编自 Orca，来源固定在 [UPSTREAM.md](../../packages/native-desktop/macos/UPSTREAM.md) 记录的准确上游 commit；原 MIT 许可见 [LICENSE.orca](../../packages/native-desktop/macos/LICENSE.orca)，第三方声明见 [THIRD_PARTY_NOTICES.md](../../packages/native-desktop/THIRD_PARTY_NOTICES.md)。本地修改范围写在 UPSTREAM.md。许可与本地修改说明随正式产物一并保留：[build-macos.mjs](../../packages/native-desktop/scripts/build-macos.mjs) 把 `LICENSE.orca`、`UPSTREAM.md` 与 `THIRD_PARTY_NOTICES.md` 复制进 `AgentMux Native.app/Contents/Resources`。上游后续更新按模块边界评估，不在打包时拉取浮动源码。
