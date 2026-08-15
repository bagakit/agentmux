import { spawn } from 'node:child_process'

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
 * stdout 是**帧通道**：一行一条 JSON 记录，不是给人看的自由文本。脚本的 console 因此必须被接管，
 * 否则它随手一个 `console.log('{')` 就会污染帧。T-007 要加的「请求回主进程」也走这里加一种 kind，
 * 不用另开管道。
 */
const RUNNER_SOURCE = String.raw`
import { inspect } from 'node:util'

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

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
let fn
try {
  // T-007 会在这里带上注入的函数库：new AsyncFunction(...names, body)。现在没有可注入的东西，
  // 空数组的 spread 是死代码，所以不写。
  fn = new AsyncFunction('"use strict";\n' + code)
} catch (error) {
  fail('Script failed to parse: ' + (error?.message ?? String(error)))
}

let value
try {
  value = await fn()
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
    [`--max-old-space-size=${heapMb}`, '--input-type=module', '--eval', RUNNER_SOURCE],
    { env: environment, stdio: ['pipe', 'pipe', 'pipe'] }
  )

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

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
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
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    // 握手：等子进程说自己准备好了再喂代码，和 workspace-files.ts:393-399 同形。
    if (!inputSent && stderr.split('\n').includes(READY)) {
      inputSent = true
      child.stdin.end(input.code)
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
  ).finally(() => clearTimeout(timer))

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
