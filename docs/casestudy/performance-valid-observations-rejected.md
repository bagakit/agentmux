# Performance 合法观察被防御规则误拒

## 定性

P1。本案范围是官方 Performance 工具经 Toolkit、公共 RPC 与 CLI 取得观察的链路：合法的观察数据被通用 Settings JSON 校验和输出回压误判为非法或超限，用户无法用 Performance 观察定位卡顿。定为 P1 的理由：受影响的是观察工具，不是 Agent 能力，Agent、Run 与工作面都不受影响；这条观察链此前是否在同等规模的现场数据上跑通过，未知，所以“防御拿走了已跑通的能力”这条 P0 判据无法判定成立。官方 Performance 在 `aa70f4b18f` 上线时只用浅层 `record()` 校验结果字段；深度 walker 约 11 小时后由 `0ce7a37cfb` 接入；256 KiB 输出预算和把 `write()` 返回 false 当成失败，则从 `aa70f4b18f` 首版就存在。

用户同期报告的顶部 Terminal 页签约十五秒等待是另一个现场，本复盘不覆盖它的归因；观测链修复也不代表安装后的实际体验已经恢复。

## 用户可见症状

Performance 报错：

> `Settings resource JSON is invalid or exceeds its budget.`

同一机制的几种触发形态见下一节；它们都是“合法数据进入合法外层后被额外规则拒绝”，属于同一类缺陷，但分别落在 JSON 深度、帧预算和输出回压三个不同的边界上。

## 影响面

**坏了什么**：原实际公开 watch 的八个 Renderer 样本约十四至十五 KB，均包含六个非空 Terminal interaction，Tab switches 为空。完整 Observation 含根共九层容器，已超过 Settings JSON walker 允许的八层；加上 Toolkit snapshot／result 包装后更深。Metrics schema 接受这些具名数据，Toolkit 却把整个结果送入通用 Settings 叶子 walker，误拒合法观察。

固定 Main `9d4fd28732` 的全链路审查又发现以下实际源码反例；身份和数量均为私有合成输入，没有创建相应数量的用户 Run：

| 输入与阶段 | 合法性 | 失败原因 |
| --- | --- | --- |
| 1,200 个普通 RunUsage，脚本输出 235,087 字节 | 通过 Metrics、Toolkit snapshot／result schema，低于原脚本 256 KiB | `stdout.write()` 返回 false 被当成输出超限 |
| 1,500 个 RunUsage，公开 opening 293,350 字节 | 低于 Metrics 条数上限及公共单帧预算 | 官方脚本另设 256 KiB 拒绝 |
| 完整八层 Host Test input 原样出现在 result.input | 请求及独立 JSON 叶子合法，同一叶子也可经 resource.get 返回 | 对整个回执再次限深，包装扣减了叶子的深度容量 |
| 修复后的官方脚本调用真实编译 CLI，消费私有 Unix Metrics owner | 合法大帧，应进入通用 Toolkit | CLI 的同步 onFrame 也把 write(false) 当成失败 |

**以下不受影响**：

- Agent、Run 与工作面：失败只发生在观察读取链路。
- 较浅的观察：一次五 KB 的 get 样本没有触发该错误。
- 固定 schema 的 Upgrade 与 Browser-link 结果：当时没有发现合法数据被误拒，这些 deep guard 继续保留；部分子解析器依赖外层纯数据防护。

## 止血措施

修复前没有可靠的带内办法取得完整观察。较浅的单次 get 不一定触发该错误，但不能代替完整 watch。不为取得观察而截断或改写观察内容，也不放宽全局深度。

## 引入时间线

命令：

```sh
git log -S 'settingsResourceRecord' --format='%h %ad %s' --date=short -- packages/core/src/toolkit.ts
git log -S 'rpcEncode' --format='%h %ad %s' --date=short -- apps/desktop/resources/toolkit/performance.mjs
```

- `aa70f4b18f`（2026-10-01）`feat(toolkit): integrate reviewed official Performance execution`：官方 `performance.mjs` 首版上线。Toolkit 对结果只做浅层 `record()` 字段校验；脚本已对每行输出设 256 KiB 上限，并在 `process.stdout.write(line)` 返回 false 时以 “Performance output exceeded its bounded consumer.” 停止。后两项是本案帧预算与回压误判的源头。
- `0ce7a37cfb`（2026-10-01，比上一条晚约 11 小时）`feat(toolkit): support manually configured local scripts`：pickaxe 显示 `packages/core/src/toolkit.ts` 首次引入 `settingsResourceRecord`。通用 Settings 叶子 walker 自此进入 Toolkit 的 typed 回执路径。`settingsResourceRecord` 的名字看起来只做 record 校验，实际会递归复制整棵 JSON 并限深，返回类型是宽泛的 Fields；用在具名 DTO 的父层时类型检查仍能通过，却引入与叶子 schema 不同的接受规则。八层限制原本属于不透明资源 JSON，不是所有 typed 回执的深度合同。
- 同一 pickaxe 还列出三个只增减调用点的提交：`d84b379446`（`feat(toolkit): load editable local extension packages and preload Auth`）新增三处同样的 `settingsResourceRecord` 调用；`318d0d6ae3`（`chore(repo): integrate accumulated work on main`）整合旧快照时把这三处删掉；`1c20d1a5f7`（`fix(core): restore shared capabilities lost in stale snapshot`）把它们恢复。三者都没有改动 walker 本身：`packages/core/src/settings-resource-json.ts` 在 `0ce7a37cfb` 到 `c3a4fc3df8` 之间没有提交，`MAX_DEPTH = 8` 不变。
- `c3a4fc3df8`（2026-10-05）`fix(toolkit): validate metrics without Settings nesting limits`：首轮修复，Metrics 改由具名 schema 校验，保留原字节和条数上限。它只覆盖 Metrics 本身，没有执行随产品发布的官方脚本，也没有覆盖输出回压。
- `f38896cf7c`（2026-10-05）`fix(performance): preserve valid protocol payloads and bounded stream output`：全链路审查后的修复，改动官方 `performance.mjs`、CLI `agentmux.ts` 与 `control-codec.ts`，见改进措施。

## 根因分析

- **直接原因**：同一份合法数据经过了三层不同的边界——叶子 JSON 深度、线帧预算和输出 highWaterMark——却被其中不属于它的边界拒绝：typed 父层套用了不透明资源 JSON 的深度限制；脚本复制了一份更小的帧预算；脚本与 CLI 都把管道“建议等待”的返回值解释成容量失败。[Node Writable 合同](https://nodejs.org/api/stream.html#event-drain) 明确把 false 与等待 drain 关联，此时这次 write 已被接纳。
- **根因**：防御规则按“输入形状不熟悉就拒绝”编写，没有说明所守预算的 owner、真实超限反例和保留健康能力的范围。每个独立进程、插件或传输入口都需要校验身份、字段和完整帧；但在 typed 父层增加无关深度约束、把正常回压当成失败，是过度拒绝。
- **为什么没被更早发现**：首轮独立 review 覆盖了 parser、公共 RPC／CLI 的 Toolkit 消费和受控 Desktop IPC，但测试把合成结果直接交给 owner，没有执行随产品发布的官方脚本，也没有让真实 CLI 写出超过管道 highWaterMark 的合法 Metrics opening。小结果或 renderer unavailable 的 fixture 能通过，却避开了现场数据的深度；局部测试没有证明整条实际取数链可用。
- **规则怎样落到每个阈值**：现行 [RED-LINES《时限与容量必须守真实边界》](../../RED-LINES.md#时限与容量必须守真实边界)要求分别判断单条解析、在途内存与消费者积压，并说明每个阈值的保护依据。本案的深度和帧预算以通用 helper 与复制常量的形式进入调用方，评审看到的是“有校验”，没有逐个核对它守的是哪个 owner 的哪个边界；这类检查只有落到每个阈值的保护对象和真实超限反例，才约束得住。

## 改进措施

现行约束只在 owner 定义：官方观察脚本与 Settings 叶子深度见 [设置与观察《Toolkit 与官方 Performance 工具》](../design/behavior/settings-and-observation.md#toolkit-与官方-performance-工具)，帧与回压实现见[公共能力源码入口《帧、回压与观察成本》](../specs/public-capabilities.md#帧回压与观察成本)。

1. **官方脚本复用唯一线帧实现，并真正等待 drain。** 脚本直接复用公共 `AgentMuxRpcLines`／`rpcEncode`，一次只处理一个完整帧，输出等待 drain 后才继续读源；保留订阅身份、顺序、UTF-8、具名 schema、完整字节预算及取消能力，不截取观察来适应包装。
   - 是否足够 root：覆盖“脚本复制帧预算”和“把回压当失败”两个实例。
   - 能否彻底避免：本可阻止这两种误拒。
   - 是否降低系统熵：降低，删除脚本里的第二份帧预算与编解码。
2. **CLI 的同步订阅回调采用有界待发送字节策略。** 正常回压接纳合法帧，真正超出积压预算才释放读取者并返回准确错误；它不宣称等待 drain 或永远容纳慢消费者。取消和容量失败先释放订阅与 client，再结束本 CLI 的待发送输出；普通 end／EOF 继续完整 flush。
   - 是否足够 root：覆盖 CLI 这一个同类实例；回调仍是同步接口，所以采用有界接纳而不是等待 drain。
   - 能否彻底避免：本可阻止 write(false) 被当成失败；真正的积压超限仍会如实报错。
   - 是否降低系统熵：增加一个积压字节上限；被否掉的更简方案是“永远接纳”，它让慢消费者无限占用内存。
3. **叶子深度与外层预算分离。** Host Test／list 和 Executor Refresh 使用严格、浅层的数据字段信封；每个不透明 input／host 单独守原 JSON 深度。列表守普通数组、稠密 index 和数据 descriptor，所有纯数据校验完成后再对重建的完整回执守字节预算。
   - 是否足够 root：覆盖 Host Test／list 与 Executor Refresh 两处；固定 schema 的 Upgrade／Browser-link 未发现合法数据误拒，guard 保留。
   - 能否彻底避免：本可阻止包装扣减叶子深度这一形态。
   - 是否降低系统熵：中性。被否掉的更简方案是扩大全局深度或删除所有 deep guard：前者只是把阈值挪远，后者会去掉子解析器依赖的外层纯数据防护。

## 验证

最大合法形状的组合往返和真实产品脚本执行是这类缺陷的回归证明；空数据、小帧或仅 helper 单测不能替代。验收入口是 `node apps/desktop/scripts/verify-performance-protocol-boundaries.mjs`（由 `7bacdee974` 加入，脚本会先做 Core 生产构建，再运行行为检查与生产源码变异）。

验收覆盖合法最大叶子经真实 Unix RPC 与编译 CLI 往返、实际官方脚本的大帧与顺序背压、取消、真正积压超限、非法序号／目标／schema／UTF-8、getter 零调用及全回执预算；生产源码变异负责检验这些断言能否抓住回退。公开方法、CLI 命令和发现 schema 继续复用原 owner，没有新增 GUI 私有取数链。仅 destroy stdout 不能证明 Node 已退出，验收直接检查非读管道下进程自然退出与订阅只释放一次。

当时的 Source 验收：正常 Core 生产构建通过，21 项行为测试通过，15 个实际生产变异均触发行为断言失败。邻接 Host／Refresh 的 11 项测试在基线 `9d4fd28732` 与候选上都是 9 通过、2 失败，失败标题与原因一致（旧 CLI positional help 期待和旧 help 文案期待），本次新增失败为零，不代表全仓或既有测试全绿。

集成复验还发现一处变异判据缺口：在固定四百毫秒内要求源写入少于五帧，可能因解析或调度较慢而放过忽略回压的实现；源进度还包含管道预取，不能独立证明脚本已停止接纳输出。修正后的私有观察器透明调用原 `stdout.write`，保留真实字节、回调和返回值：先证实实际返回 false，再断言消费者未读时只有一个接纳帧，恢复后核对二十帧的完整顺序。首次集成 gate 的失败保留为失败，没有用旧 PASS 覆盖。

## 遗留

以下按本复盘时（`4cb213821d`）的状态记录；锚点之后的变化逐条注明提交。

- 当时首轮 JSON 修复 Task 的全 Core 测试类型质量阻断仍独立存在，未随本修复关闭。
- 结构类型本身不能证明运行时 JSON 预算和背压语义，不能承诺不再出现同类问题。本次用唯一线帧实现、叶子与外层分离、真实完整链路和行为变异缩小误用空间；新的 codec 框架或品牌类型并不能自动解决这些边界。
- 源码、构建与运行中的安装版本分别核对；本文不声称已更新用户当前应用，也不关闭顶部 Terminal 页签的慢事件。
