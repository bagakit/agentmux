# Installed desktop update verification

Feature: `f-24n8fj87m`, T-002 / T-003.
范围：`docs/delivery/desktop-experience-update-2026-09-10.md`。

## 安装候选

- 源码提交：`b6c1186aeefcc635bcf22e53b081ea89115e0ef6`，源码树 `2c5f85657f3e9f66df89f1dfe7f7024f83fc5b2c`。
- 候选恢复分支：`delivery/layered-updates-20260910`。该候选包含 `9487471` 的七个 Feature 实现和原生探针 Workspace ID 定位修复。
- 原开发树保留其他工作的 notification-presentation 修改及测量草稿；没有混入安装候选。
- `pnpm typecheck && pnpm package:mac:install` 通过官方 Tracker T-002 gate（r4）。
- `pnpm package:mac:report` 核对候选与规范安装副本身份一致、代码签名有效，运行 Main 来自规范安装位置。
- 新 Main PID 为 `31722`，安装前 Main PID 为 `58824`，不是旧进程继续服务旧副本。
- DMG：`AgentMux-0.1.0-darwin-arm64.dmg`；SHA-256 `bdc9a16bdb71c37d2f60d4c07c7affbaaf5101c330ed53ddc459688400c6807d`。
- 本地候选使用 ad-hoc 签名，没有将它声称为已公证发行包。

完整 package gate 包含 DMG 制作、签名、挂载后身份检查、嵌入 Runtime 与文件移动 helper 检查，
以及隔离安装副本的原生文件编辑、冲突、Workspace 回访、右键与 PointerSensor 检查。
单测没有替代这些检查。

## 当前工作会话与真实更新

安装前、安装后、前端激活后和回切后的当前受管 Codex 身份均为：

| 字段 | 值 |
| --- | --- |
| AgentSession | `98a7c64f-397e-4b85-9e65-ac72d7a0a64a` |
| CtxMux Run | `d519e780-1c3b-4b2b-9cfc-78c5a55becbe` |
| Agent 进程 PID | `59771` |

通过公开 `whoami` 回执比较，三项全程不变，不是用新 Run 的语义 resume 冒充原进程保留。
通过公开 `inspect --tab self` 回执比较，当前 Tab 的 Region ID、边界与邻接关系在热更新和回切前后相同。
这证明了当前会话的连续性，不声称逐一人工操作过窗口中的所有其他 Agent。

在已安装、实际服务用户的 Main 上，给内建前端的 HTML 追加无视觉效果的注释形成候选
`01c0ac503dc8ef6821c2ab13fd9e0cdca5c1654dd3cf1dcde09dd5e04d36e05c`，重新生成完整 manifest，
经 `update-renderer.mjs` 发布。CLI 收到 `frontend_update_applied`，随后 rollback 收到
`frontend_update_applied=bundled`；Main PID `31722` 全程保持。回执来自 renderer 初始化完成，
不是仅根据目录复制成功判断。结束后恢复 bundled 指针和空回切历史，删除仅本次创建的测试候选，
构建目录的 index 与 manifest 恢复到安装副本的原始字节。

## 草稿、文件与布局

另用同版本 Electron 43.3.0 启动隔离 profile，直接加载已安装的 Main、preload、renderer 文件，
通过真实 BrowserWindow、Monaco 和 RendererUpdates 验证完整 checkpoint 链路。
隔离配置、工作区和 ctxmux endpoint 均与用户工作无关。包装壳的 isPackaged 语义由上述真实安装
激活与 package gate 覆盖，不拿这个隔离 runner 替代它。

结果见 [原生回执](evidence/desktop-checkpoint-2026-09-10/result.json)、
[截图](evidence/desktop-checkpoint-2026-09-10/screenshot.png) 与
[验证程序](evidence/desktop-checkpoint-2026-09-10/probe.cjs)：

- 将草稿种入持久化记录，真实 store hydration 后仍存在；激活与回切均保留。
- 真实 Monaco 将 `disk-original` 改为未保存内容；激活后 editor 和 dirty 状态保留。
- 激活后继续输入 `new-edit-after-update`；回切保留新内容，磁盘仍是 `disk-original`。
- checkpoint 后的持久化 Tab / Region 布局在激活与回切前后相同。

探针按产品使用的 checkpoint 刷新持久化后比较；直接读取尚在 debounce 窗口内的 localStorage
会观察到旧快照，不能把它当成最终布局丢失。测试 daemon 和应用进程均已按独立 endpoint 清理。

## 实施证据与边界

T-003 的四个文件命令 gate 已通过（r5），补充上述实际安装与隔离原生证据。
七个 Feature 的实施变异和非空生产调用证据见
`docs/reviews/desktop-implementation-verification-2026-09-10.md`。
Explorer、composer、Projects、分层更新、Redraw、IME 六个输入 Feature 已完成 closeout 并归档。

当前实例安装后的辅助功能读取报 permission_denied，因此没有把用户窗口的全面 UI 检查标为通过；
隔离原生截图确认真实安装 UI 的文件状态和底部键盘入口。中文输入验证包含真实 Electron 中的
合成 CompositionEvent，未把它表述成真实 macOS 输入法人工验收。

新提出的本地文件预览与按格式编辑需求记录在 `f-24v8fec2k`，官方文档调研已落盘，
保持独立 proposal。文件树“作为项目打开”、自定义 Executor 和 Region 布局历史需求亦未被本交付标完成。
