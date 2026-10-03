# 新建 Agent 与 resume 后终端丢色

终端丢色最初表现为 resume 后失去颜色，随后新建 Agent 也出现同样现象。这个案例记录技术探索：问题最终落在长寿命 Runtime 的环境继承，而不是只在恢复投影或颜色主题上。当前机制以 [Run 启动 adapter](../../packages/core/src/ctxmux-run-adapter.ts) 和 [terminal-environment-policy](../../packages/core/src/terminal-environment-policy.ts) 为准。

## 从颜色表现追到进程环境

颜色至少经过三层：CLI 决定是否输出 ANSI，Runtime 持有原始 PTY 字节与恢复 seed，renderer 解释这些字节。另一页有颜色、refresh 后显示变化，不能说明原 CLI 有没有产生颜色。

排查先看真实子进程的禁色变量，再看非空 raw ANSI 与恢复后的色值。当真实 child 仍带着 `NO_COLOR=1`、`FORCE_COLOR=0` 或 `CLICOLOR=0` 时，应先解释环境来源，不能靠主题配置补救。不同 CLI 对这些变量的遵从程度不同；同一环境污染可以呈现为一个 CLI 无色、另一个仍有颜色，不能据此写 Provider 特例。

## 为什么已经删键，子进程里仍然存在

关键区别是：**完整替换环境**和**增量覆盖父环境**具有不同的缺席语义。

```text
启动 App 的宿主 shell：NO_COLOR=1
             ↓
长寿命 Runtime：保留 NO_COLOR=1
             ↓
新客户端：删除 NO_COLOR，发送不含该键的 RunSpec.env
             ↓
Runtime 增量合并环境：缺席键不覆盖父环境
             ↓
真实 CLI：再次继承 NO_COLOR=1
```

`RunSpec.env` 是增量覆盖。JavaScript 的 `delete environment.NO_COLOR` 只使请求对象不含该键，不会删除 daemon 已持有的键。App 重启、当前客户端环境变干净，甚至新建 Agent，都可能继续复用原 daemon，所以这些动作本身不足以消除污染。

排查中的一个误导是 `execFile({ env: captured.env })`：它把环境完整替换为传入对象。从这个对象删键后，对照 child 确实不再带键，但这无法证明真实 additive Runtime 的行为。检查 RunSpec 缺键也有同样局限。必须让**同一个真实 Runtime 先持有脏变量**，再经正常 Core 启动 child，读取它实际收到的环境。

## 修在每次 exec 边界

只清冷激活环境无法覆盖已经启动的脏 Runtime；修改 Runtime 协议又会把客户端策略推到另一 owner。最终选择在唯一 Run 启动 adapter 使用成熟的系统 `env` 工具，显式移除最终环境中缺席的既有宿主信号：

```ts
const environment = { ...localProcessEnvironment(), ...input.env }
const unsetArgs = missingHostEnvironmentKeys(environment).flatMap(key => ['-u', key])
defineRun('/usr/bin/env', {
  args: [...unsetArgs, '--', input.program, ...input.args],
  cwd: input.cwd,
  env: environment
})
```

这是程序与 literal argv 的组合，不是拼接 shell 文本。`-u KEY` 表达取消继承，`--` 隔开工具参数与原程序；变量值仍留在环境中，不写进 argv。`env` 最后 exec 原程序，因此继续使用同一 PID／PTY，不增加常驻中间进程。

unset 集合从原 policy 与最终合并环境派生，不对全部变量作清空。原清理规则移除禁色信号和继承的宿主会话标记；有效显式 `FORCE_COLOR`、`CLICOLOR` 以及 Run 级 CI／会话标记继续保持。三条生产路径——Terminal、新建 Agent、semantic resume——共用 adapter，因此一次修复覆盖同一类误继承，而不需要在各 Provider 或 client 分别加分支。

新增工作仅发生在启动 Run 时：检查七个已有 policy 键并执行系统工具。输出、replay 和活跃终端阅读热路径没有增加环境扫描，也不扫描无关 Session。

## 怎样让反例击中真实机制

探索使用带七个脏宿主信号的私有 Native；当前 client 与 RunSpec 已删键，但旧实现的真实 child 仍继承全部七键。撤掉 exec unset 后，这个反例重新出现。对应生产回归保存在[长寿命 Runtime 环境测试](../../packages/core/test/long-lived-runtime-environment.integration.test.ts)，请求形状保护见 [Run 环境测试](../../packages/core/test/run-environment.test.ts)。

有用的观察组合是：

- **进程边界**：真实 child 环境、PID、cwd、literal argv、退出码与 signal。仅观察请求对象不足。
- **生命周期边界**：同一 Native 下新建、客户端进程重启后的 reattach、semantic resume；Session／nativeHandle 保持，reattach 保持原 Run，resume 创建新 Run。
- **颜色链路**：ANSI16、256 色和 RGB 原始字节，与 Native basic-vt restore bytes 经 xterm cell API 解释出的色值对照。它能区分“未输出颜色”和“恢复后解释错误”。
- **保护边界**：同 Runtime 上另设健康 sentinel，比较它的 PID、状态、输入游标和输出字节；私有 fixture finally 释放全部自有资源，不操作生产 Run。

这组反例的价值是把“对象看起来干净”变成“真实继承链确实干净”，不是多加一层检查框架。

## 做对、做错，以及后来的优化

| 探索中的选择 | 得到的教训与最后处理 |
| --- | --- |
| 先从 resume 的显示结果猜恢复问题 | 同样的问题也影响新建 Agent。把范围扩展到共同启动路径后，发现真实 child 已受父环境污染；显示问题不能只在 renderer 找。 |
| 删除最终环境对象里的禁色键 | 方向正确但只完成请求层清理。Runtime 采用增量合并，省略键会沿用父值；在 exec 增加明确的取消继承语义才闭合。 |
| 用完整替换环境的 child 做对照 | 对照实验自身能通过，却没有走真实 Runtime 的继承方式。后来让同一 Native 持有脏环境，正常 Core consumer 启动 child，直接观察实际继承结果。 |
| 只修冷激活环境 | 能保护新 daemon，覆盖不了复用的旧 daemon。保留冷激活清理，再把消除误继承放到每次 Run 启动，不靠重启 Runtime 获得“干净样本”。 |
| 按不同 CLI 的表现分别强制颜色 | 容易把通用环境缺陷变成 Provider 特例。最终只清理明确的宿主禁色信号，终端能力照实声明，不全局强制一种颜色模式。 |
| 统一既有 policy 与三个生产启动入口 | 将清理规则收在一个 owner；Terminal、新建 Agent 与 semantic resume 共用同一 adapter，不在 client 或 Provider 各留一份补丁。 |
| 用系统工具而不是字符串 shell wrapper | 显式 unset 不需要新协议、Runtime 或配置层。固定程序加 literal argv 保持输入语义，环境值不进入命令行，exec 继续保留 PID／PTY。 |
| 保留健康 Runtime 与原 Session | 原进程环境无法在线修改。修复下一次执行不等于可以为了颜色停止健康 Run；reattach 和 semantic resume 的身份语义仍由原 Core／Runtime 持有。 |

## 完整方案与边界

整个方案是相互配合的四步，而不是单独加一个 `env -u`：

1. **构建当前环境。** 读取当前客户端的有效环境，移除继承的宿主 CI／Agent 会话标记与禁色信号；冷激活用这份清理后的基线，避免新 Runtime 从一开始就污染。若通过采用增量环境的激活 API 调用，取消继承必须使用该 API 的显式 unset 合同，省略键不能代替删除。
2. **表达终端能力和执行意图。** Core 的 [terminalEnvironment](../../packages/core/src/client.ts)声明 `TERM`、`COLORTERM`、终端程序身份及公共 CLI 入口，然后合并原执行配置并作最终禁色清理。合法 Run 级设置保持其既有语义，不把宿主 marker 当新会话身份。
3. **消除长寿命父环境的残留。** 每次 adapter start 合并当前基线与 Run 覆盖，按最终缺席的受管键生成 unset；原请求不能取消的继承值，由最终 exec 边界移除。创建 operation、cwd、参数和执行事实继续沿原 owner，不另建启动或重试层。
4. **保全原颜色与恢复事实。** CLI 输出决定原始颜色，Runtime 持有 ordered bytes、checkpoint／seed，renderer 解释它们。环境修复负责让下一 Run 能正确产生字节，不改写历史输出，不造有色页面，不替换 Session 或伪造恢复完成。

这种边界安排保护的是新执行的环境；它不会在线改写已启动 CLI 的环境，也不能保证所有 CLI 都采用同样的颜色策略。实际系统工具集成回归限定原 macOS arm64 场景；其他系统或远端启动路径应在对应 owner 验证。RunSpec 如实记录系统 `env` wrapper，不能把它伪装为直接启动原程序。

可复用的经验是：**当执行者比调用者活得更久，缺席字段的语义必须沿真实继承链核对。** 对环境变量，“没传”经常意味着“沿用旧值”；需要删除时，应在最终生效边界使用确切的删除语义，同时保留原执行身份和健康进程。
