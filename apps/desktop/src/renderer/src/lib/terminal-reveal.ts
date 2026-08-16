import type { AgentMuxRunInputData, AgentMuxRunState } from '@agentmux/core'
import { agentViabilityFromProcessState, type StepOutcome } from './service-window-notice'

/**
 * 揭示不得被我们自己的步骤无限期挡住（AGENTS.md 原则 11）。
 *
 * 隐藏终端画布的正当理由只有一个：把 replay 的历史重绘帧一次性写完，别让用户看见"终端自己在
 * resize"。那是一个**有终点**的理由。而恢复态此前只有两个出口——全链成功、attach 抛错——所以
 * "链上某处永不 settle"这一类落在了两者之间：ctxmux 活着、Run 活着、PTY 活着，界面却永久转圈。
 *
 * 这一层因此只回答两个判断：**该不该把画布交还用户**，以及**交还时要说什么**。两者都不在
 * useEffect 里做——本仓跑不了 effect，写在那儿的取舍没有断言够得着。第二个判断复用服务窗既有的
 * 分类器（`service-window-notice.ts`），不新建第二条失败通路。
 */

/**
 * 揭示的兜底时限。
 *
 * 这个值不是"replay 应该多快"的估计——正常路径由 replay 自己的完成来揭示，根本走不到这里。
 * 它回答的是另一个问题：**一次卡住要让用户盯着看多久才算过分**。取 6 秒：短到用户还没开始怀疑
 * 是不是自己电脑坏了，长到一次真实的大 scrollback 重放不会被误判成卡住。
 */
export const TERMINAL_REVEAL_DEADLINE_MS = 6_000

/**
 * 到点了没有。
 *
 * `revealed` 为真时一律不主张任何事：正常揭示已经发生，这个兜底不是第二个揭示者——否则一次正常
 * 但偏慢的恢复会在事后补一条"没走通"的告示，那是在给一件成功的事贴失败标签。
 */
export function terminalRevealDecision(input: {
  revealed: boolean
  startedAtMs: number
  nowMs: number
  deadlineMs: number
}): { reveal: boolean; overdue: boolean } {
  if (input.revealed) return { reveal: false, overdue: false }
  const overdue = input.nowMs - input.startedAtMs >= input.deadlineMs
  return { reveal: overdue, overdue }
}

/**
 * 揭示之后输入是否已经接通。
 *
 * 这是"放行"里最容易出错的半句：画布交还用户 ≠ 什么都通了。强制揭示发生时 replay→live 的交接
 * 可能还没完成（`releaseLiveOutput` 未跑到），此刻键盘敲下去会写进一个还没接上的 attachment。
 * 所以三条输入通路（`onData`、粘贴、Shift+Enter）都必须等这一位为真——**三条一致**，
 * 少卡一条就等于没卡：用户总会找到那一条。
 *
 * 拎成纯函数是因为那三个 gate 长在 attach effect 里，本仓跑不了 effect（renderToStaticMarkup），
 * 写在那儿的取舍没有断言够得着——它们此前确实一条测试都没有，三个 gate 一起删掉全仓 1512 个
 * 测试照样全绿（变异实测）。
 */
export function terminalAcceptsInput(input: {
  /** Run 还能不能被控制（进程在跑）。 */
  canControlRun: boolean
  /** 这个 Session 此刻是否接受输入（Agent 有待答交互时不接受）。 */
  acceptsInput: boolean
  /** replay→live 交接是否已完成。 */
  liveReady: boolean
}): boolean {
  return input.canControlRun && input.acceptsInput && input.liveReady
}

/**
 * 过闸才送出。
 *
 * 判定是纯函数不等于**用法**被守住：三条通路此前各自写 `if (acceptsInputNow()) write(...)`，
 * 而它们长在 attach effect 里，本仓跑不了 effect，所以只有源码文本守卫够得着。文本守卫数得出
 * "每处 write 前面都有个 acceptsInputNow()"，数不出**极性**——三处 `if (x)` 一起改成 `if (!x)`，
 * 76 条相关断言全绿（实测），而那是「每次击键都丢，且不该送的时候反而送」。
 *
 * 所以把"判定 + 送出"一起收进这里：调用方拿到的是一个已经带闸的 `send`，组件里不再有
 * `if` 可写反。极性于是落在跑得到的地方——这个 `if` 取反、整个函数变 no-op、或把 `accepts()`
 * 的结果缓存到构造时（那会让交接完成前建的 sender 永久哑掉），三颗变异各自都红。
 *
 * `accepts` 是回调而不是布尔值，正是为了挡住第三颗：闸的三个输入都是 ref/state，会在
 * attachment 生命周期里翻转，所以每次送出都要重新问。
 */
export function terminalInputSender(input: {
  accepts: () => boolean
  write: (data: AgentMuxRunInputData) => void
}): (data: AgentMuxRunInputData) => void {
  return (data) => {
    if (!input.accepts()) return
    // 空载荷不上线。xterm 有两处会送出「按了键但没有字节要发」：IME 组字途中的 `onData('')`，
    // 以及旧式鼠标上报被禁用/坐标越界时 `onBinary('')`（经 encodeTerminalBinaryInput 变成零长
    // Uint8Array）。ctxmux daemon 的 RecoverableInput 校验会拒绝空载荷，抛
    // `recoverable native Input must not be empty`——于是用户只是在 TUI 里正常打字（尤其用中文
    // 输入法），就吃到一个「Something failed unexpectedly」。
    //
    // 闸放在这个唯一出口而不是两个订阅里各加一份：accepts 的极性已经只在这里判一次
    // （见 subscribeTerminalInput 的注释），空值判据跟着它走，否则下一次改闸必漏一处。
    // 判长度而不是判真值：`'0'` 是合法输入而 `''`/零长字节不是，`if (!data)` 会把两者混为一谈。
    if (data.length === 0) return
    input.write(data)
  }
}

/**
 * 旧式鼠标上报的字节，从 latin1 语义的字符串还原成 Uint8Array。
 *
 * xterm 有两个输入事件源：SGR 编码（程序开了 DECSET ?1006）的上报是 ASCII，走
 * `triggerDataEvent → onData`；而只开了旧式协议（?1000/?1002/?1003 或 ?9 而没开 ?1006）时，
 * 坐标字节可能 ≥128，为了不被 UTF-8 破坏，xterm 走 `triggerBinaryEvent → onBinary`，送出的
 * 字符串是 **latin1 语义**——每个 char code 就是一个字节（见 @xterm/xterm CoreService，实读坐实）。
 *
 * 关键：这条字节**不能**再当文本经 UTF-8 编码上线。实测 ctxmux SDK 的入站编码是
 * `typeof data === 'string' ? new TextEncoder().encode(data) : data`——字符串走 UTF-8、
 * Uint8Array 原样透传。若把 0x80 这种 latin1 字节当字符串上线，UTF-8 会把它拆成 0xC2 0x80，
 * 坐标就毁了、而且凭空多一个字节。所以这里在源头就编成字节，让它以 Uint8Array 的身份透传。
 */
export function encodeTerminalBinaryInput(report: string): Uint8Array {
  return Uint8Array.from(report, (ch) => ch.charCodeAt(0) & 0xff)
}

/**
 * 终端的两个输入事件源。抽成接口是为了让下面的接线**跑得到、断言得着**——它本来长在 attach
 * effect 里，本仓跑不了 effect（renderToStaticMarkup 对 effect 完全失明），删掉 onBinary 订阅
 * 不会让任何断言变红。
 */
export type TerminalInputEventSource = {
  onData: (listener: (data: string) => void) => { dispose(): void }
  onBinary: (listener: (data: string) => void) => { dispose(): void }
}

/**
 * 把两个输入事件源接到**同一个** `send` 出口。
 *
 * onData 与 onBinary 是同一件事（用户输入）的两个编码面，必须共用同一把 accepts 闸——就是
 * 调用方传进来的那个 `terminalInputSender({ accepts, write })`。绝不给 onBinary 复制第二份判据、
 * 也绝不给它开第二个 write 出口：那样 accepts 的极性就有了第二个说法，下一次改闸必漏一处。
 *
 * 差别只在编码，且只发生在**源头**：onData 是合法文本（键盘、SGR 鼠标上报都是 ASCII/Unicode），
 * 原样交给 send 走 UTF-8；onBinary 是 latin1 字节，先 `encodeTerminalBinaryInput` 成 Uint8Array
 * 再交给 send，从而以字节身份透传、不被 UTF-8 二次编码毁掉坐标。
 *
 * 返回一个合并的 disposable：两个订阅都挂在它上面，cleanup 里一次 dispose 跟上 onData 原来那条
 * 清理路径，绝不各自散落。
 */
export function subscribeTerminalInput(
  source: TerminalInputEventSource,
  send: (data: AgentMuxRunInputData) => void
): { dispose(): void } {
  const data = source.onData((report) => send(report))
  const binary = source.onBinary((report) => send(encodeTerminalBinaryInput(report)))
  return {
    dispose() {
      data.dispose()
      binary.dispose()
    }
  }
}

/**
 * 强制揭示时把这一步映成服务窗认得的结局。
 *
 * 判据是**这个 Run 还能干活吗**，不是"我们的揭示步骤过了吗"：进程在跑就是第 2 类（放行 + 提醒），
 * 退了才是第 1 类（交给既有恢复横幅），既非在跑也非退出就如实说分不清。
 * 没到点则返回"走通了"——一次正常完成的恢复不该留下任何降级痕迹。
 *
 * `liveReady` 必填且无默认值。它曾是 `liveReady?: boolean` 配 `=== false` 判断，即"没告诉我
 * 就当输入已通"——那正是原则 11 明令不许的「把未知当成好的」，且默认的那一侧恰好是会撒谎的
 * 那一侧（宣称 usable now 而键盘其实是哑的）。由类型强制每个调用方交代这件事。
 */
export function terminalRevealServiceOutcome(input: {
  overdue: boolean
  processState: AgentMuxRunState
  liveReady: boolean
}): StepOutcome {
  if (!input.overdue) return { completed: true }
  const step = {
    // 揭示了但输入还没通时，绝不说"现在可用了"——那是拿谎报换安静。如实说画面已回来、
    // 输入还在等交接，用户才不会对着一个哑掉的键盘以为自己没按对。
    label: 'Restoring this terminal',
    degradedMode: input.liveReady
      ? 'The terminal is usable now; its scrollback may be incomplete'
      : 'The terminal is visible, but input will unlock when its attachment catches up',
    restore: 'Reopen or resume this session to replay it again'
  }
  // 判据是这个 Run 还能干活吗（进程），不是揭示步骤过了吗：running 放行提醒、exited 交给恢复
  // 横幅、interrupted 如实说分不清——共用服务窗那唯一一处映射，绝不再手抄一遍。
  return { completed: false, step, agentViability: agentViabilityFromProcessState(input.processState) }
}
