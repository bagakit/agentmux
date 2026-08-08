# Hover menu delivery

Review: approved

用户明确授权：Split 悬停展开，同类入口一样；能一下解决不多点一下；完成后打包安装重启。

范围：复用 Radix DropdownMenu，为 Split、浏览器 Viewport/More、Agent roster、资源面板、Posture 选项提供一致鼠标悬停。保留键盘、触屏、点击与 disabled，不改变动作内容。共享原生视图让位和资源订阅回调。

验收：真实 DOM 的 pointerenter 打开，移过间隙不关闭，离开关闭，选项一次点击只执行一次，Escape/外部点击关闭，禁用/触屏不误开，悬停不抢焦点。生产 Split 与同类入口消费同一实现；变异去掉悬停开启使测试红，排除定义文件的调用非空。

交付：保存未提交工作，检查候选，真实执行 package:mac:install 并核对安装身份及重启后会话。未完成的布局包等既有需求不标完成。测量草稿留在原工作区，候选可在隔离的干净 checkout 打包。

Verification evidence: targeted implementation mutations failed the corresponding tests, then original sources were restored byte-for-byte (`/tmp/amx-mutation-evidence.json`, 12 cases). Nonempty production callers excluding each defining file are recorded in `/tmp/amx-production-callers.txt`. Tracker command gates are rerun on restored sources before task completion.
