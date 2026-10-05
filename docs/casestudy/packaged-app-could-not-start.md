# 新安装包无法启动，随后只显示界面超时

## 定性

P0。用户无法进入安装包的工作面，原 Renderer 内没有可用恢复入口；启动检查又没有留下真正的 preload 首错。这个结论限于 Desktop 启动，不能据此判定所有 Agent 或持久 Session 已死亡。

## 用户可见症状

> “另外新打的包启动不了了”
>
> “现在好像能启动 但是黑屏”
>
> “还是 could not start”

原安装包后来记录 `Interface did not load or respond`，属于 preload 失败后的界面就绪未确认。用户转来的 `ERR_ABORTED (-3)` 和配置路径 `${ISOLATED_FIXTURE_ROOT}/u/agentmux.config.json` 则来自本轮隔离实验的页面重载；该实验错误不能代替原包根因，原路径留在本机证据。

交付修复候选时还出现了独立的签名资格误判。用户完成既有证书的 codeSign 信任认证后，`security find-identity -v -p codesigning` 已列出原 SHA 的身份，并报告 `1 valid identities found`；该行附带 `(CSSMERR_TP_NOT_TRUSTED)`，旧预检正则因此漏选。原证书实际签名及严格 trusted-leaf 校验通过，不能继续把这次交付阻断解释为“用户尚未完成信任”。

## 影响面

STOPS：受影响包的 sandbox preload、Desktop API bridge、Renderer 挂载和通过这个界面操作 Agent。原包身份是 `07d5fc81df0787af1d7d0e3874dc3dc9950e01f1` / tree `54a069512e86b0ca8bb4ec174ebcca354239c6fd`。

以下不受影响：修复保留原 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，不替换或停止 Native，不修改 Session Store，不派发创建、恢复或输入。实际反例使用独立 userData，不连接用户 Runtime；Core 与 Native 的运行事实仍须单独读取。依据是 [安全设置](../../apps/desktop/src/main/window-security.ts)、[隔离验证脚本](../../apps/desktop/scripts/verify-sandboxed-preload.mjs) 和修复提交的五文件范围。仅有后台 PID 不足以证明全部原 Session 可恢复。

## 止血措施

旧包内无带内恢复。可执行的止血是从已合入 main 的启动修复构建并按原安装 owner 安全替换 App；不删除配置或 Session、不关闭健康 Native。既有证书认证已完成，后续交付须消费修正后的有效身份解析及真实 staged-App 签名校验，保留原证书身份，不再重复要求用户认证。

后续现场安装副本 `9587a54` 已显示工作面，原 Native 的进程出生身份未变；但该副本实际为 `Signature=adhoc`。这只证明该副本的界面可见，不能计作本轮证书签名交付，也不能推出全部 Session 已恢复；正常证书签名更新仍待完成。

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

签名次因另沿 `apps/desktop/scripts/macos-signing.mjs` 追溯：

```sh
git log -S 'configured signing identity is not uniquely available' --format='%H %s' -- apps/desktop/scripts/macos-signing.mjs
git log -L 35,43:apps/desktop/scripts/macos-signing.mjs 4eba4a25f1ff0f1b8127dc31b3e265103064f184 --format='%H %s'
git log -L 66,73:apps/desktop/scripts/macos-signing.mjs 4eba4a25f1ff0f1b8127dc31b3e265103064f184 --format='%H %s'
git log --follow --format='%H %s' -- apps/desktop/scripts/macos-signing.mjs
```

`d2aa325003335b9aa1a2fe9ec5de9405e86b13cb`，`fix(packaging): preserve certificate-backed macos signing identity` 建立了 Developer ID 身份解析。`4eba4a25f1ff0f1b8127dc31b3e265103064f184`，`fix(desktop): preserve local macOS signing identity across updates` 将解析扩展到本地证书，沿用了要求名称后立即结束的正则，并新增只接受 `anchor H` 的默认 requirement 判断；这次为了保留本地签名身份的改动，反而没有验证 Apple 对该身份的真实输出。修复前两段逐行历史均只显示这两次提交，没有后续修改这两段却漏检的提交；文件 follow 历史中的 `2bd068b130c13dd5c7aee4854ca5032ce032b4fc`（`fix(packaging): preserve pinned runtime and signed helper identities`）修改的是签名 helper 与 Runtime 保全，未改这两段。

`e428233c051b40a1897b96745be5ccdc725f531f`，`fix(desktop): qualify the original local signing identity`：修正本地有效身份解析及原证书默认 requirement 判断，在既有严格签名验证中确认 trusted leaf。该提交已合入 main；这份源码资格不提升为当前安装副本已使用原证书。

## 根因分析

直接原因：`preload → contracts → scratch-topics → scratch-topic-identity → Core/object-id` 的共享值导入被外置为裸 `require('@agentmux/core/object-id')`。Electron sandbox preload 不能任意加载 Node 包，执行抛 `module not found`，bridge 未暴露；Renderer 随即抛 `AgentMux preload API is unavailable`。重新启用外置所得反例 preload SHA256 为 `66e46cc5ce83b3a93610562475620acd14c0ee7a5a3eb30b7be89b1f344fae60`，与原安装包字节完全相同。

根因：跨共享模块的重构只被当成身份校验变化，没有把运行时导入闭包放到实际宿主安全边界中验证。交付流程又用“页面导航成功／Main 留下 ready 文件”代替“原 preload、bridge 与 Renderer 挂载真正成功”。这两个判断共同让可构建但不可用的包获得启动资格。

为什么没更早发现：`loadFile` 可以在 preload 错误时完成，Core 可连接也不能证明 UI 可用；原 CrashLog 仅捕获 Main 未处理异常及进程消失，preload 失败不必让 Renderer 进程消失，结果只留下较晚的就绪超时。已有[真实配置下启动验收](../design/behavior/session-recovery.md#启动配置错误与诊断)要求，但旧 smoke 没消费相同就绪回执，规则没有机械约束住该交付分支。

签名次因的直接原因有两处：有效身份行的警告后缀被锚定正则漏掉；Apple 实际生成的默认 designated requirement 使用 `certificate leaf = H"<原证书哈希>"`，旧判断却只认 `anchor H"<原证书哈希>"`。原证书是 self-signed，两种形状都可绑定同一原证书，不能以文本形状不同判定签名身份改变。

这部分的根因是交付资格把证书链诊断、代码签名信任及工具输出形状当成同一个判据。[Apple 的有效身份枚举实现](https://github.com/apple-oss-distributions/SecurityTool/blob/main/identity_find.c)可以同时打印证书链警告；证书单独执行 X.509 校验所得的 `AnchorTrusted=0`，也不等于真实签名的 [`certificate leaf trusted`](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/reqinterp.cpp) 不成立。先前用简化身份行和单一 requirement 文本作反例，没有经过原证书、真实 Mach-O 签名及实际 strict 校验，因而没发现这两处误拒。原证书本机反例才将这些事实分开；证书链诊断的具体原因仍未确定。

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
4. 修正原本地证书的身份解析与默认 requirement 判断，并在既有 staged-App 严格校验中确认 `certificate leaf trusted`。
   - 是否足够 root：原交付入口只有一个本地证书资格 owner，覆盖本次已证明的两处误拒；Developer ID 与禁止 ad hoc 安装的分支保留，不把任意证书警告变成有效身份。
   - 能否彻底避免：本可阻止本次有效警告行及合法原证书 requirement 的误拒；不保证任意 Keychain、证书链或系统信任故障都可交付。
   - 是否降低系统熵：沿用原签名、校验和安装调用链，不新增生产签名见证或兼容身份；解析增加一种已证警告后缀，默认 requirement 接受两种精确原证书形状，原校验增加一个信任条件。更简的“忽略所有警告／删除签名校验”会放过未知后缀、混合重复身份、错证书或篡改产物，已由负例否定。

## 验证

动作 1、2 的命令从仓库根执行，先按项目正常构建产生 Renderer：

```sh
env -u ELECTRON_RUN_AS_NODE node apps/desktop/scripts/verify-sandboxed-preload.mjs
```

实际 production-config 构建、真实 sandbox Electron 与完整 Renderer 得到 GREEN：bridge 可用、工作面已挂载、一个真实 ready token、原 toolkit observer 可创建并释放。受控恢复读取一直 pending，仍须可确认已挂载界面。恢复外置的 compiled 反例独立得到语义 RED：原模块错误、bridge 缺失、root 空、没有 ready token；编译失败或外层超时不算此 RED。验证提取实际 Main loader 与 ready consumer，生产调用者是 Main 普通 RendererUpdates 与 ready-file 分支；脚本同时冻结所消费源码。另有 18 项加载接线检查通过，不能以这些文本检查替代真实执行。

动作 3 的源码资格已独立核验，复现命令是 `node apps/desktop/scripts/verify-workbench-startup-capture.mjs`。真实 sandbox Electron 验证原 preload 失败、早期 bootstrap import 失败、健康 Ready／IPC 及诊断 sink 失败；原始资格包含 4 项实际 sandbox 检查、37 项聚焦检查、4 个编译生产语义反例和 11 个定义文件外生产调用者。独立评审另发现同一路径上的旧文档错误可能污染新启动尝试；补上单个准确 `renderer-update` token 归属后，8 项聚焦检查通过，移除该生产校验的新增变异触发原断言失败。原 loader 与未变承载代码的证据被明确复用，未把旧二进制冒充新源码；此资格仍不替实际用户安装实例背书。

动作 4 的签名修复候选已独立通过资格验证，命令从包含该修复的源码根执行：

```sh
PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false node apps/desktop/scripts/verify-macos-signing-qualification.mjs
```

54 项 focused 检查、4 项真实原证书 native 签名／校验检查通过；未知后缀、同 SHA 的混合重复行、错证书和篡改产物均有拒绝断言。恢复旧身份解析、换错叶证书 requirement、跳过严格校验的三个源码变异分别得到语义 RED；只有预期身份误拒、原生 requirement 拒绝及篡改漏拒算数，工具启动失败、超时或任意异常不算。Apple 实际生成原证书 leaf-hash requirement 的首轮失败也保留，没有改写成通过。真实生产链是 [package-macos.mjs](../../apps/desktop/scripts/package-macos.mjs) 的预检 → 现有签名器 → staged-App strict／trusted-leaf 校验 → 发布及安装，失败停在安装前。此资格不证明用户 App 已安装、隐私授权连续性或全部 Session 恢复；产物仍非公证发行。

## 遗留

- 原启动修复、首因观测和签名资格是不同切片；实际交付须核包含这些修复的 main、编译内容及正在运行的安装实例，不能用一次 source 或签名请求代签。
- 现场 ad hoc 副本的工作面可见，但正常证书签名更新及真实用户配置下的原工作面、Session 恢复仍须各自确认；本轮隔离 GREEN 不替用户安装实例取得资格。
- 后续 `app.inspect` 的 Recall 嵌套枚举遗漏，以及远程 Host 检查旧 endpoint 时的 `Invalid control endpoint publication observation`，是独立观测缺口。`bbc905ed` 增加 publication 字段后，SSH 旧接口诊断未同步其严格解码；Recall 已有生产投影却漏更新嵌套枚举。`95ce66c2` 修复两处消费者，11 项实际 SSH stdio 与 7 项原 Store／IPC／Main 检查通过；3 个生产编译变异触发对应语义断言，当前协议、错误目标拒绝及原工作面保留。安装实例是否已消费这些修复仍须核对，不能据观察失败判定健康 Agent 已死亡。
- 先前共享容量故障后的部分原 Run／Provider 恢复身份仍未确认，归[原容量事故](all-sessions-unrecoverable-with-disk-space.md)，不靠本次启动修复批量重启或替换 Session。
