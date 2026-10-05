# 当前安装包的菜单 Hook 异常导致黑屏

## 现场事实

用户在安装包更新后反馈最新安装包黑屏，提供 `Cannot read properties of null (reading 'useMemo')`。堆栈由 React `useMemo` 经 Radix `useScope`、`useComposedScopes`、`DropdownMenu` 进入 `renderWithHooks`。用户明确该包已经过多轮版本演进，必须独立调查，不能继承此前 preload 或签名事故的归因。

实际安装包的 `package-identity.json` 标记源码 `8bd3b840ed887c04b6c80c2274745808cb25cbec`，tree `1008c252731a71272b8f93c2c757fd9de0f2cf2e`。其 `main-2MnBpfXB.js` 中有两份 React 19.2.8 和独立的 `ReactSharedInternals.H`：第一份供 ReactDOM 渲染器与普通组件使用，第二份供发生异常的 Radix 菜单使用。堆栈所指的第二份 `useMemo` 从空 dispatcher 读取 Hook，直接造成渲染失败。

排查期间磁盘还曾真实报 ENOSPC，阻止新文件与 Git index 写入；这说明构建资源不足，不能代替上述已经定位的 React 运行时错误。当前事故也没有证据证明 Native、Session Store 或全部用户 Session 已损坏。

## 原因与边界

三个生产 Renderer 配置已共享 Radix Dialog／Menu 的 dismissal 与 focus primitives，却没有约束 React／ReactDOM 的唯一解析根。绝对 alias 和外链模块可以从另一个物理依赖根加载 React；两个副本即使版本和文件字节相同，Hook 状态仍不共享。[Vite 的 dedupe 选项](https://vite.dev/config/shared-options.html#resolve-dedupe)正是用于统一这类解析；[React 的 Hook 排障说明](https://react.dev/warnings/invalid-hook-call-warning)要求组件与 ReactDOM 使用同一份 React。

共享 Radix alias 由 `cf30b0c51c9bdb4e2b0715c81131f522d45854f1` 引入，但当前安装包没有保留源映射或原构建模块路径，不能据此断言这次构建里的两个物理根究竟来自哪一次依赖布局变更。已确认的是当前实际产物重复、缺失运行时去重约束，以及可复现的跨根故障条件；不把引入时间的关联写成已经证明的历史原因。

## 修复与回归方法

在 Electron、Web、Gallery 三个 Renderer 的现有 `resolve` 中增加 `dedupe: ['react', 'react-dom']`，保留原 Radix alias，复用 Vite 的解析机制。Main、preload、Provider 与 Runtime 不参与此改动，也不增加依赖白名单或运行时兼容层。

验证入口是 [verify-renderer-react-singleton.mjs](../../apps/desktop/scripts/verify-renderer-react-singleton.mjs)：加载实际生产配置，在测试专属目录放置同字节、不同物理根的依赖，以绝对 alias 和外链组件两种形态运行真实菜单、对话框及其动作。移除生产去重设置后，同一浏览器验证须捕获原 Hook 异常；编译错误、页面未加载、资源不足与超时不计作这个语义反例。验证成本与证据边界沿[测试策略](../testing/strategy.md#任务验收与假绿防护)。

构建源码资格、生成安装包与当前运行实例消费修复分别记录在本机回执；本页不以测试方案的存在宣称实际安装已经恢复。交付继续沿[原更新和安装合同](../design/behavior/session-recovery.md#打包安装与启动事实)，保留用户工作面及健康 Run。
