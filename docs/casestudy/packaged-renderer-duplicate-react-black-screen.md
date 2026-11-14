# 安装包更新后黑屏：菜单 Hook 读到空 dispatcher

## 定性

P0。本案范围是一次安装包更新后的 Desktop Renderer：React 在渲染含 Radix DropdownMenu 的界面时失败，整窗黑屏，界面内没有可用的恢复入口，用户无法进入工作面。没有证据表明 Native、Session Store 或用户 Session 受损；这个等级只针对界面不可用。

用户明确指出该安装包已经过多轮版本演进，必须独立调查，不能沿用此前 [preload 启动故障](packaged-app-could-not-start.md)或签名问题的归因。

## 用户可见症状

用户在安装包更新后反馈最新安装包黑屏，并提供报错：

> `Cannot read properties of null (reading 'useMemo')`

堆栈由 React `useMemo` 经 Radix `useScope`、`useComposedScopes`、`DropdownMenu` 进入 `renderWithHooks`。

排查期间磁盘还曾真实报 ENOSPC，阻止新文件与 Git index 写入。这是另一件事：它说明构建资源不足，不能代替下面已经定位的 React 运行时错误。

## 影响面

**坏了什么**：实际安装包的 `package-identity.json` 标记源码提交为当前 main 上的 `ebecc14486`，包内记录的 tree 为 `1008c252731a71272b8f93c2c757fd9de0f2cf2e`（历史清理前的 tree 哈希，与 main 上该提交现在的 tree 不同）。其 `main-2MnBpfXB.js` 中有两份 React 19.2.8 和各自独立的 `ReactSharedInternals.H`：第一份供 ReactDOM 渲染器与普通组件使用，第二份供发生异常的 Radix 菜单使用。堆栈所指的第二份 `useMemo` 从空 dispatcher 读取 Hook，直接导致渲染失败。

**以下不受影响**：修复只改三个 Renderer 构建配置；Main、preload、Provider 与 Runtime 不参与。没有证据表明 Native、Session Store 或用户 Session 受损。

## 止血措施

旧包内没有带内恢复。止血是从包含修复 `850a51777c` 的 main 构建，并沿[打包、安装与启动事实](../design/behavior/session-recovery.md#打包安装与启动事实)安装，保留用户工作面与健康 Run；不删除配置或 Session，不停止健康 Native。

## 引入时间线

命令：

```sh
git log -S 'radixOverlayAliases' --format='%h %ad %s' --date=short -- apps/desktop/electron.vite.config.ts
git log -S "dedupe: ['react', 'react-dom']" --format='%h %ad %s' --date=short -- apps/desktop/electron.vite.config.ts apps/desktop/vite.web.config.ts apps/desktop/vite.gallery.config.ts
```

- `44202d5ef6`（2026-10-05）`fix(ui): share selection fields and overlay ownership`：引入三个 Renderer 共享的 Radix Dialog／Menu dismissal 与 focus primitives 的 alias。当前安装包没有保留源映射或原构建模块路径，无法断言这次构建里的两个物理依赖根来自哪一次依赖布局变更；本文只把它记为相关提交，不写成已证明的历史原因。
- `850a51777c`（2026-10-05）`fix(renderer): deduplicate React across production builds`：修复，见改进措施 1。
- `c6dd72df6b`（2026-10-05）`test(renderer): reproduce duplicate React across linked dependency roots`：加入验证入口，见改进措施 2。

## 根因分析

- **直接原因**：三个生产 Renderer 配置共享 Radix primitives，却没有约束 React／ReactDOM 的唯一解析根。绝对 alias 和外链模块可以从另一个物理依赖根加载 React；两份副本即使版本与文件字节相同，Hook 状态也不共享。[Vite 的 dedupe 选项](https://vite.dev/config/shared-options.html#resolve-dedupe)正是用于统一这类解析；[React 的 Hook 排障说明](https://react.dev/warnings/invalid-hook-call-warning)要求组件与 ReactDOM 使用同一份 React。
- **根因**：构建配置没有表达“Renderer 依赖必须单例”这一运行时约束；跨依赖根共享 alias 时，也没有检查 React 的解析根。同版本、同字节的两份副本在运行时并不是同一份。哪一次依赖布局变更带来了第二个物理根仍未确定（见遗留的 PARTIAL）。
- **为什么没被更早发现**：同版本、同字节的两份副本在解析配置、版本比对和普通测试中都看不出差异；只有在不同物理根同时存在、并实际渲染跨根组件时才会失败。当时没有用生产配置覆盖这种布局的行为检查。

## 改进措施

1. **在 Electron、Web、Gallery 三个 Renderer 的现有 `resolve` 中加入 `dedupe: ['react', 'react-dom']`。** 保留原 Radix alias，复用 Vite 的解析机制。
   - 是否足够 root：覆盖全部三个生产 Renderer 配置；Main、preload、Provider 与 Runtime 不参与此改动。
   - 能否彻底避免：本可阻止这次两份 React 并存。
   - 是否降低系统熵：只增加一个现有构建选项。被否掉的方案是依赖白名单或运行时兼容层，它们增加概念而不能约束解析根。
2. **用生产配置和真实组件验证单例。** 验证入口 [verify-renderer-react-singleton.mjs](../../apps/desktop/scripts/verify-renderer-react-singleton.mjs) 加载实际生产配置，在测试专属目录放置同字节、不同物理根的依赖，以绝对 alias 和外链组件两种形态运行真实菜单、对话框及其动作。验证合同见[测试策略](../testing/strategy.md#任务验收与假绿防护)中的 Renderer dependency singleton。
   - 是否足够 root：覆盖绝对 alias 与外链组件两种触发形态。
   - 能否彻底避免：只能让同类回归更早暴露。
   - 是否降低系统熵：增加一个验证脚本，不改变运行时。

## 验证

- 命令（仓库根）：`node apps/desktop/scripts/verify-renderer-react-singleton.mjs`。
- 承重变异：移除生产去重设置后，同一浏览器验证须捕获原 Hook 异常；编译错误、页面未加载、资源不足与超时不计作这个语义反例。
- 构建源码资格、生成安装包与当前运行实例消费修复分别记录在本机回执，不随仓库分发；本页不以测试方案的存在宣称实际安装已经恢复。

## 遗留

以下按本复盘时（`a3c4768c8a`）的状态记录；锚点之后的变化逐条注明提交。

- 两个物理依赖根的具体来源未确定（PARTIAL）：安装包没有源映射或原构建模块路径。
- 修复是否已被用户的安装实例消费，本复盘时没有核对，须按包身份与实际加载身份另行确认。
- 锚点之后，验证脚本由 `5702257011`（`test(ui): exercise retained modal document behavior`）改过。（`c8f0f7ba1574` 复核：三个 Renderer 配置仍带 `dedupe: ['react', 'react-dom']`。）
