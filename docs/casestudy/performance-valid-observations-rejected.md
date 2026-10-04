# Performance 合法观察被防御规则误拒

本文复盘 Performance 报 `Settings resource JSON is invalid or exceeds its budget.` 的观测链缺陷。用户此前报告的顶部 Terminal 页签约十五秒等待仍是另一个未完成的现场归因；观测链修复不能代签该慢事件根因或安装后实际体验。

## 现场与同类反例

原实际公开 watch 的八个可用 Renderer 样本大小约十四至十五 KB，均包含六个非空 Terminal interaction，Tab switches 为空。完整 Observation 含根共九层容器，已超过 Settings JSON walker 允许的八个容器层级；增加 Toolkit snapshot/result 包装后更深。Metrics schema 接受这些具名数据，Toolkit 却把整个结果送入通用 Settings 叶子 walker，因而误拒合法观察。一次较浅的五 KB get 样本不能独立复现此错误。首轮修复 `fa214c47` 已让 Metrics 由具名 schema 校验，保留原字节和条数上限。

固定 Main `d924c0a0` 的全链路审查继续发现下列实际源码反例。身份和数量均为私有合成输入，没有创建相应数量的用户 Run。

| 输入与阶段 | 合法性 | 失败原因 |
| --- | --- | --- |
| 1,200 个普通 RunUsage，脚本输出 235,087 字节 | 通过 Metrics、Toolkit snapshot/result schema，低于原脚本 256 KiB | `stdout.write()` 返回 false 被当成输出超限 |
| 1,500 个 RunUsage，公开 opening 293,350 字节 | 低于 Metrics 条数上限及公共单帧预算 | 官方脚本另设 256 KiB 拒绝 |
| 完整八层 Host Test input 原样出现在 result.input | 请求及独立 JSON 叶子合法，同叶子也可经 resource.get 返回 | 对整个回执再次限深，包装扣减叶子容量 |
| 修复后的官方脚本调用真实编译 CLI，消费私有 Unix Metrics owner | 合法大帧，应进入通用 Toolkit | CLI 的同步 onFrame 也把 write(false) 视为失败 |

## 为什么会发生

问题跨越协议组合和流控边界。通用 `settingsResourceRecord` 名称看似只做 record 校验，实际递归复制整棵 JSON 并限深；返回类型是宽泛 Fields。它容易被用于具名 DTO 的父层，类型检查仍能通过，却引入与叶子 schema 不同的接受规则。八层限制最初属于不透明资源 JSON，不是所有 typed 回执的深度合同。

线帧预算、数据 schema 和输出 highWaterMark 属于三个不同事实。脚本复制一份较小的帧预算，脚本与 CLI 又都把管道建议等待的返回值解释成容量失败。[Node Writable 合同](https://nodejs.org/api/stream.html#event-drain) 明确将 false 与等待 drain 相连；此时该次 write 已被接纳。每个独立进程、插件或传输入口校验身份、字段和完整帧是必要的；在 typed 父层增加无关深度约束、把正常回压当失败，则是过度拒绝。

首轮独立 review 覆盖 parser、公共 RPC／CLI 的 Toolkit 消费和受控 Desktop IPC。测试把合成结果直接交给 owner，没有执行随产品发布的官方脚本，也没有让真实 CLI 写出超过管道 highWaterMark 的合法 Metrics opening。小结果或 renderer unavailable 的 fixture 能通过，却避开现场数据的深度；局部测试没有证明整条实际取数链可用。

## 修复与可执行约束

官方脚本直接复用公共 `AgentMuxRpcLines`／`rpcEncode`；一次仅处理一个完整帧，输出等待 drain 后才继续读源。它保留订阅身份、顺序、UTF-8、具名 schema、完整字节预算及取消能力，不截取观察来适应包装。

CLI 的现有 RPC 回调是同步接口，本轮采用明确的有界待发送字节接纳策略：正常回压接纳合法帧，真正超出积压预算才释放读取者并返回准确错误。它不宣称等待 drain 或永远容纳慢消费者。取消和容量失败先释放订阅／client，再结束本 CLI 的待发送输出；普通 end／EOF 继续完整 flush。仅 destroy stdout 不能证明 Node 已退出，验收直接检查非读管道下进程自然退出与订阅只释放一次。

Host Test/list 和 Executor Refresh 用严格、浅层的数据字段信封；每个不透明 input／host 单独守原 JSON 深度。列表守普通数组、稠密 index 和数据 descriptor，所有纯数据校验完成后对重建的完整回执守字节预算。扩大全局深度、删除所有 deep guard 都不正确：当前固定 Upgrade／Browser-link schema 尚未发现合法数据误拒，且部分子解析器依赖外层纯数据防护，这些 guard 仍保留。

验收覆盖合法最大叶子经真实 Unix RPC／编译 CLI 往返、实际官方脚本的大帧与顺序背压、取消、真正积压超限、非法序号／目标／schema／UTF-8、getter 零调用及全回执预算；生产源码变异负责检验这些断言能否抓住回退。公开方法、CLI 命令和发现 schema 继续复用原 owner，无新 GUI 私有取数链。具体实现与入口见 [公共能力来源](../specs/public-capabilities.md#cli-与服务的当前来源)。

本轮 Source 验收为正常 Core 生产构建通过、21 项行为通过、15 个实际生产变异均触发行为断言 RED。邻接 Host／Refresh 的 11 项测试在精确干净 `d924c0a0` 基线和候选均为 9 通过、2 失败，失败标题与原因一致：旧 CLI positional help 期待及旧 help 文案期待。本次新增失败为零，不冒全仓或既有测试全绿。原 JSON 修复 Task 的全 Core 测试类型质量阻断仍独立保留。

## 防止复发的边界

合法叶子进入合法外层后，除完整消息字节超限之外，应仍能通过原消费协议。最大合法形状的组合往返和真实产品脚本执行是这条性质的回归证明；空数据、小帧或仅 helper 单测不能替代。新增拒绝必须说明所守预算的 owner、真实超限反例及保留健康能力的范围，不能把不熟悉的输入形状或普通流控信号当成失败。

结构类型本身不能证明运行时 JSON 预算和背压语义，因而不能承诺从此绝不再写出这类问题。本轮用唯一线帧实现、叶子与外层分离、真实完整链路和行为变异降低误用空间；全新的 codec 框架或品牌类型并不能自动解决这些事实边界。源码、构建、运行中的安装版本分别核对，本文不声称已经更新用户当前应用，也不关闭原 Terminal 慢事件。
