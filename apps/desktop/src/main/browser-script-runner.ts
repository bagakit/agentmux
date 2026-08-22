import { spawn } from 'node:child_process'
import { BROWSER_PAGE_CAPABILITY_NAMES } from '@agentmux/core'

/**
 * 在独立 Node 子进程里跑一段 Agent 写的脚本。
 *
 * 为什么必须是子进程：这段代码是 Agent 现写的调试程序，不是我们审过的代码。它可以 throw、可以
 * 死循环、可以一路 allocate 到堆爆。这三种情况都不允许波及 AgentMux 主进程——主进程掉了，
 * 用户的所有会话、终端、编辑器一起没。
 *
 * 为什么是 fork-self 而不是 Electron 的 `utilityProcess`：本仓已经有 fork-self 这个模式，
 * `workspace-files.ts:377-399` 用它给每个文件操作钉一个内核 cwd，已经被验证过。`utilityProcess`
 * 全仓一次都没用过（已 grep），引入它等于凭空多一种进程模型要永远维护。
 *
 * **与参考实现的结构差异，这条决定了 T-007 的形状**：参考实现（ego lite 的 `run.ts`）里，Node 和
 * 浏览器内核在同一个程序里，它的 `sendCDPMessage` 是进程内直接调用。我们不是：页面由 Desktop Main
 * 持有（`browser-view-manager.ts:2` 的 `WebContentsView`），子进程手里根本没有那个 WebContents。
 * 所以注入给脚本的那批页面函数必须把请求送回主进程执行、再把结果送回来——那条通道是 T-007 的职责，
 * 这里只负责「把代码跑起来、把结局如实带回来」。
 */

const READY = 'AGENTMUX_BROWSER_SCRIPT_READY'

/**
 * 注入脚本执行上下文的页面函数名。
 *
 * **清单本身住在 `@agentmux/core` 的 `browser-page-capability.ts`，那里是唯一事实来源。**
 * 此前它是本文件里的一个手写数组，而同一份事实另有两处手抄（`browser-view-manager.ts` 的
 * 动作子集、`agentmux-cli-help.ts` 的 Skill 散文）。三份分属两个包、不在同一条构建图上，
 * tsc 一个都守不到；漂移时没有东西变红，只是 Agent 不知道新能力存在、或接管后仍能改页面。
 *
 * 这里保留一个 re-export 而不是让调用方各自去 core 取：注入这件事是本文件的职责，
 * 「注入的是哪些名字」应该在注入点读得到。
 *
 * 这是**内部 API，不是对外协议**——改名、改签名、加参数都不用动版本化的 Control 契约
 * （`control.ts` 的 `AgentMuxControlRequest` 联合、`OPERATION_BUDGET`、CLI 帮助都不收这些
 * 名字）。兼容负担从协议层挪到了库层，而库可以随便改：Agent 每一轮拿到的都是当前这一版。
 * 完整理由（含为什么不接受坐标/selector、为什么 `js`/`cdp` 是必须项、为什么没有标签页动词）
 * 见 core 那份文件的头注释。
 */
export const BROWSER_PAGE_FUNCTION_NAMES = BROWSER_PAGE_CAPABILITY_NAMES

/** 脚本没能跑完的三种结局。分开是因为它们对 Agent 意味着完全不同的下一步。 */
export type BrowserScriptFailure =
  /** 脚本自己抛了（也包括语法错误）。Agent 要改的是脚本。 */
  | { kind: 'script-error'; message: string; stack?: string }
  /** 超时。脚本可能在死循环，也可能只是真的慢——两者在外部无法区分，所以只说"超了多久"。 */
  | { kind: 'timeout'; timeoutMs: number }
  /**
   * 输出太多，是我们主动截断并杀掉的。不并进 `crashed`：那会让 Agent 以为环境出了事，
   * 而实际上要改的是脚本（少打点日志）。这跟 timeout 不报成 crashed 是同一条理由。
   */
  | { kind: 'output-limit'; capturedChars: number }
  /** 子进程非正常终止：堆爆（OOM）、被信号杀掉、非零退出。 */
  | { kind: 'crashed'; reason: string }

export type BrowserScriptResult = {
  /** 脚本 console 输出，按发生顺序。超出上限会被截断，并在这里留下一条明说截断了的记录。 */
  logs: string[]
} & ({ completed: true; value: unknown } | { completed: false; failure: BrowserScriptFailure })

export type BrowserScriptRunInput = {
  code: string
  /** 超过这个时长就杀掉子进程。死循环唯一的出路。 */
  timeoutMs?: number
  /**
   * 子进程的 V8 老生代上限。失控的 allocate 会撞在这里变成一次 OOM 退出，而不是把整机内存吃光。
   * 留成参数是因为测试要用很小的值把 OOM 在一秒内逼出来。
   */
  heapMb?: number
  /**
   * 脚本调页面函数时，真正干活的那一头。页面归主进程持有（`browser-view-manager.ts` 的
   * `WebContentsView`），子进程手里没有，所以每一次 `click()` 都是一次进程间往返。
   *
   * 这笔开销是明知故犯：`ego` 没有它（Node 与内核同进程，CDP 是进程内调用）。但比"每个动作起一个
   * 新进程"的方案小两个数量级——那是进程启动，这只是一次 IPC 往返。换来的是脚本崩了不带塌主进程。
   *
   * 不传表示这一轮不给页面能力（纯计算脚本），此时脚本调页面函数会拿到一条明确的拒绝，
   * 而不是一个看起来像页面没响应的挂起。
   */
  onPageCall?: (name: string, args: unknown[]) => Promise<unknown>
  /** Main-owned stop/hand-off signal. Aborting kills only this isolated script process. */
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_HEAP_MB = 512
/**
 * 主进程侧攒下的输出上限。脚本是 Agent 现写的，`while(true) console.log(x)` 完全可能发生；
 * 没有这个上限，子进程的隔离就被主进程自己的内存增长破功了。
 */
const MAX_CAPTURED_BYTES = 1_000_000
/**
 * 子进程里跑的程序。
 *
 * 两条通道，分工是刻意的：
 * - **stdout 是帧通道**（一行一条 JSON）：脚本的日志和最终结果。脚本的 console 因此必须被接管，
 *   否则它随手一个 `console.log('{')` 就会污染帧。
 * - **IPC 通道**（`process.send`/`message`）：脚本调页面函数时的请求与应答。用 Node 原生的
 *   IPC 而不是在 stdout 上再糊一层协议，是因为它自带分帧与结构化序列化。仓内已有
 *   `stdio: [..., 'ipc']` 的先例（`workspace-files.ts:554`）。
 *
 * **这条通道对脚本是藏不住的，别假装能藏。** 试过三种摘法：`delete process.channel` 和
 * `defineProperty(process,'channel',{value:undefined})` 都会让 Node 收不到 inbound 消息
 * （它每次投递都要读这个属性）；只摘 `process.send` 则脚本仍能拿到 `process.channel.fd`，
 * 实测可以直接 `fs.writeSync(3, ...)` 写出裸消息。所以安全不建立在"脚本够不着"上，
 * 而建立在**父进程不把子进程的消息当权威**：每次调用的 callId 由父进程发号，父进程只认自己
 * 欠着的那个 id；伪造的应答落不到任何一次真实调用上（见下面 `pending` 的用法）。
 * 摘 `process.send` 仍然做——它挡住的是"不小心"，不是"故意"。
 */
const RUNNER_SOURCE = String.raw`
import { inspect } from 'node:util'

// 先把 IPC 句柄抢到闭包里，再从 process 上摘掉 send。
// 注意 channel 不能动——Node 每次投递 inbound 消息都要读 process.channel。
const hostChannel = process.send ? process.send.bind(process) : null
// 这一轮有没有页面能力，由父进程说了算：通道永远在（要靠它回结果），但没接浏览器时
// 调页面函数必须立刻被拒，而不是发一条没人应答的请求然后挂到超时。
const pageEnabled = process.argv[2] === 'page'
const sendToHost = pageEnabled ? hostChannel : null
const pending = new Map()
let nextCallId = 0

if (sendToHost) {
  process.on('message', (message) => {
    if (!message || message.kind !== 'page-call-result') return
    const slot = pending.get(message.callId)
    if (!slot) return
    pending.delete(message.callId)
    // 主进程报的失败要在脚本里长成一个真的异常——脚本作者用 try/catch 接它，
    // 而不是去检查一个 { ok: false } 对象（那种约定没人会记得遵守）。
    if (message.failed) slot.reject(new Error(message.message))
    else slot.resolve(message.value)
  })
}

// 摘掉 send：挡住的是"不小心"，不是"故意"（channel.fd 仍在，脚本真想写谁也拦不住）。
// 真正的防线在父进程：它只认自己欠着的 callId。channel 本身不能动——Node 投递 inbound 要读它。
process.send = undefined

function callHost(name, args) {
  if (!sendToHost) {
    return Promise.reject(
      new Error('This run has no page access: ' + name + '() is unavailable (no browser was attached).')
    )
  }
  const callId = ++nextCallId
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject })
    sendToHost({ kind: 'page-call', callId, name, args })
  })
}

function emit(record) {
  process.stdout.write(JSON.stringify(record) + '\n')
}

// 接管 console：脚本的输出是要回收给 Agent 的结果的一部分，不能散进 stdout 把帧冲烂。
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => {
    emit({
      kind: 'log',
      text: args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 4 }))).join(' ')
    })
  }
}

process.stderr.write('${READY}\n')

const chunks = []
// 整段读完再执行，不做流式分段：程序是一个整体，读到一半的 JS 没有意义。
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
const code = Buffer.concat(chunks).toString('utf8')

function fail(message, stack) {
  emit(stack === undefined ? { kind: 'error', message } : { kind: 'error', message, stack })
  process.exit(1)
}

// 注入给脚本的页面函数。每一个都只是"把名字和参数送回主进程"——真正的实现在主进程那边，
// 因为只有它持有 WebContentsView。名单在主进程侧定义并随握手传进来，这样加一个函数不用改两处。
const PAGE_FUNCTION_NAMES = JSON.parse(process.argv[1] ?? '[]')
const pageFunctions = PAGE_FUNCTION_NAMES.map((name) => (...args) => callHost(name, args))

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
let fn
try {
  fn = new AsyncFunction(...PAGE_FUNCTION_NAMES, '"use strict";\n' + code)
} catch (error) {
  fail('Script failed to parse: ' + (error?.message ?? String(error)))
}

let value
try {
  value = await fn(...pageFunctions)
} catch (error) {
  fail(error?.message ?? String(error), error?.stack)
}

// 返回值要过管道，所以必须可序列化。序列化不了就明说是哪个值——静默丢成 undefined 的话，
// Agent 会以为自己的脚本返回了空。
let encoded
try {
  encoded = JSON.stringify(value)
} catch (error) {
  fail('Script return value is not JSON-serializable: ' + (error?.message ?? String(error)))
}

emit(encoded === undefined ? { kind: 'result' } : { kind: 'result', encoded })
process.exit(0)
`

/** 一条 stdout 帧。 */
type RunnerRecord =
  | { kind: 'log'; text: string }
  | { kind: 'result'; encoded?: string }
  | { kind: 'error'; message: string; stack?: string }

export async function runBrowserScript(input: BrowserScriptRunInput): Promise<BrowserScriptResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const heapMb = input.heapMb ?? DEFAULT_HEAP_MB

  // 与 workspace-files.ts:375-376 同形：ELECTRON_RUN_AS_NODE 让 Electron 二进制当 Node 用，
  // NODE_OPTIONS 必须删——宿主环境里的 --require / --inspect 会连带注入到脚本进程里。
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete environment.NODE_OPTIONS

  const child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${heapMb}`,
      '--input-type=module',
      '--eval',
      RUNNER_SOURCE,
      // 名字始终注入，有没有页面能力由 runner 里的 sendToHost 决定。只在有能力时才注入的话，
      // 没能力时脚本会报 "click is not defined"——那看起来像 Agent 把名字写错了。
      JSON.stringify(BROWSER_PAGE_FUNCTION_NAMES),
      input.onPageCall ? 'page' : 'no-page'
    ],
    // 第四条 'ipc' 就是页面调用的通道，与 stdout 分开走。
    { env: environment, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }
  )
  const abortChild = (): void => {
    if (!child.killed) child.kill('SIGKILL')
  }
  if (input.signal?.aborted) abortChild()
  else input.signal?.addEventListener('abort', abortChild, { once: true })
  // Node 的类型只给三元组 stdio 配了"三条流都在"的精确重载；四元组会把每条流推成
  // 可能为 null。这里三条管道是我们自己在上面写死的，必然存在——与其在每处访问上加断言，
  // 不如在这一处把事实说清楚。
  const childStdout = child.stdout as NodeJS.ReadableStream
  const childStderr = child.stderr as NodeJS.ReadableStream
  const childStdin = child.stdin as NodeJS.WritableStream

  const onPageCall = input.onPageCall
  if (onPageCall) {
    // 父进程记着自己欠哪些 callId。脚本能往 IPC 里写任意消息（channel.fd 摘不掉），
    // 所以这里做两件事：同一个 callId 只服务一次（重放的第二条被丢掉），
    // 应答只由父进程自己发出——子进程发来的"应答"根本没有接收端，落不到任何一次调用上。
    const served = new Set<number>()
    child.on('message', (message: unknown) => {
      const call = message as { kind?: string; callId?: number; name?: string; args?: unknown[] }
      if (call?.kind !== 'page-call' || typeof call.callId !== 'number') return
      const callId = call.callId
      if (served.has(callId)) return
      served.add(callId)
      // 主进程侧不 await 这个 promise：一次调用挂住了不能把整条消息循环卡死。
      // 挂住的那次由脚本整体超时兜底（子进程被杀，pending 跟着没）。
      void Promise.resolve()
        .then(() => onPageCall(String(call.name), call.args ?? []))
        .then(
          (value) => {
            // 子进程可能已经没了（超时被杀 / 自己退了）。往死掉的 channel 写会抛，
            // 而那不是错误——只是答案没人要了。
            if (child.connected) child.send({ kind: 'page-call-result', callId, value })
          },
          (error: unknown) => {
            if (!child.connected) return
            child.send({
              kind: 'page-call-result',
              callId,
              failed: true,
              message: error instanceof Error ? error.message : String(error)
            })
          }
        )
    })
  }

  const logs: string[] = []
  let result: { value: unknown } | undefined
  let scriptError: BrowserScriptFailure | undefined
  let captured = 0
  let truncated = false
  let pending = ''

  const record = (line: string): void => {
    let parsed: RunnerRecord
    try {
      parsed = JSON.parse(line) as RunnerRecord
    } catch {
      // 非帧输出。脚本无法直接写 stdout（console 已被接管），所以这只可能来自 Node 自己
      // （比如 OOM 前的诊断）。当日志收着，不当成功也不丢。
      logs.push(line)
      return
    }
    if (parsed.kind === 'log') logs.push(parsed.text)
    else if (parsed.kind === 'result') {
      result = { value: parsed.encoded === undefined ? undefined : JSON.parse(parsed.encoded) }
    } else {
      scriptError = {
        kind: 'script-error',
        message: parsed.message,
        ...(parsed.stack === undefined ? {} : { stack: parsed.stack })
      }
    }
  }

  childStdout.setEncoding('utf8')
  childStdout.on('data', (chunk: string) => {
    captured += chunk.length
    if (captured > MAX_CAPTURED_BYTES) {
      if (!truncated) {
        truncated = true
        logs.push(`[输出超过 ${MAX_CAPTURED_BYTES} 字节，后面的都被丢弃了]`)
        child.kill('SIGKILL')
      }
      return
    }
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line !== '') record(line)
  })

  let stderr = ''
  let inputSent = false
  childStderr.setEncoding('utf8')
  childStderr.on('data', (chunk: string) => {
    stderr += chunk
    // 握手：等子进程说自己准备好了再喂代码，和 workspace-files.ts:393-399 同形。
    if (!inputSent && stderr.split('\n').includes(READY)) {
      inputSent = true
      childStdin.end(input.code)
    }
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>(
    (resolve) => {
      child.once('error', (error) => resolve({ code: null, signal: null, spawnError: error }))
      child.once('close', (code, signal) => resolve({ code, signal }))
    }
  ).finally(() => {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abortChild)
  })

  // 这里不处理"最后一行没有换行符"的残留：子进程写的每一帧都自带 `\n`，而 `close` 在 stdout
  // 读完之后才触发，所以收尾时 pending 必然是空的（实测确认过）。补一段永远不执行的兜底，
  // 等于给后面的人留一个看起来被守着、其实从没跑过的分支。

  // 顺序就是优先级：超时先于一切（被杀的进程说什么都不算数），然后是我们主动截断，
  // 然后是脚本自己报的错，最后才看退出码。倒过来的话，一个被 SIGKILL 的死循环会被报成
  // "crashed"，那是在说谎——进程是我们杀的。
  if (timedOut) return { logs, completed: false, failure: { kind: 'timeout', timeoutMs } }
  if (truncated) {
    return { logs, completed: false, failure: { kind: 'output-limit', capturedChars: captured } }
  }
  if (scriptError) return { logs, completed: false, failure: scriptError }
  if (exit.spawnError) {
    return { logs, completed: false, failure: { kind: 'crashed', reason: exit.spawnError.message } }
  }
  if (exit.code === 0 && result) return { logs, completed: true, value: result.value }

  // 退出码 0 但没带回结果帧，同样不算成功——「没报错」不等于「跑完了」（AGENTS.md:32-52）。
  const reason = exit.signal
    ? `Script process was killed with ${exit.signal}`
    : exit.code === 0
      ? 'Script process exited without reporting a result'
      : `Script process exited with code ${exit.code}`
  return { logs, completed: false, failure: { kind: 'crashed', reason: reason.trim() } }
}
