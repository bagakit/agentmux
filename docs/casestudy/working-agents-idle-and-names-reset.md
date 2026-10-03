# Agent 正在执行却显示空闲，改过的名字又变了

## 定性

P1。状态投影误导用户对当前工作的判断，名称覆盖破坏对象辨识与协作追踪。现场健康 Run 仍可输入、输出；没有证据证明这些观察缺口已经使用户失去终端能力。Native 定位符错误另有恢复错目标的 P0 风险，必须在具体恢复操作上拒绝失配，不能因此停止健康 Run。

本案的现场读取、源码因果与修复验证分别成立；历史上某次名称覆盖的操作者、入口及具体触发尚无完整记录，不能从源码提交作者推断。

## 用户可见症状

> 明明在执行, 识别为 idle/ unknown

> 经常有改好名字的 Agent 名字又被覆盖 (看起来是 reset)

> 我们的所有改名都有记录, 且能区分出在什么地方谁干的吗? 如果不行, 观测面也要补齐

三个机制分别是：已消费的完成事实仍投影为空闲；原生主体归属与整体活动贡献未分开；多个命名入口混写同一个槽且没有写入约束和审计。ctxmux 的进程活性不能代替这些语义事实，升级 Runtime 不自动修复它们。

## 影响面

首次公共读取有 24 个 `running` Run，语义显示 active 7、idle 4、unknown 13。这个数不证明 24 个 Agent 都在工作。两个 Codex 样本分别出现缺少 nativeHandle、持有与实际 Run 主线程不符的 nativeHandle；对照会话的进程打开记录、启动参数、Core 定位符一致。证据只读打开记录首行身份，不靠“目录最新文件”选 Session。

| 能力 | 当时范围与后果 |
| --- | --- |
| 当前 Agent 状态 | STOPS 正确判断部分 Codex 当前活动；新 Hook 收到但不贡献活动，或者旧 done 仍显示 idle |
| 显示名 | STOPS 保证迟到 launch、旧草稿、布局写入不会覆盖手动名称；Agent 名还仅在 Chromium 投影保存 |
| 改名追踪 | STOPS 回答旧覆盖的完整 who/where；此前没有统一结构化记录 |
| Native 恢复目标 | PARTIAL 一例 nativeHandle 尚未观察、一例与实际 Run 主记录失配；未证明发生了错误恢复，不能把风险写成已发生 |
| 终端输入、ordered bytes、当前 Run | KEEPS WORKING；公共 Run 均 running，原 input/output 服务仍可用 |
| 正确主主体 Hook、明确子主体隔离 | KEEPS WORKING；对照主 Hook 正常刷新，foreign/child 不应获得主权限 |

以下不受影响：没有把 unknown 当作终局移除工作面；ctxmux 的原 Run、字节和输入权威未由本修复重建。依据为公共 `agent inspect` 的 Run/input/output 事实，以及 [RuntimeController](../../apps/desktop/src/main/runtime-controller.ts) 的 Core snapshot 消费路径。

Grok 三例只有陈旧 session_start，属于活动观察不足的另一种情况。已安装版本支持 Hook，配置也早于这些 Session；没有证据证明协议不支持、热加载失败或者同一主体过滤 bug。不得把它们自动改成 active。

## 止血措施

当前用户可继续使用原终端。用 `agent inspect --session <SID>` 分别看 Run、语义、readiness 与观察原因；unknown 不要求重建或停止 Session。名称暂时再改一次不能保证防止后到 writer，因此不是根治。

原生目标已经失配时，保留健康输入；那一次 Level B 恢复必须检查原目标并拒绝失配。旧版本没有能从界面内可靠纠正污染 nativeHandle 的带内动作，不能建议直接编辑 Session JSON。Grok 陈旧观察先检查原生 Hook 的 loaded/error 事实；不以停止健康 Session 作为前置。

## 引入时间线

以下来自 Git，不是对用户那次覆盖时刻的猜测。复现历史时固定调查基线 `b8e44e7c2ab057cc588dd64bfd64629fe4f0f920`；行号属于该基线，当前行号会移动。

```sh
git log b8e44e7c2ab057cc588dd64bfd64629fe4f0f920 -S stateEnteredAt --oneline -- packages/core/src/agent-semantic-state.ts
git log b8e44e7c2ab057cc588dd64bfd64629fe4f0f920 -L :invalidateAgentIdleEvidence:packages/core/src/agent-semantic-state.ts
git log b8e44e7c2ab057cc588dd64bfd64629fe4f0f920 --follow --pretty='%h %s' -- packages/core/src/agent-semantic-state.ts
git log b8e44e7c2ab057cc588dd64bfd64629fe4f0f920 -S subagentId --oneline -- packages/core/src/hook-normalizer.ts
git log b8e44e7c2ab057cc588dd64bfd64629fe4f0f920 --follow --pretty='%h %s' -- packages/core/src/hook-normalizer.ts
git log b8e44e7c2ab057cc588dd64bfd64629fe4f0f920 -L 5096,5112:packages/core/src/client.ts
git log b8e44e7c2ab057cc588dd64bfd64629fe4f0f920 -L 4960,4980:apps/desktop/src/renderer/src/store.ts
git log b8e44e7c2ab057cc588dd64bfd64629fe4f0f920 -S usesCaller --oneline -- packages/core/src/rpc-business-codec.ts
git log b8e44e7c2ab057cc588dd64bfd64629fe4f0f920 -L 81,90:packages/core/src/rpc-business-codec.ts
git log b8e44e7c2ab057cc588dd64bfd64629fe4f0f920 --follow --pretty='%h %s' -- packages/core/src/rpc-business-codec.ts
```

| 提交、日期、原 message | 当时优化与留下的缺口 |
| --- | --- |
| `e9500b55e`，07-26，`feat(desktop): give Agents and Tabs real names, and stop the Tab impersonating one Agent` | 名称读取优先级成立，但 manual 与 launch 共用写入槽；这是迟到覆盖这一类缺陷的引入点 |
| `232da098f`，09-29，`Merge branch 'main' into feat/goals-entry-closeoutf-2fw8f678a` | rename setter 的行历史合入其他目标工作；仍无来源/版本的写入合同 |
| `f64679846`，09-16，`feat(core): persist proven semantic state entry without guessing idle activity` | 输入消费只删 done.stateEnteredAt，正确避免猜 working；却未同时撤销公共 idle 投影。该函数到调查基线没有后续 Git 改动 |
| `354a7e4f5`，09-16，`fix(core): preserve main native handle across child hook events` | 给 native locator 加 child 保护；保护目标正确，但没有当前 Run 主线程的正向归属见证 |
| `ba453616c`，09-16，`fix: settle exact unclaimed native questions` | 将子主体判据复用到问题/定位隔离，仍未定义合法 child 对整体工作的新鲜度贡献 |
| `4d7871d3e`，09-18，`feat(core): accept provider-declared native hook semantics` | 泛化 Hook 规则，没有独立区分主体权限和整体活动 |
| `d0f4fc955`，09-20，`fix(core): preserve native subjects and truthful turn boundaries` | 把 locator 的隔离判据扩到 semantic/lifecycle；防止子任务冒充主完成，但也让真实下属工作不刷新整体状态 |
| `0cc472f28`，09-24，`fix(core): isolate native Hook facts by trusted Session membership` | 增强 foreign 隔离；不能去掉这道正确边界，需要补 Run 与原生主体归属 |
| `c2fd2b216`，09-25，`fix(core): scope tool traces to verified native sessions` | trace 隔离继续增强，未让 aggregate activity 成为独立事实 |
| `ebc5495f2`，09-30，`feat(cli): control exact display names and read current aliases` | 加入公共改名入口，仍继承 Renderer 名称槽和缺审计的设计 |
| `da4dfe439`，10-05，`feat(core): expose shared JSON-RPC service and object-first CLI` | `usesCaller` 是路由转换名单，rename 不在名单；没有独立的所有 mutation 可信 attribution 通道 |
| `c665cdc25`，10-05，`feat(core): share hosted RPC and browser HTTP transport` | 同一 caller 转换块增加 transport，仍继承来源缺口，并非删除了原有改名记录 |
| `490f898f8`，10-06，`fix(launcher): preserve unsent inputs and isolate draft updates` | 捕获 launch 名、保护输入草稿，尾部仍调用 manual setter；没有检查后来的手动 name revision |
| `f938400cd`，10-06，`feat(desktop): persist workbench positions through Core` | 将 spatial durable ACK 借给 Chromium-only 名称，准确引入了错误保存确认；不是证明现场名称已经落盘后丢失 |
| `52bae9f70`，10-06，`fix(survey): load zones directly and preserve browser recovery` | 显式 hydrate merge 继承 Zustand 默认合并顺序；正常启动 fence 已存在，不能称该提交让所有正常冷启动必然覆盖 |
| `984b66d91`，10-06，`feat(core): retain accepted session work history`；`6d1e2cd00`，10-06，`feat(core): resume original retained conversations explicitly` | nativeHandle 相邻行历史增加保存/继续语义，仅显式 reopen 目标有专门保护；未知来源的旧定位和实测当前定位仍没有分开的诊断事实 |

nativeHandle 写入行的更早历史还经过 `41f348c79`、`fefe174c7`、`27938b91d`、`8b96e183e`、`6a40dba49`（均 07-25）、`14e970c20`（08-01），分别建立语义 Session、Session/Run 分层、ctxmux 接入与 Provider 适配。该行历史只能证明这条写入链的演化，不能把工作区文件能力提交的作者直接认作此次污染者。根因是这条链一直缺少同 Run 的原生主体权威，而非最近一次依赖升级。

## 根因分析

**直接原因。** 新输入删除 idle 的时钟而保留 done，公共投影仍将 done 当成现在空闲。child 的隔离决定又同时用于主身份与整体 activity，使合法下属工具事件无法刷新整体状态。Codex session_id 在根与后代间共享，agent_id 是子线程 ID；继承的 Hook binding 只能认证 Core Session/Run，不能认证另一个 CLI/native 线程属于这个 Run。无明确 matcher 时默认接受的定位符可能替换现有 locator。

名称方面，读取端承诺 user > launch > derived，但存储只能表示一个名字，不能表示来源、手动清空意图或版本。clear 删键，迟到 writer 就以为仍可填默认名。Agent/Tab/Survey、完整图提交、Config、Topic、Demand、Browser task 与文件路径有不同 owner，单个 UI 日志不覆盖它们。保存回执又混淆了图 ACK、Renderer 持有值、Chromium flush 与名称真正 durable commit。真实文件替换后目录 fsync 失败，名称可能已经生效而磁盘确认仍未知；正常 watch 读取先到，也不能吞掉同版本的生产 ACK。

**设计与判断的根因。** 系统把不同资格的事实共用一个布尔决策或一个槽：完成历史与当前活动、主体权限与父任务活动、路由 caller 与操作来源、布局持久化与名称持久化。读取优先级没有落实到唯一写入 owner；未知与已确认的依据没有作为可追踪事实保留。新入口因此很容易只接上“能改”的 setter，忘记“谁有权覆盖哪一层”。

**为什么之前没有发现。** 既有测试有效保护 child/foreign 不得改变主会话，也验证输入消费自身行为；它们缺少这些事实组合之后经过 Main/Renderer 的当前投影反例。名称测试偏重 resolver 和 setter，未让迟到 launch、clear、双编辑者、旧 whole-graph、删除再加同 ID 与真实重启承重。无结构化 name history，观察面只能看到最后值，无法回答覆盖链。

已有分层、未知状态和不假确认规则存在，但没有绑定住所有 owner 的写入入口与返回值。再抄一遍规则不能防复发，必须让实际 owner 的版本/事务/公开回执约束这些入口。

## 改进措施

1. **Core 分开完成、当前活动与输入消费。** 保留主完成身份、readiness 和审批栅栏；新输入只能撤销旧当前结论到 unknown，不能猜 working。真实 child 活动在 Provider 证明归属后可贡献 aggregate activity。
   - 是否足够 root：覆盖主输入后旧 idle、真实 child 工作、组合后的再次输入这 3 类当前投影，而非只修一个文案；Core/public status/Main/Renderer 同时消费。同 Run 的 `currentActivityRevision` 排序当前事实；旧 done、冷快照和重复 ACK 不能重放已消费的 working/idle，主 completion identity 与原生时刻不改写。
   - 能否彻底避免：可阻止这三类已证事实误投影；无法凭空补出漏掉的原生 Hook。
   - 是否降低系统熵：取消复用一个语义 state 的隐含资格；增加必要的独立消费/整体活动事实。更简的“收到 bytes/ACK 就 working”会制造虚假活动，不能采用。
2. **Provider 基于相关 Run 的真实主/子打开记录判主体，保留定位来源。** 首次/不符候选有界发现并短缓存，现有针对 Session 的 refresh 能更新观察；不轮询所有 Session。foreign、unknown 保留 receipt 原因，不获主权限；明确 Level B 原目标受保护。已观察失配事实随退休历史保留，但不把旧 Run 权威带入重开。
   - 是否足够 root：覆盖缺定位、误定位、真实 child、同 binding foreign、显式恢复目标这 5 类边界；Codex 用实际打开的主/子记录建立 OS 归属；其他 Provider 的首次观察仅承诺经过认证 Run 的原生协议声明。Claude snake/Copilot camel 负例、Pi 的显式合法 transition 验证通用已知身份变化资格及 Level B 保护，不能泛称所有 Provider 都已有 OS membership。
   - 能否彻底避免：阻止无归属污染及错误目标那次操作；不能保证外部进程永远提供可确认的 opened-record。
   - 是否降低系统熵：复用 Provider discovery、Session owner 与原 history，未增加第二 Runtime。来源元数据和短缓存是新增成本；只比当前 handle 更简，却会让污染值永久封住真正主线程。
3. **名称写入回到 owner，名称/来源/版本/清空意图与记录同锁。** Agent/Tab/Survey 用现 spatial owner 通用 display-label；手动 clear 保留 tombstone。launch/derived 只能写自己仍拥有的层级；旧 revision 和完整图绕过被拒绝。Renderer 只消费 owner 发布的版本；已应用但 disk ACK 未知时仍显示实际名称和服务窗，普通 read 或 flush 不冒充确认。确认动作在原 owner 锁内持久化当前完整文档，不重放旧操作的名称。应用前失败/冲突单独保留可复查服务窗，无关工作面保存不会清除它。旧已有名字保留为来源未知，不能伪造过去是谁改的。旧 Tab 删除也在原锁内保留实际名称为 retained 事实，不新增虚构改名记录。受管对象删除后，历史仍按原稳定 target ID 查询。
   - 是否足够 root：直接覆盖 3 类 spatial display-label；包括普通 `space.commit`、受管名称删除再加原 Tab ID、以及旧格式无 display-label resource 的同类删除再加，而非仅加 UI 顺序检查。
   - 能否彻底避免：可阻止已扫描入口的迟到、旧草稿、旧布局覆盖；外部直接手改存储文件仍不能认证作者。
   - 是否降低系统熵：去掉 Chromium-only 独立名称真值，复用原 durable owner。增加 name revision/typed record；只有读取优先级或仅 UI 打日志更简，却不能约束其他 client。
4. **所有已扫描产品改名入口记录可信 who/where/result。** 另外 6 类 Config 字段、Topic/Mote、Demand/Goal、Browser task 草稿、文件/目录/URL shortcut 路径共 10 类，保留各自原 owner；统一 typed 历史投影。业务 payload 不能声明可信 actor；RPC、Toolkit、UI 和 Renderer relay 从认证边界传递 context。
   - 是否足够 root：加上前项共 13 类入口；首次赋名不是改名，直接外部 filesystem 编辑不冒充受控产品操作。
   - 能否彻底避免：观察面能定位将来覆盖链，不能单靠日志阻止各 owner 的所有业务冲突，也不能补造旧记录。
   - 是否降低系统熵：统一 context/result 格式和查询，不建另一 registry。跨 owner 无全局原子事务，因此先 durable intent 后 owner write，失联留 pending/unknown；强行把所有对象搬进同一个数据库虽然统一，却会复制原 owner。
5. **验证在事实组合、真实消费者和重启上成立。** 公共 Core→Main→Renderer、Unix `space.commit`、Demand 原 owner 和两次真实 GUI 进程恢复，分别承担对应资格的验收。
   - 是否足够 root：覆盖上述 13 类入口的真实接线和状态的组合边界，不以纯 resolver 或一次 build 代签。
   - 能否彻底避免：反例与生产变异能阻止同样改动再次假绿；新协议形态仍须新增相应行为证据。
   - 是否降低系统熵：复用普通主进程/Renderer 测试 harness，增加有限反例；只测定义函数更简，却不能发现消费链回退。

## 验证

从仓库根运行，取消 AgentMux/ctxmux ambient 路由变量；脚本在私有 fixture 中验证，用户 Runtime 不作为实验对象。先构建 Core 与 Desktop，使公共命令消费本批编译产物。可用以下方式执行表中的命令，环境过滤适用于全部 `AGENTMUX_*` / `CTXMUX_*` 变量：

```sh
python3 - <<'PY_ENV'
import os, subprocess
command = ['node', 'node_modules/vitest/vitest.mjs', 'run',
           'packages/core/test/session-status-authority.test.ts', '--maxWorkers=1']
env = {k: v for k, v in os.environ.items()
       if not k.startswith(('AGENTMUX_', 'CTXMUX_')) and k != 'NODE_OPTIONS'}
subprocess.run(command, env=env, check=True)
PY_ENV
```

本文列的是可复现的验收要求。接管时原 GUI receipt 是失败结果；本轮 GUI 重启资格须由独立验收的当次 `gui-receipt.json` 和交付检查确认，本文不能代签。通过源码测试也不能推断用户现场已经加载修复。

实现验收方法归 [测试策略](../testing/strategy.md#任务验收与假绿防护)。

| 措施 | 可复现证据与承重边界 |
| --- | --- |
| 当前状态、主体、原恢复目标 | `node node_modules/vitest/vitest.mjs run packages/core/test/session-status-authority.test.ts --maxWorkers=1`；实际 Hook ingress→durable Session→public status/RPC→Main snapshot/Renderer。`node packages/core/scripts/verify-session-status-authority.mjs` 的真实生产 mutation 与 exact restore 用于证明消费、主体归属、定位/目标保护、receipt 原因 |
| 名称写入、旧图绕过、来源/版本 | `node node_modules/vitest/vitest.mjs run apps/desktop/test/name-authority.test.ts --maxWorkers=1`；[Spatial owner](../../packages/core/src/spatial-state.ts) 的公开 service/Unix caller、[Renderer 名称投影](../../apps/desktop/src/renderer/src/lib/name-authority.ts) 与实际 store 接线 |
| 其他 owner 和全量 typed history | `node apps/desktop/scripts/verify-name-owner-audit.mjs`；8 项独立 Assertion RED→原字节 GREEN，13 个行为反例，8 个 Main 非定义生产调用点。实际 Config、Topic、Browser、Spatial/Demand query、可信 relay、partial result，未拿 IPC 文本扫描代替行为 |
| Demand 事务与 standalone CLI | [Demand name tests](../../packages/demand/test/demand-name-change.test.ts)；同 snapshot 历史、删除后保留、CAS、重试、actor 防伪、fsync 与 observer 的承重 mutation。真实独立 CLI 进程，publisher 失败不会撤销 confirmed commit |
| 冷启动与工作面/Run | `node apps/desktop/scripts/verify-name-authority.mjs`；消费实际编译 Main/Core/Renderer，记录两个普通 GUI PID 和首次 hydration，原 SID/Run/Tab/Region/分割、alias/clear 与未发送草稿须保持 |
| 源码、编译、交付身份 | 分别核对源码、主线提交、编译与实际 installed/loaded 身份；当次核对脚本和回执仅留本机过程资料，缺现场身份就明确未加载 |

后续接管集成另补了两条边界：当前 native discovery 不得替换显式恢复目标；公开 `agent.context` 须分别传输原目标与 observedNativeHandle。两条均经实际加载的生产变异 Assertion RED、恢复 GREEN；公开读取仍用原目标，健康输入保留。原 35 项状态变异保留完整反向字节证据链；整合时核对未变的承重方法并重跑当前 51 项状态行为，不能把旧候选的整文件 hash 当成新主线 hash。

重启测试曾继承 `ELECTRON_RUN_AS_NODE`，导致 Electron 以 Node 模式启动；另一次全局“第 2 次 fsync”故障注入被背景布局保存提前消费。它们是测试环境和注入归属错误，不是用户事故根因。修正为私有 GUI 子进程清除该变量、按实际改名 operationId 和替换后的名称文档注入，保留原 partial/unknown 与工作面断言。

记录历史不在每次终端输出传播：普通 spatial layout/subscribe 返回 `history: query-only` 和当前 labels，历史只经显式分页查询。相关 Native witness 同身份短缓存；未相关 Session 不执行 OS discovery。查询和存储成本仍随真实名称文档增长，不宣称无限历史为常数成本。

## 遗留

- 原有覆盖没有完整审计，不能给出当时具体谁、在哪里做的历史事实；已有值保留为 unknown/retained。
- Grok 三例仍需它们的原生 loaded/error 观察才能解释漏掉最近 Hook 的原因。支持协议和当前配置不代替实际 loaded 证据；保留健康输入及非阻塞观察缺口。
- Native witness 缺失、external file edit、第三方 SDK 没有可信 host context 时只能明确 unknown；不认证文字里的身份。
- 原始现场 receipt、PID、候选变异与重启产物保存在本机过程目录，长期本文不把旧候选绿灯当当前包通过。包/Runtime 精确 source 与 live identity 依公开事实另核；历史案例不能代签未来验收。
