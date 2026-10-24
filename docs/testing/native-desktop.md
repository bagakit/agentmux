# 原生层验证

行为边界见[原生层](../design/behavior/native-desktop.md)，构建与身份见[目标架构](../design/native-desktop-architecture.md)。本页定义证据范围，不是候选通过报告。源码审查、协议 fixture、Swift 编译、真实系统操作和最终安装分别成立。

## 源码与协议

- `node packages/native-desktop/scripts/verify-client.mjs`：生产 Node 连接、真实 Unix socket、图像端口、回执关联和非空变异。服务端是协议 fixture，不证明 macOS API 或权限。
- `node scripts/verify-native-public.mjs`：真实 CLI、公共服务、Desktop adapter 和生产 Node 连接。目标、授权及 unknown 变异须使原消费者断言失败。
- `node apps/desktop/scripts/verify-native-consumers.mjs`：原 Composer、preload/Main、Browser 和 Terminal 消费链；保留原页面源和原稿。受控输入替身不证明物理点击或屏幕像素。
- `node apps/desktop/scripts/verify-native-package.mjs --source-only`：构建回执、复制内容、签名资格参数及生产组包接线的轻量 fixture／变异，不调用 Swift、签名器或正式组包。
- `node packages/native-desktop/scripts/verify-native.mjs --source-only`：只做 Swift 语法解析；不证明 SDK 类型、链接、测试或运行能力。
- `node packages/native-desktop/scripts/verify-socket-publication.mjs`：只编译实际 Swift socket 初始化与隔离 producer，在 bind 后、chmod／listen 前暂停检查首个目录项，再经生产 Node 客户端握手及消费一次协议采图回执；移除私有创建步骤须使真实权限断言失败。它不启动 AppKit、不采真实屏幕，也不证明生产 peer 或 TCC 授权。

跨层调用链 fixture 属于 Desktop 测试，Core 生产编译只消费中立端口。保留原始日志、失败断言、源码散列和独立审查；不能用空测试集合、加载错误或 JSON 自报成功代签行为。

## Swift 与系统操作

重操作前重新观察实际磁盘空间和本轮准确构建目录占用，估算下一阶段产物。空间不足时保留源码、用户资料与证据，不清理未知归属内容，也不设置永久固定容量门槛。

`verify-native.mjs --source` 会编译、运行单元及变异测试，并启动自己的独立 AppKit 窗口，对其准确 PID／进程代次／窗口／snapshot 执行真实输入和采图；资格不足须报告未完成，不能跳过后判通过。该命令不是纯源码检查。真实客户端经过生产 dispatch 和连接认证，测试窗口不提供产品鉴权后门；采图可能触发系统授权提示，runner 不代本人同意或改写权限。

分别验证人工选区成功与取消、多屏负坐标、混合 HiDPI、原窗口消失、文本／PNG 剪贴板、AX 与合成输入的不同回执。真实系统授权由本人完成；只读状态、同 signer 和已启用开关不能代替同次请求证据。Browser 页面采图还须在无系统录屏资格时实际可用。

## 正式身份与安装

正式候选沿[macOS 打包指南](../guides/macos-packaging.md)执行一次既有入口；`verify-native-package.mjs` 不带 `--source-only` 时调用该入口的 `--app-only`，不会安装。DEBUG 裸程序不能替代正式 Native.app 的 peer、LaunchServices 或 TCC 证据。

核对同次源码／架构、Native 编译文件、包内内容和许可来源，再消费同一次从内向外签名结果。主 App 与 Native.app 分别确认自己的 bundle identifier、同一准确证书 leaf 和默认 DR；签名资格不证明系统授权。

安装观察复用现有 Composer device proof 对源码、安装包、实际加载 Renderer、图片原件和独立看图意见的绑定方式，再补齐本轮 Native 进程、原 operation、同次 TCC、保存 PNG 和原稿消费。旧截图 closure 的通过不能覆盖新原生层。

授权连续性须在同一 canonical 路径以同 signer／默认 DR 验证不同代码 A、B；首次身份转换由本人完成，B 实际截图无需再次授权才构成连续性证据。保留准确请求和原件，不能用 codesign 互验或 JSON 的 `passed` 代签。缺少 Native／TCC／A-B 证据时保持该项未验。

真实重启后另核原 Session、Run、Tab、Region、焦点和布局；保全规则沿[Session 恢复](../design/behavior/session-recovery.md)。测试只操作自己的隔离资源，不向健康用户 Run 注入探测。
