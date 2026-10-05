# 新安装包无法启动，随后只显示界面超时

## 定性

P0。用户无法进入安装包的工作面，原 Renderer 内没有可用恢复入口；启动检查又没有留下真正的 preload 首错。这个结论限于 Desktop 启动，不能据此判定所有 Agent 或持久 Session 已死亡。

## 用户可见症状

> “另外新打的包启动不了了”
>
> “现在好像能启动 但是黑屏”
>
> “还是 could not start”

原安装包后来记录 `Interface did not load or respond`，属于 preload 失败后的界面就绪未确认。用户转来的 `ERR_ABORTED (-3)` 和配置路径 `${ISOLATED_FIXTURE_ROOT}/u/agentmux.config.json` 则来自本轮隔离实验的页面重载；该实验错误不能代替原包根因，原路径留在本机证据。安装修复候选时，现有代码签名证书未受信任，是独立安装阻断。

## 影响面

STOPS：受影响包的 sandbox preload、Desktop API bridge、Renderer 挂载和通过这个界面操作 Agent。原包身份是 `07d5fc81df0787af1d7d0e3874dc3dc9950e01f1` / tree `54a069512e86b0ca8bb4ec174ebcca354239c6fd`。

以下不受影响：修复保留原 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，不替换或停止 Native，不修改 Session Store，不派发创建、恢复或输入。实际反例使用独立 userData，不连接用户 Runtime；Core 与 Native 的运行事实仍须单独读取。依据是 [安全设置](../../apps/desktop/src/main/window-security.ts)、[隔离验证脚本](../../apps/desktop/scripts/verify-sandboxed-preload.mjs) 和修复提交的五文件范围。仅有后台 PID 不足以证明全部原 Session 可恢复。

## 止血措施

旧包内无带内恢复。可执行的止血是从已合入 main 的启动修复构建并按原安装 owner 安全替换 App；不删除配置或 Session、不关闭健康 Native。签名预检未通过时保留原包和修复候选，由用户授权既有证书的 codeSign 信任，再独立核对有效身份；不能把未安装候选说成用户已恢复。

## 引入时间线

追溯命令：

```sh
git log -S '@agentmux/core/object-id' --format='%H %s' -- apps/desktop/src/shared/scratch-topic-identity.mjs
git log -L 1,2:apps/desktop/src/shared/scratch-topic-identity.mjs --format='%H %s'
git log --follow --format='%H %s' -- apps/desktop/src/shared/scratch-topic-identity.mjs
git log -L 19,26:apps/desktop/electron.vite.config.ts --format='%H %s'
```

- `99c8d4ba318654b4a36ed2985bf2725271f284fd`，`feat(agentmux): deliver tmux runtime and desktop workbench`：建立 preload 的依赖外置配置。这是早已存在的构建选择，不是后续新增共享导入的引入提交。配置该段的 `git log -L` 在修复前只有这次引入。
- `4183c0139c8745323be0730ab35c77c933afc1c1`，`fix: use bundled renderer for packaged smoke checks`：为避免隔离 smoke 等不到热更新 token，跳过正常 Renderer 更新就绪流程。后来的 ready-file 分支只等 `loadFile` 及可选 Core 连接，形成了另一套“启动成功”判据；它不能确认 preload bridge 或 React 工作面存在。
- **引入提交** `c4a4e31e28edd29a413d8f694ebde4698bc748f0`，`refactor: unify product IDs with fixed-width Base58`：为统一身份校验，新增 `scratch-topic-identity.mjs` 对 `@agentmux/core/object-id` 的运行时导入，并经 scratch-topics 与 contracts 进入 preload。共享类型文件里有运行时值，导入不止发生在 Renderer。直到本次修复，该新模块的 pickaxe、逐行历史及 follow 历史均只显示 c4a4e31e；没有后续改过这两行却漏检的提交。
- `369a4cc43150f53fc19e6669ea175df9c5ba09b1`，`fix(desktop): bundle sandbox preload and confirm renderer startup`：显式关闭 preload 自动外置，并使普通启动与 ready-file 分支消费同一个真实 Renderer-ready loader。

## 根因分析

直接原因：`preload → contracts → scratch-topics → scratch-topic-identity → Core/object-id` 的共享值导入被外置为裸 `require('@agentmux/core/object-id')`。Electron sandbox preload 不能任意加载 Node 包，执行抛 `module not found`，bridge 未暴露；Renderer 随即抛 `AgentMux preload API is unavailable`。重新启用外置所得反例 preload SHA256 为 `66e46cc5ce83b3a93610562475620acd14c0ee7a5a3eb30b7be89b1f344fae60`，与原安装包字节完全相同。

根因：跨共享模块的重构只被当成身份校验变化，没有把运行时导入闭包放到实际宿主安全边界中验证。交付流程又用“页面导航成功／Main 留下 ready 文件”代替“原 preload、bridge 与 Renderer 挂载真正成功”。这两个判断共同让可构建但不可用的包获得启动资格。

为什么没更早发现：`loadFile` 可以在 preload 错误时完成，Core 可连接也不能证明 UI 可用；原 CrashLog 仅捕获 Main 未处理异常及进程消失，preload 失败不必让 Renderer 进程消失，结果只留下较晚的就绪超时。已有[真实配置下启动验收](../design/behavior/session-recovery.md#启动配置错误与诊断)要求，但旧 smoke 没消费相同就绪回执，规则没有机械约束住该交付分支。

## 改进措施

1. 对现有唯一生产 preload target 显式设置 `externalizeDeps: false`，Main 继续按原方式构建。
   - 是否足够 root：修复“sandbox preload 保留外置应用依赖”这一类；仓库生产 Electron 配置扫描只找到一个 preload target，本条覆盖这个 target 的整个应用依赖闭包。
   - 能否彻底避免：本可阻止这次裸 Core require；不保证任意未来依赖都能在 sandbox 中运行，仍须实际执行。
   - 是否降低系统熵：移除手动 preload 外置插件，使用现有构建选项，不加依赖白名单或兼容 loader。更简的“只删插件”被实际 resolveConfig 反证：electron-vite 5 会默认重新加外置插件，必须显式关闭自动外置。
2. 普通启动与 ready-file 验证复用原 Renderer-ready loader。
   - 是否足够 root：两条生产加载入口共享一个真实就绪判据，消除其中一条旁路；不把 Provider、工作区或 Session 初始化完成加成界面就绪条件。
   - 能否彻底避免：本可在交付启动检查中识别本次 bridge／挂载失败，不能阻止任意平台启动故障。
   - 是否降低系统熵：提取原 loader、删除直接 `loadFile` 的 smoke 旁路；不添加新的超时、重载或 Runtime 状态。
3. 补原 Workbench 的 preload 与 bootstrap import 首因观测。
   - 是否足够 root：调查明确两种当前缺失的原启动异常形态；复用原 CrashLog 与查询入口，限定原窗口及加载 attempt。此观测切片须独立完成后才称已交付。
   - 能否彻底避免：只能更早定位和缓解，不能阻止 preload／导入错误本身。
   - 是否降低系统熵：新增一个小捕获 owner 和薄入口；不新增遥测、会话账本或通用诊断框架。更简的“只监听进程消失”已被本次活着但不可用的 Renderer 反证；“只看 console”无法保证原来源、范围与敏感内容边界。

## 验证

动作 1、2 的命令从仓库根执行，先按项目正常构建产生 Renderer：

```sh
env -u ELECTRON_RUN_AS_NODE node apps/desktop/scripts/verify-sandboxed-preload.mjs
```

实际 production-config 构建、真实 sandbox Electron 与完整 Renderer 得到 GREEN：bridge 可用、工作面已挂载、一个真实 ready token、原 toolkit observer 可创建并释放。受控恢复读取一直 pending，仍须可确认已挂载界面。恢复外置的 compiled 反例独立得到语义 RED：原模块错误、bridge 缺失、root 空、没有 ready token；编译失败或外层超时不算此 RED。验证提取实际 Main loader 与 ready consumer，生产调用者是 Main 普通 RendererUpdates 与 ready-file 分支；脚本同时冻结所消费源码。另有 18 项加载接线检查通过，不能以这些文本检查替代真实执行。

动作 3 尚未交付，预定验证命令是 `node apps/desktop/scripts/verify-workbench-startup-capture.mjs`；本文不提前声称该脚本存在或通过。须覆盖真实 preload／bootstrap import、原 sender／attempt、诊断写入失败后健康续用及既有 `system.crash-log.inspect/reveal`，按[测试策略](../testing/strategy.md#任务验收与假绿防护)核语义变异和非空生产调用者。

## 遗留

- 观测补全未由启动修复提交交付，不把 source 修复、候选构建或签名请求当成它已通过。
- 真实用户配置下的安装、启动与原工作面恢复单独核对；本轮隔离 GREEN 不替用户安装实例取得资格。
- 先前共享容量故障后的部分原 Run／Provider 恢复身份仍未确认，归[原容量事故](all-sessions-unrecoverable-with-disk-space.md)，不靠本次启动修复批量重启或替换 Session。
