# AgentMux

AgentMux 提供可嵌入的本地 Agent Core，以及基于它构建的 Agent 原生桌面工作区。你可以只接入 Core，在自己的 client 中运行 Coding Agent；也可以使用 Desktop，把多个 Agent、终端、对话、文件和浏览器组织到同一工作面。

Core 统一 Provider、AgentSession、Prompt、权限、状态和语义恢复，不依赖 Electron 或 React。Desktop 是 Core 的第一方 client；通用 Run、PTY、进程和字节回放由独立的 **ctxmux** Runtime 持有。

## 从哪里开始

| 你想做什么 | 入口 |
| --- | --- |
| 从源码运行或安装 Desktop | [启动与开发](#启动与开发) |
| 在自己的 Node 宿主接入 Agent | [Core 接入说明](packages/core/README.md) |
| 用 CLI 操作 Agent 和工作面 | [CLI 使用](#cli-使用)、[对象操作指南](docs/guides/agentmux-cli-object-control.md) |
| 在 React client 复用对话、Composer 与终端辅助模块 | [Client UI](packages/client-ui/README.md) |
| 理解项目分层与公共合同 | [系统职责地图](docs/architecture/system-ownership.md)、[公共能力入口](docs/specs/public-capabilities.md) |
| 修改项目或查找设计、验证规则 | [文档导航](docs/README.md)、[AGENTS.md](AGENTS.md) |

## Desktop 的工作面

Desktop 保持 Agent-first、terminal-first：Agent 的状态、输入、输出和恢复动作靠近原工作面，多个 Session 可以并行运行和协作。

| 能力 | 用途 |
| --- | --- |
| 空间与分屏 | 用 Space、Zone、Tab、Region 组织项目与多个工作面；Zone 可以关联目录或 Git worktree，移动展示保留原 Session 和执行目录 |
| Agent 与对话 | 发现和配置 Executor，启动 Agent，在终端与对话视图之间切换，查看原生历史、Trace、权限和问题请求 |
| 文件与 Git | 在工作目录中浏览、编辑和预览文件，查看差异，管理工作区与 worktree |
| Browser | 在内嵌浏览器中阅读页面、执行 Agent 程序，保留操作记录、任务版本与结果；页面操作能力从实际 Browser 发现 |
| Goals 与 Mote | 组织目标、需求及其关联 Session，通过 Topic、Wiki 与 Mote 上下文协作 |
| Focus、Survey 与 Toolkit | 阅读多 Session 活动，查看工作面和资源状态，配置、运行工具并检查其结果 |

Space/Zone/Tab/Region 是展示位置，Project/Workspace 是资源与工作目录，AgentSession/Run 是执行身份。完整定义归[概念词典](docs/design/behavior/spaces-and-layout.md#统一概念与空间寻址)；打开、移动和恢复工作面不会据此重建另一份执行事实。

## 启动与开发

当前随包的原生 Runtime 与 Desktop 打包面向 **macOS Apple Silicon**。Node 版本要求见 [Core package](packages/core/package.json)，pnpm 使用[根 package](package.json)的 `packageManager` 版本；平台和 ctxmux 产物身份以 [vendor manifest](packages/core/vendor/ctxmux/darwin-arm64/manifest.json) 为准。

开发还需要 Xcode Command Line Tools（`xcrun` / `clang`），用于构建 Desktop 的原生工作区辅助程序。

在仓库根目录安装依赖、构建共享包并启动开发桌面：

```sh
pnpm install --frozen-lockfile
pnpm --filter @agentmux/client-ui... build
pnpm dev
```

Agent CLI 需要在本机单独安装并完成登录。仓库提供 Codex、Claude、TraeX、Hermes、Pi、Gemini 等内置 Provider；完整组合见 [Provider 入口](packages/core/src/providers/index.ts)。Provider 已注册不代表该 Agent 在本机可用，各 Provider 的真实运行覆盖也分别核对。

从已提交的干净源码构建安装包：

```sh
pnpm package:mac
pnpm package:mac:install
```

已有安装的更新入口为 `pnpm update:local`；仅 Renderer 的兼容更新可用 `pnpm update:renderer`，回退用 `pnpm update:renderer:rollback`。安装前提、Runtime 变更与原工作面保全见 [Desktop 更新架构](docs/architecture/desktop-updates.md)。

## 在自己的 client 中接入 Core

在已接入 `@agentmux/core`、已安装并登录 Codex 的 Node 宿主中：

```ts
import { randomUUID } from 'node:crypto'
import { connectLocalAgentMux } from '@agentmux/core'

const client = await connectLocalAgentMux()
try {
  const { session, creation } = await client.createAgentWithDelivery({
    providerId: 'codex',
    executorId: 'codex-full-auto',
    workspacePath: process.cwd(),
    createOperationId: randomUUID(),
    prompt: '检查仓库，说明当前结构和需要验证的内容'
  })
  console.log(session.agentSessionId, creation.initialPrompt)
} finally {
  await client.dispose()
}
```

创建回执说明初始 Prompt 的投递情况，不等于任务完成。`dispose()` 释放当前 client 与 attachment，不自动停止 Run；会话接回、后续 Prompt、结构化回答、停止和自定义 Provider 见 [Core 接入说明](packages/core/README.md)。本地纯 Terminal 也由同一 Core 接入 ctxmux。

## CLI 使用

CLI 按对象组织命令，与 client 消费同一 typed JSON-RPC 业务服务。先运行桌面或自己的服务宿主，确保 `agentmux` 可执行文件已进入当前环境，再发现实际资源：

```sh
agentmux --help
agentmux --skill
agentmux settings executors ls
agentmux space ls
agentmux agent ls
agentmux app snapshot
```

下例中的 ID 用发现结果替换；`operation-id` 由调用者为这次操作生成并保留：

```sh
agentmux agent open --executor '<executor-id>' --zone '<zone-id>' --new-tab \
  --prompt '检查当前项目并给出修改建议' --operation-id '<operation-id>'
agentmux agent inspect --session '<session-id>'
agentmux agent send --to-session '<session-id>' --text '继续验证这项修改'
```

使用创建回执返回的 Session 与空间地址，避免从名称或焦点猜目标。回执丢失时先查询原业务操作，不自动重建 Agent 或重发首任务。完整对象命令、错误与保存边界见[对象操作指南](docs/guides/agentmux-cli-object-control.md)，准确参数以执行版本的 `--help` / `--skill` 为准。

服务支持 Unix socket、HTTP/SSE 和 SSH stdio 转发。HTTP 默认关闭，需要宿主显式配置 token；SSH 需要远端已有服务和 CLI。客户端通过 SSH 连接远端已有 Core owner，并经同一公共 API 创建和管理远端当地的 Agent／Run；连接动作不部署或启动 owner。接入与授权细节见 [Core 远程 Runtime](packages/core/README.md#远程-runtime)。

## 仓库分工

| 位置 | 职责 |
| --- | --- |
| [`packages/core`](packages/core/README.md) | 通用 Agent API、Provider、Session、Timeline、权限、恢复和公共业务服务 |
| [`packages/client-ui`](packages/client-ui/README.md) | 共享 Conversation、Composer、Trace、请求卡片及终端回放、输出队列等辅助模块；宿主显式提供平台和业务操作 |
| [`packages/layout`](packages/layout/README.md) | 分屏树、比例与布局计算 |
| [`packages/demand`](packages/demand/README.md) | 独立的文件 Demand Store、Goal 规则与 CLI |
| `apps/desktop` | Electron Main 和 Renderer，组合 Core 与共享包，持有宿主能力及工作面投影 |

ctxmux 可独立发布和使用；AgentMux 是它的高级 client。Core 通过唯一适配器消费 Run 事实，Provider 解释各 Agent 的原生协议，client 持有展示与宿主 IO。源码机制和身份边界见[系统职责地图](docs/architecture/system-ownership.md)。

## 文档与验证

[文档导航](docs/README.md)按读者任务连接设计约束、当前机制、接口、操作与验证来源。交互和视觉分别从[行为专题](docs/design/agentmux-desktop-interaction.md)、[呈现专题](docs/design/agentmux-surface-density.md)进入；README 保留项目概览与上手入口，准确合同由所属文档和源码持有。

有价值的需求或思路先记录整合为 idea，确认内容再更新 owning 需求／设计文档，决定执行后再创建 Tracker。[文档维护规范](docs/guides/document-truth-and-maintenance.md)定义维护方式；[过程资料规则](docs/process-directories.md)明确 idea、调研、计划、评审和原始证据留本机、不提交。

按改动选择验证，常用入口为：

```sh
pnpm typecheck
pnpm test:fast
pnpm test:native
```

这些命令定义在[根 package](package.json)，验证范围与实际行为验收见[测试策略](docs/testing/strategy.md)。本页描述当前源码入口；源码、构建、安装副本与运行实例分别核对，列出验证命令不代表本轮已执行。

## 管理远端 Agent

远端运行独立 Core 的 `agentmux-runtime serve`；Desktop 与 Node client 使用同一公共 JSON-RPC 服务，SSH 连接已有 owner。Agent 语义仍归远端 Core，Run、PTY 和字节历史仍归当地 ctxmux。连接中断保留原 Session 和工作面；连接动作不部署或重启远端服务。接入方式见 [Core 的远程 Runtime 说明](packages/core/README.md#远程-runtime)，恢复约束见 [联邦 Runtime 与远端恢复边界](docs/design/behavior/session-recovery.md#联邦-runtime-与远端恢复边界)。
