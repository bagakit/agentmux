import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'
import { defaultAgentMuxControlSocketPath } from '../src/runtime-paths.js'

const execFileAsync = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
const packageManifestUrl = new URL('../package.json', import.meta.url)
async function run(args: readonly string[]): Promise<string> {
  return (await execFileAsync(cli, args, { timeout: 5_000, maxBuffer: 512 * 1024 })).stdout
}
/** 同 {@link run}，但带环境覆盖——`endpoint` 要证明它跟着 AGENTMUX_RUNTIME_DIRECTORY 走。 */
async function runWithEnv(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return (await execFileAsync(cli, args, { timeout: 5_000, maxBuffer: 512 * 1024, env: { ...process.env, ...env } })).stdout
}

async function fail(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  try { await execFileAsync(cli, args, { timeout: 5_000, maxBuffer: 512 * 1024, env: { ...process.env, ...env } }) } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number }
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code }
  }
  throw new Error('CLI unexpectedly succeeded.')
}

/** 同 {@link fail}，但从某个目录里跑——`roles` 三条子命令读的是 `process.cwd()`，不是任何选项。 */
async function failIn(cwd: string, args: readonly string[]) {
  try { await execFileAsync(cli, args, { timeout: 5_000, maxBuffer: 512 * 1024, cwd }) } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number }
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code }
  }
  throw new Error('CLI unexpectedly succeeded.')
}

/**
 * 带 stdin 跑一次 CLI。`browser run` 的程序整份从 stdin 读，而上面两个 helper 用的 execFile 不接管道：
 * 子进程的 stdin 一直开着且永不来数据，`for await (const chunk of process.stdin)` 就一路挂到 timeout。
 * 那种红看起来像"命令坏了"，其实是测试没给输入——所以这里必须是 spawn + 显式 `stdin.end()`。
 */
async function runWithStdin(
  args: readonly string[],
  stdin: string,
  env: NodeJS.ProcessEnv = {}
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(cli, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.stdin.end(stdin)
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, 15_000)
    child.once('close', (value) => { clearTimeout(timer); resolve(value) })
  })
  return { stdout, stderr, code }
}

describe('agentmux CLI discovery', () => {
  it('exposes only the intent-based Control surface', async () => {
    const help = await run(['--help'])
    expect(help).toContain('typed local Agent and Desktop control')
    expect(help).toContain('inspect')
    expect(help).toContain('open')
    expect(help).toContain('send')
    expect(help).toContain('focus')
    expect(help).toContain('arrange')
    expect(help).toContain('AGENTMUX_AGENT_SESSION_ID')
    expect(help).not.toContain('Composition:')
  })


  /**
   * 端点发现：一个非 Node 客户端要能问出"往哪连、什么协议版本"，而不必读我们的 TS 源码复算哈希。
   *
   * 期望值取自 `defaultAgentMuxControlSocketPath()` **本身**，不是在这里再拼一遍
   * `join(runtimeDir, 'control.sock')`：后者是第二份手抄，两份一起漂的时候它自己不会响。
   */
  it('endpoint 报出的路径与内部取值同源，并同时给出协议版本', async () => {
    const printed = JSON.parse(await run(['endpoint'])) as {
      ok: boolean
      operation: string
      result: { control: { path: string; transport: string; framing: string }; schemaVersion: number }
    }
    expect(printed.ok, 'endpoint 没能成功作答').toBe(true)
    expect(printed.operation).toBe('endpoint')
    expect(printed.result.control.path, '报出的路径与 defaultAgentMuxControlSocketPath() 不是同一个值')
      .toBe(defaultAgentMuxControlSocketPath())
    expect(printed.result.schemaVersion, '协议版本没报，或报的不是当前这一版')
      .toBe(AGENTMUX_CONTROL_SCHEMA_VERSION)
    // 承载方式也要说：客户端拿到一个路径但不知道是 unix socket + NDJSON，还是接不进来。
    expect(printed.result.control.transport).toBe('unix-socket')
    expect(printed.result.control.framing).toBe('ndjson')
  })

  it('endpoint 尊重 AGENTMUX_RUNTIME_DIRECTORY——不是只在默认环境下正确', async () => {
    const relocated = join('/private/tmp', `amx-endpoint-${randomUUID()}`)
    const printed = JSON.parse(await runWithEnv(['endpoint'], { AGENTMUX_RUNTIME_DIRECTORY: relocated })) as {
      result: { control: { path: string } }
    }
    expect(printed.result.control.path, '换了 runtime 根，报出的路径没跟着换').toBe(join(relocated, 'control.sock'))
    // 另一半：它**确实换了**。只判"等于 relocated 下那个"对"两边都返回同一个硬编码值"是瞎的。
    expect(printed.result.control.path, '覆盖前后报出的是同一个路径').not.toBe(defaultAgentMuxControlSocketPath())
  })

  it('daemon 没起也答得出端点：发现不等于连接', async () => {
    // 指向一个**空目录**——没有 control.sock，没有任何人监听。真实客户端的第一步正是这个状态。
    const empty = await mkdtemp(join(tmpdir(), 'amx-endpoint-nobody-'))
    try {
      const printed = JSON.parse(await runWithEnv(['endpoint'], { AGENTMUX_RUNTIME_DIRECTORY: empty })) as {
        ok: boolean
        result: { control: { path: string } }
      }
      // 必须是成功的答案，而不是「没有端点」。要求先连上的实现会在这里失败退出。
      expect(printed.ok, '没人监听时把"现在没人听"说成了"没有这个端点"').toBe(true)
      expect(printed.result.control.path).toBe(join(empty, 'control.sock'))
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('endpoint 有自己那条 --help，并且说清它不连接', async () => {
    const help = await run(['endpoint', '--help'])
    expect(help, 'endpoint --help 被说成不存在').not.toContain('Unknown command')
    expect(help).toContain('agentmux endpoint')
    expect(help).toContain('does not connect')
    expect(help).toContain('AGENTMUX_RUNTIME_DIRECTORY')
    expect(await run(['--help']), '顶层 Intents 里没有 endpoint').toContain('endpoint')
  })

  it('documents typed targets and exact destinations without contacting owners', async () => {
    expect(await run(['inspect', '--help'])).toContain('inspect --tab <tab-id|self>')
    const open = await run(['open', '--help'])
    expect(open).toContain('agentmux open terminal')
    expect(open).toContain('--left-of <region-id|self>')
    expect(open).toContain('--right-of <region-id|self>')
    expect(open).toContain('--above <region-id|self>')
    expect(open).toContain('--below <region-id|self>')
    expect(open).toContain('--new-tab-after <tab-id|self>')
    expect(open).toContain('--in-region <launcher-region-id>')
    expect(await run(['open', 'agent', '--help'])).toContain('--right-of <region-id|self>')
    expect(await run(['open', 'terminal', '--help'])).toContain('--command <shell-command>')
    expect(await run(['open', 'browser', '--help'])).toContain('--url <url>')
    expect(await run(['arrange', '--help'])).toContain('grid-9')
    const send = await run(['send', '--help'])
    expect(send).toContain('MESSAGE_TARGET_NOT_UNIQUE')
    expect(send).toContain('never resumes')
  })

  it('prints bounded Agent instructions for inspect, open, and send', async () => {
    const skill = await run(['--skill'])
    expect(skill).toContain('agentmux inspect --tab self')
    expect(skill).toContain('agentmux open agent --agent codex')
    expect(skill).toContain('agentmux send --to-tab <tab-id>')
    expect(skill).toContain('agentmux open terminal --command')
    expect(skill).toContain('agentmux open browser --url')
    expect(skill).toContain('Rename agent')
    expect(skill).toContain('Settings → Workspaces →')
    expect(skill).toContain('Do not invent an `agentmux rename` command')
    expect(skill).toContain('Workspace id')
    expect(skill).toContain('agentmux arrange --tab self --preset columns-3')
    expect(skill).toContain('agentmux arrange --tab self --preset grid-4')
    expect(skill).toContain('agentmux arrange --tab self --preset grid-9')
    expect(skill).toContain('--left-of <region-id>')
    expect(skill).toContain('--above <region-id>')
    expect(skill).toContain('--in-region <launcher-region-id>')
    expect(skill).toContain('deduplicating every caller Region')
    expect(skill).toContain('schemaVersion')
    expect(skill).toContain('candidates[].agentSessionId')
    expect(skill).toContain('Send never broadcasts and never resumes')
    expect(skill).toContain('No failure')
  })

  it('损坏的角色目录报自己的码，不折成「命令打错了」那一个', async () => {
    // `cliErrorCode` 对不在 `CLI_ERROR_CODES` 里的码一律折成 `AGENTMUX_FAILED`（agentmux.ts 的
    // 顶层 catch）。`AGENT_ROLE_DIRECTORY_UNREADABLE` 此前不在册，于是机读侧看到的码与「未知命令」
    // 完全一样——人读的 message 一直说的是真话，机读的码在撒谎。
    //
    // 判据钉的是**码**而不是 message：折叠只发生在码上，断言 message 会恒绿。两个世界要分得开，
    // 所以同时钉住 `AGENTMUX_FAILED` 这个具体的坏答案，而不是只问「码是不是它自己」——后者对
    // 「折成了别的某个码」也红，读起来却像同一条失败。
    const workspace = await mkdtemp(join(tmpdir(), 'agentmux-roles-unreadable-'))
    try {
      await mkdir(join(workspace, '.agents'), { recursive: true })
      await writeFile(join(workspace, '.agents', 'agentmux-roles.json'), '{ this is not json')
      const broken = await failIn(workspace, ['roles', 'list'])
      const reported = JSON.parse(broken.stderr).error
      expect(reported.code, `角色目录读不出来却报 ${reported.code}——与「命令打错了」同一个码`).toBe(
        'AGENT_ROLE_DIRECTORY_UNREADABLE'
      )
      expect(reported.code).not.toBe('AGENTMUX_FAILED')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('读不出来的 Session 存档报自己的码，不折成「命令打错了」那一个', async () => {
    // 与上一条同族，但它是**结构判据看不见**的那一半，所以必须有自己的行为判据。
    //
    // 那道扫描面只走「CLI 直接 import 的模块」加一层 client 的深二层，agent-session-store.ts 不在
    // 里面；它是经 `connect()` → `registry.load` → `store.load()` 进来的。结构判据当初还给这个码
    // 记过一条豁免，理由是「CLI 调不到写路径」——那条理由只数了写路径，而这条命令证明读路径同步就抛。
    //
    // 判据取 `version`：垃圾字节走的是另一条路（salvage + quarantine，只打 warning 不抛），真正抛
    // 的是 schema 对不上。所以这里必须写一个结构合法但版本不对的存档，写 'garbage' 是测不到的。
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-store-invalid-'))
    try {
      const store = join(directory, 'sessions.json')
      await writeFile(store, JSON.stringify({ version: 3, agentSessions: [] }))
      const broken = await fail(['inspect', '--session', 'any-probe'], {
        AGENTMUX_AGENT_SESSION_STORE: store
      })
      const reported = JSON.parse(broken.stdout || broken.stderr).error
      expect(reported.message, '这条命令没走到存档读取，判据测的不是它该测的东西').toContain(
        'Agent Session store is invalid.'
      )
      expect(reported.code, `存档读不出来却报 ${reported.code}——与「命令打错了」同一个码`).toBe(
        'INVALID_AGENT_SESSION_STORE'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('CLI 够得着的每一个码都在 CLI_ERROR_CODES 里——不在册的会被静默折成 AGENTMUX_FAILED', async () => {
    // 上面那条是行为判据，只盯住一个码。这条是结构判据，盯住**下一个**码。
    //
    // 形状：`cliErrorCode` 对不在册的值一律返回 `AGENTMUX_FAILED`（agentmux.ts 顶层 catch）。于是
    // "throw 一个新 AgentMuxError 却忘了把码加进 CLI_ERROR_CODES" 这件事**不产生任何编译错误、
    // 不产生任何测试失败**，只是机读侧永远看不到那个码。
    //
    // ## 扫描面为什么是「CLI 直接 import 的模块」而不是「agentmux.ts 一个文件」
    //
    // 这条判据最初只扫 agentmux.ts，而那样它**看不见自己要守的那个码**：
    // `AGENT_ROLE_DIRECTORY_UNREADABLE` 是 `agent-role-directory.ts` 抛的，agentmux.ts 里只有注册表
    // 那一处字面量。顶层 catch 不管是谁抛的——`roleCommand` 直接 await 那个函数，异常一路冒到
    // `main().then(…, …)`，照样过 `cliErrorCode`。所以判据的边界不是「哪个文件写的 throw」，
    // 而是「哪些 throw 到得了那个 catch」，这两者只在缺陷处分岔（本仓记过 derivation-source 那一族）。
    //
    // 取「CLI 直接 import 的 core 模块」这一层：它由 import 图派生、不是人手清单，且覆盖每一条
    // 命令实现真正调用的东西。深一层（client.ts 再 import 的那些）不扫——那些码经 daemon 往返，
    // 由 control 协议的码表负责，不走这条本地 catch。
    //
    // **`import type` 不算边**：它编译期就被抹掉，运行时一行代码都不会执行。初版把它算进来，于是
    // `agent-session-registry.ts` 的三个码被报成「够得着却没在册」——而 CLI 从那里只取了一个类型
    // （`AgentMuxAgentSessionLookup`）。一道要求给到不了的码上户口的守卫，本身就是缺陷。
    const src = new URL('../src/', import.meta.url)
    const cliSource = await readFile(new URL('agentmux.ts', src), 'utf8')

    const registry = /const CLI_ERROR_CODES = \[([\s\S]*?)\] as const/.exec(cliSource)
    expect(registry, 'CLI_ERROR_CODES 的声明没解析出来——判据看不见它的目标就必须红').not.toBeNull()
    // spread 进来的那些控制码在别处（control.ts）声明，这里只看本文件字面列出的。
    // 注释行先剥掉：这段注册表每个成员都带一段说明，说明里随手点名另一个码就会被算成「已在册」——
    // 那是**放松**的方向（漏报），而说明不是注册。
    //
    // 剥离与匹配必须是**同一个函数**，不能是「一个 helper + 调用处自己拼」：那样把调用处的
    // `withoutComments(...)` 去掉，helper 的自检照样绿，整个收紧静默失效（本仓刚为这同一形状连修两个
    // 提交——判据与它的接线是两处会坏的地方）。所以下面的自检喂的就是这个函数本身。
    const registryMembers = (body: string): string[] =>
      [...body.replace(/^[ \t]*\/\/[^\n]*$/gm, '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!)
    const registered = new Set(registryMembers(registry![1]!))

    // 每个 throw 取它实参里的大写串。**不能**用 `new AgentMuxError\(([\s\S]*?)\)`：非贪婪的 `\)`
    // 停在第一个右括号上，而 message 常是带调用的模板串（``…${file(workspacePath)}``），于是实参被
    // 截断在码之前——实测 agent-role-directory.ts 的三处 throw 因此一个都取不到。所以从 `(` 起
    // 数括号配平，取完整实参。
    const codesIn = (source: string): string[] => {
      const found: string[] = []
      for (const match of source.matchAll(/new AgentMuxError\(/g)) {
        let depth = 0
        let index = match.index + match[0].length - 1
        for (; index < source.length; index += 1) {
          if (source[index] === '(') depth += 1
          else if (source[index] === ')') { depth -= 1; if (depth === 0) break }
        }
        const args = source.slice(match.index, index)
        found.push(...[...args.matchAll(/'([A-Z][A-Z_]{3,})'/g)].map((code) => code[1]!))
      }
      // 上面那圈只看得见**字面量直接写在构造里**的码。control-host.ts 不是这么写的：`object` / `id` /
      // `identity` / `text` 各自把 `code: string` 当形参收下，再 `throw new AgentMuxError(message, code)`，
      // 于是真正的码只出现在调用点（`object(v, '…', 'INVALID_CONTROL_REQUEST')`），构造里一个大写字面量
      // 也没有。d035a948 的 message 写过「每一处调用点都是字面量」——那句话当时就是错的。
      //
      // 这些码今天恰好都在册（CONTROL_PROTOCOL_ERROR / INVALID_CONTROL_REQUEST），所以这不是在补一个
      // 活着的缺陷，是在补**看不见**：只要这个形状存在，下一个经它新增的码就是静默漏网。
      //
      // 收的是「转发型 helper 的调用点上的字面量」，不是整个文件的大写字面量：先试过后者，当场捞回
      // ENOENT / ECONNREFUSED / ECONNRESET / EPIPE —— 那是 errno 比较（`error.code === 'ENOENT'`），
      // 不是 AgentMux 码。判 helper 的两个条件缺一不可：形参里有 `code`，且函数体确实把它转发给
      // AgentMuxError。只满足前者的函数（拿 code 只为比较或透传别处）不该让它的调用点被当成 throw 点。
      const forwarders = [...source.matchAll(/function\s+(\w+)\s*\(([^)]*)\)[^{]*\{/g)]
        .filter((match) => /\bcode\b/.test(match[2]!))
        .filter((match) => {
          const body = source.slice(match.index + match[0].length)
          const end = body.search(/\n(?:export )?(?:async )?function /)
          return /new AgentMuxError\([^)]*,\s*code\s*\)/.test(end < 0 ? body : body.slice(0, end))
        })
        .map((match) => match[1]!)
      for (const name of forwarders) {
        // 形参默认值本身就是一个码（`text` 的 `code = 'INVALID_CONTROL_REQUEST'`），调用点不写也会抛它。
        for (const call of source.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
          let depth = 0
          let index = call.index + call[0].length - 1
          for (; index < source.length; index += 1) {
            if (source[index] === '(') depth += 1
            else if (source[index] === ')') { depth -= 1; if (depth === 0) break }
          }
          const args = source.slice(call.index, index)
          found.push(...[...args.matchAll(/'([A-Z][A-Z_]{3,})'/g)].map((code) => code[1]!))
        }
      }
      return found
    }

    // 只收值 import：`import type { … } from './x.js'` 与 `import { type A }` 都不产生运行时边。
    // 子句里**不许出现换行**（`[^\n]`）：本仓不写分号，用 `[\s\S]*?` 或 `[^;]*?` 都会一路吞过好几条
    // import，于是 `type` 关键字落在匹配开头之外、判不出来——实测把 agent-session-registry 那条
    // type-only import 算成了值边，它那三个到不了的码被报成缺陷。多行 import 由下面的自检兜住。
    const valueImports = (source: string): string[] =>
      [...source.matchAll(/^import\s+(type\s+)?([^\n]*?)\s*from '\.\/([a-z0-9-]+)\.js'/gm)]
        .filter((match) => {
          if (match[1]) return false
          const clause = match[2]!.trim()
          if (!clause.startsWith('{')) return true
          // 整段只有 `{ type A, type B }` 时同样没有值绑定。
          return clause.replace(/[{}]/g, '').split(',').some((binding) => {
            const name = binding.trim()
            return name !== '' && !name.startsWith('type ')
          })
        })
        .map((match) => match[3]!)

    const modules = ['agentmux', ...new Set(valueImports(cliSource))]
    // 深一层：`client` 的码经 daemon 往返、由控制码表定型，但它**进程内**调到的模块不是。CLI 拿到的是
    // 一个本地 `new AgentMuxClient`（connectLocalAgentMux），`client.resolveAgentSession` 转手就调
    // `registry.resolve` —— 那些 throw 一路冒到同一条顶层 catch，与 agent-role-directory 完全同形。
    //
    // 只扫 client 的**全部**深二层会捞进 60 多个码，绝大多数 CLI 根本调不到（hook server、prompt
    // submission、timeline……）。给到不了的码上户口是这道门自己记过的反面教材。所以取「CLI 真正
    // 调的那几个 client 方法所触达的模块」这一层，并由下面的断言证明这张表没有凭空写。
    const clientSource = await readFile(new URL('client.ts', src), 'utf8')
    const calledOnClient = new Set([...cliSource.matchAll(/\bclient\.([a-zA-Z]+)\(/g)].map((m) => m[1]!))
    const REACHED_THROUGH_CLIENT = ['agent-session-registry']
    for (const name of REACHED_THROUGH_CLIENT) if (!modules.includes(name)) modules.push(name)
    // 控制码经 spread 在册，但它们不在 CLI_ERROR_CODES 的字面量里，所以要单独放行。
    const { AGENTMUX_CONTROL_ERROR_CODES } = await import('../src/control.js')
    const control = new Set<string>(AGENTMUX_CONTROL_ERROR_CODES)
    const reachable = new Map<string, string>()
    for (const name of modules) {
      // client.ts 是 daemon 客户端：它的码经协议往返，不由本地 catch 定型。
      if (name === 'client') continue
      let source: string
      try { source = await readFile(new URL(`${name}.ts`, src), 'utf8') } catch { continue }
      for (const code of codesIn(source)) if (!reachable.has(code)) reachable.set(code, `${name}.ts`)
    }
    expect(reachable.size, 'CLI 的 import 面上一个 throw 都没解析出来——下面的循环是死代码').toBeGreaterThan(5)
    expect(
      [...reachable.keys()],
      '扫描面漏掉了 agent-role-directory.ts——这条判据当初正是因为看不见它而漏掉了自己要守的码'
    ).toContain('AGENT_ROLE_DIRECTORY_UNREADABLE')
    // 扫描面的完整性自检：单行 import 匹配看不见多行的 `import {\n … \n} from './x.js'`，而 CLI 正有
    // 这样一条（control.js）。漏掉一个模块是**静默**的——少扫等于少报，门只会更松。所以这里按
    // 「源码里出现过的相对 import 路径」核一遍差集，凡是漏掉的都要在此点名并说明为何不算。
    const everyRelativeImport = new Set(
      [...cliSource.matchAll(/from '\.\/([a-z0-9-]+)\.js'/g)].map((match) => match[1]!)
    )
    const TYPE_ONLY_OR_DELIBERATE: Record<string, string> = {
      // 这条豁免的**理由曾经是错的**，写的是「只取了一个类型，运行时没有这条边」。直接 import 确实
      // 只有一个类型，但 CLI 经 `client.resolveAgentSession` 进程内调到了这个模块的 throw——审计据此
      // 找出一个当时真活着的漏网码（UNKNOWN_AGENT_SESSION_BINDING，`inspect --run <不存在>` 当场复现，
      // 报 AGENTMUX_FAILED）。「没有直接边」与「到不了」是两件事，那次把前者当成了后者。
      //
      // 改成按 client 真正调到的那几个入口点名，下面 REACHED_THROUGH_CLIENT 把它们逐个扫进来。
      'agent-session-registry': 'reached-through-client',
      // daemon 客户端：它自己抛的码经协议往返，由 control 码表定型，不走本地 catch。它**进程内**调到的
      // 模块不在此列——那正是上面那条踩过的坑，由 REACHED_THROUGH_CLIENT 单独负责。
      client: 'protocol-owned',
      // 多行 import，单行匹配看不见。它只导出协议常量与类型，不 throw——下面这条断言钉住这一点。
      control: 'no-throw'
    }
    const missed = [...everyRelativeImport].filter(
      (name) => !modules.includes(name) && !(name in TYPE_ONLY_OR_DELIBERATE)
    )
    expect(
      missed.sort(),
      `这些模块 CLI import 了，却没进扫描面：${missed.join(', ')}。少扫是静默的——补进 modules，` +
        '或在 TYPE_ONLY_OR_DELIBERATE 里写明为什么它的码到不了这条 catch。'
    ).toEqual([])
    // `control` 被列为 no-throw，这条把那个理由钉住：它哪天开始 throw，豁免就不再成立。
    expect(
      codesIn(await readFile(new URL('control.ts', src), 'utf8')).filter((code) => !control.has(code)),
      'control.ts 开始抛控制码表以外的码了——它不能再算作 no-throw 豁免'
    ).toEqual([])
    // REACHED_THROUGH_CLIENT 也要自证。两头都查，因为这张表**两个方向都会烂**：
    //  1. client 还得是进程内建的。哪天 CLI 改成连 daemon，这些码就归控制码表管，这层扫描就该撤掉。
    //  2. client 还真的在调它。`registry.` 一个调用点都没有了，说明这条边没了，表该瘦。
    // 反过来「client 开始调新模块」这一侧**不设断言**：那会要求这张表跟着 client.ts 的每次改动走，
    // 而漏掉一个模块的后果是少报（门更松），不是误报。这条边界写在这里，免得读的人以为它守得住。
    expect(
      cliSource,
      'CLI 不再进程内建 client 了——REACHED_THROUGH_CLIENT 这层扫描的前提没了'
    ).toContain('connectLocalAgentMux')
    for (const name of REACHED_THROUGH_CLIENT) {
      expect(
        clientSource.includes(`this.registry.`),
        `client.ts 不再调 ${name} 了——这条深二层的边没了，把它从 REACHED_THROUGH_CLIENT 里删掉`
      ).toBe(true)
    }
    expect(calledOnClient.size, 'CLI 一个 client 方法都没调——深二层扫描的前提不成立').toBeGreaterThan(3)
    // 这条钉住审计找出来的那个真缺陷：它是 registry.resolve 抛的，经 client.resolveAgentSession 到达
    // 顶层 catch。深二层扫描撤掉的话，这条立刻红。
    expect(
      calledOnClient.has('resolveAgentSession'),
      'CLI 不再调 resolveAgentSession——registry 的那些码可能已经到不了了，重核这层扫描'
    ).toBe(true)
    expect(
      [...reachable.keys()],
      '扫描面漏掉了 agent-session-registry.ts——审计正是在这里找出一个活着的漏网码'
    ).toContain('UNKNOWN_AGENT_SESSION_BINDING')

    // 模块粒度会多报：一个模块里可能有 CLI 根本不调的导出。逐个点名，并给出**可核验**的理由——
    // 理由不是注释，是下面那条反向断言真的去查一遍。
    const UNREACHABLE_WITHIN_MODULE: Record<string, { symbol: string; why: string }> = {
      // `connectSshAgentMux` 抛的。CLI 只调 `connectLocalAgentMux`（agentmux.ts 两处），远端那条
      // 目前唯一的调用方是 desktop 主进程（runtime-controller.ts）。给一个到不了的码上户口，
      // 等于在注册表里留一条永远不会出现的答案。
      REMOTE_UNSUPPORTED: { symbol: 'connectSshAgentMux', why: 'CLI 只用 connectLocalAgentMux' },
      // `INVALID_AGENT_SESSION_STORE` 曾经也在这张表里，理由写的是「CLI 调不到写路径；connect 链上
      // 那一处是 void 浮 promise」。那条理由被一条真命令证伪了：把 store 的 `version` 改掉再跑
      // `agentmux inspect --session x`，它当场就抛——**读**路径（connect → registry.load →
      // store.load）同步抛，跟写路径那处浮 promise 毫无关系。只数了一个方向的调用点，就把「我没找到」
      // 写成了「到不了」。它现在在 CLI_ERROR_CODES 里。
      //
      // 下面这个来自 agent-session-registry.ts，是深二层扫描按**模块**粒度捞进来的多报。CLI 只调
      // `client.resolveAgentSession / agentSession / agentSessions`，它们落到 registry 的
      // `resolve / get / list` 三个入口；这个码由 `retiredAgentSession` 抛，而 client 里调它的是
      // resumeAgent，不在 CLI 的调用面上。
      AGENT_SESSION_IDENTITY_CONFLICT: {
        symbol: 'retiredAgentSession',
        why: '只有 resumeAgent 调它，CLI 不调 resumeAgent'
      }
    }
    const orphans = [...reachable].filter(
      ([code]) => !registered.has(code) && !control.has(code) && !(code in UNREACHABLE_WITHIN_MODULE)
    )
    expect(
      orphans.map(([code, where]) => `${code} (${where})`).sort(),
      '这些码 CLI 够得着，却不在 CLI_ERROR_CODES 里。cliErrorCode 会把它们折成 AGENTMUX_FAILED——' +
        '与「命令打错了」同一个码，机读侧分不出。加进 CLI_ERROR_CODES，或确认它们真的不该有自己的码。'
    ).toEqual([])

    // 豁免清单必须自己证明自己还成立——本仓反复吃过「人手豁免清单会漏、会过期」的亏。两个方向都查：
    //  1. 名下那个符号还在、且 CLI 确实没有调它。它哪天被 CLI 调用了，豁免当场失效。
    //  2. 这个码确实还被抛着。码被删掉或改名后，一条过期的豁免会静静地替下一个同名码背书。
    // 符号可能是顶层函数（connectSshAgentMux）也可能是类方法（update / retiredAgentSession），所以
    // 只要求「声明得出来」，不钉 `export async function` 那一种写法——钉死一种拼法就等于给另一种放行。
    for (const [code, { symbol }] of Object.entries(UNREACHABLE_WITHIN_MODULE)) {
      expect(reachable.has(code), `${code} 已经不在扫描面里了——这条豁免过期了，删掉它`).toBe(true)
      const owner = await readFile(new URL(reachable.get(code)!, src), 'utf8')
      expect(
        new RegExp(`^(export (async )?function |  (async )?)${symbol}[(<]`, 'm').test(owner),
        `${symbol} 不在 ${reachable.get(code)} 里了——豁免点名的符号已经不存在`
      ).toBe(true)
      expect(
        cliSource.includes(`${symbol}(`),
        `CLI 现在调用了 ${symbol}，${code} 到得了顶层 catch——豁免不再成立，把它加进 CLI_ERROR_CODES`
      ).toBe(false)
    }
    // 自检：两个解析都不许在空集上恒绿，且判据真的认得出「抛了但没在册」。
    expect(registered.has('AGENTMUX_FAILED'), '注册表解析漏了已知成员').toBe(true)
    // 注册表解析的方向性：注释里写出来的码**不算**在册。这条钉住的是「漏报是静默的」那一侧——
    // 本文件的注册表每个成员都带一段说明，说明里点名别的码是常事，而说明不是注册。
    expect(
      registryMembers("  'REAL_MEMBER',\n  // 与 'COMMENTED_CODE' 是相反的两件事\n"),
      '注释里的码被算成了在册——于是一个真的没在册的码会被这段说明背书'
    ).toEqual(['REAL_MEMBER'])
    expect(reachable.has('MAINTAINER_TARGET_UNRESOLVED'), 'throw 解析漏了 agentmux.ts 里已知的那一处').toBe(true)
    // message 里带逗号 + 大写词：靠「紧跟第一个逗号」取码的写法会在这里取错。
    expect(
      codesIn("throw new AgentMuxError('Tab, region, or NONE matched.', 'REAL_CODE_HERE')"),
      '判据被 message 里的逗号骗过，取到的不是真正的码'
    ).toContain('REAL_CODE_HERE')
    // message 是带调用的模板串：非贪婪 `\)` 会停在 `file(x)` 的右括号上，码被截在实参之外。
    // 这正是本判据初版在 agent-role-directory.ts 上实测取空的那种形状。
    expect(
      codesIn('throw new AgentMuxError(`bad: ${file(path)}`, \'TEMPLATE_CALL_CODE\')'),
      '判据被 message 模板串里的括号截断，取不到码'
    ).toContain('TEMPLATE_CALL_CODE')
    expect(codesIn("new AgentMuxError('probe', 'NEVER_REGISTERED')"), '判据认不出一处普通的 throw').toEqual([
      'NEVER_REGISTERED'
    ])
    // import 形状的自检：值 import 要收，两种 type-only 写法都不许收（否则 agent-session-registry
    // 那三个到不了的码会被报成缺陷，这道门就成了让人给死码上户口的噪音）。
    expect(valueImports("import { requestAgentMuxControl } from './control-host.js'")).toEqual(['control-host'])
    expect(valueImports("import type { AgentMuxAgentSessionLookup } from './agent-session-registry.js'")).toEqual([])
    expect(valueImports("import { type SplitDirection } from './split-direction-ssot.js'")).toEqual([])
    expect(
      valueImports("import { SPLIT_FLAG_DIRECTIONS, type SplitDirection } from './split-direction-ssot.js'"),
      '混合 import 里有值绑定，仍然是一条运行时边'
    ).toEqual(['split-direction-ssot'])
  })

  it('deletes old command trees and requires managed identity for self', async () => {
    const unmanaged = await fail(['inspect', '--tab', 'self'], { AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' })
    expect(JSON.parse(unmanaged.stderr)).toMatchObject({ error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
    for (const old of [['context'], ['launch'], ['session', 'list'], ['region', 'focus']]) {
      const retired = await fail(old)
      expect(JSON.parse(retired.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    }
  })

  it('accepts inline typed flag values and keeps self reserved for selector syntax', async () => {
    const unmanaged = await fail(['inspect', '--tab=self'], { AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' })
    expect(JSON.parse(unmanaged.stderr)).toMatchObject({ error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
    const exactOnly = await fail(['focus', '--tab=self'])
    expect(JSON.parse(exactOnly.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    const inlineDashId = await fail(['focus', '--tab=--prefixed-tab'])
    expect(['CONTROL_UNAVAILABLE', 'TAB_NOT_OPEN', 'CONTROL_FAILED']).toContain(JSON.parse(inlineDashId.stderr).error?.code)
  })

  it('rejects missing and unrelated native identity companion flags', async () => {
    for (const args of [
      ['inspect', '--provider-native', 'native-id'],
      ['inspect', '--session', 'session-id', '--provider', 'codex'],
      ['inspect', '--acp-native', 'native-id'],
      ['inspect', '--run', 'run-id', '--adapter', 'acp']
    ]) {
      const failure = await fail(args)
      expect(JSON.parse(failure.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    }
  })

  // doctor 报告里的 endpoint 目录占用与回收结果，若没有一个用户真能敲出来的入口，就等于算了没人看
  // ——占用只能等磁盘告警才发现，回收失败完全无声。这条证明命令真的被 main() 分发到了：跑不通运行时
  // 会得到 typed 失败（本机没有 Desktop Host 时的正常结果），而**未注册**的命令得到的是
  // INVALID_CLI_ARGUMENT + "Unknown command"。两者可区分，所以这条不会因为环境没跑 Host 而假绿。
  it('dispatches doctor as a real command, not an unknown one', async () => {
    const help = await run(['--help'])
    expect(help).toContain('doctor')

    let payload: { ok?: boolean; error?: { code?: string; message?: string } }
    try {
      payload = JSON.parse(await run(['doctor']))
    } catch (error) {
      payload = JSON.parse((error as { stdout: string; stderr: string }).stderr)
    }
    expect(payload.error?.message ?? '').not.toContain('Unknown command')
    expect(payload.error?.code).not.toBe('INVALID_CLI_ARGUMENT')

    // 参数校验也证明分发到位：未注册的命令根本走不到这句错误。
    const extra = await fail(['doctor', 'extra'])
    expect(JSON.parse(extra.stderr)).toMatchObject({
      error: { code: 'INVALID_CLI_ARGUMENT', message: 'doctor takes no arguments.' }
    })
  })

  // 版本号只有一个真相：package.json 的 `version`。CLI 的 `--version` 必须**报告**这个字段，而不是
  // 另存一份字面量。所以这里不写死 `0.1.0`——那正是被删掉的旧写法（bump 包版本就把测试无辜打红，
  // 忘了同步源码常量又什么都不红）。
  //
  // 断言分成两条，因为它们各挡一种变异，缺一不可：
  //   1)「关系」条：`--version` 的输出 == `agentmux ${package.json.version}\n`。这挡住"改错字面量/
  //      改错格式"。但它单独**挡不住**最阴的那种回归——把源码改回硬编码**当前**的 `0.1.0`：那时
  //      两边恰好相等，关系条恒真。注意 expected 端从磁盘上的 package.json 读出，与被测实现**各读各的**，
  //      不是"两边同一个表达式算出来"的空转。
  //   2)「派生」条：把 CLI 连同一个改过 version 的 package.json 一起搬到别处运行，输出必须**跟着**那个
  //      哨兵值走。这钉死"值是运行时从 package.json 派生的"，而不是编译进二进制的常量——正是第 1 条
  //      放过的那种变异。sentinel 用 randomUUID，绝不可能等于任何真实发布过的版本。
  it('reports the version declared in package.json, not a hard-coded copy', async () => {
    const declaredVersion = JSON.parse(await readFile(packageManifestUrl, 'utf8')).version as string
    expect(typeof declaredVersion).toBe('string')
    expect(declaredVersion.length).toBeGreaterThan(0)
    expect(await run(['--version'])).toBe(`agentmux ${declaredVersion}\n`)
    // `-V` 是 `--help` 里承诺的等价别名（"--version, -V  Print version and exit."）。它与 `--version`
    // 共用同一个分支，所以只测长名的话，把 `|| args[0] === '-V'` 删掉会让 `-V` 静默回退到
    // INVALID_CLI_ARGUMENT 而测试全绿。这条把承诺的等价关系钉住——两个入口必须给出同一个输出。
    expect(await run(['-V'])).toBe(`agentmux ${declaredVersion}\n`)
  })

  it('derives --version from package.json at runtime (relocated CLI follows a sentinel version)', async () => {
    const packageRoot = fileURLToPath(new URL('../', import.meta.url))
    const stage = await mkdtemp(join(tmpdir(), 'agentmux-version-derivation-'))
    try {
      // dist 必须是真实副本：Node 解析 `../package.json` 用的是 dist 文件的**真实**位置，符号链接会被
      // 解回原包根，于是读到真 version（实测 `--preserve-symlinks` 也一样解回），哨兵就不可观测了。
      // node_modules 只是补齐 import 图，软链无妨。
      await cp(join(packageRoot, 'dist'), join(stage, 'dist'), { recursive: true })
      await symlink(join(packageRoot, 'node_modules'), join(stage, 'node_modules'))
      const manifest = JSON.parse(await readFile(packageManifestUrl, 'utf8'))
      const sentinel = `0.0.0-version-ssot-${randomUUID()}`
      expect(sentinel).not.toBe(manifest.version)
      manifest.version = sentinel
      await writeFile(join(stage, 'package.json'), JSON.stringify(manifest))
      const relocated = await execFileAsync(
        process.execPath,
        [join(stage, 'dist', 'agentmux.js'), '--version'],
        { timeout: 10_000, maxBuffer: 512 * 1024 }
      )
      expect(relocated.stdout).toBe(`agentmux ${sentinel}\n`)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  })

  // T-004 验收 #1：whoami 进入既有的 verb 注册、help 与分发，不另起一套。这些断言区分"真的分发到了
  // whoamiCommand"与"落进了 Unknown command 兜底"——两者可区分，所以不会因为本机没跑 Desktop Host
  // 而假绿（未注册命令得到的是 INVALID_CLI_ARGUMENT + "Unknown command"）。
  it('lists whoami in --help and resolves whoami --help through the shared registry', async () => {
    const help = await run(['--help'])
    expect(help).toContain('whoami')
    // whoami --help 走的是与其它 verb 同一个 agentMuxCommandHelp 注册表，不另写一套。
    const whoamiHelp = await run(['whoami', '--help'])
    expect(whoamiHelp).toContain('agentmux whoami')
    // 语法的唯一真相在 skill：per-verb help 说明 Topic 为何不由 verb 产出、指向文件。
    expect(whoamiHelp).toContain('topic.md')
  })

  it('documents whoami in --skill as the startup orientation step, not a second dispatch', async () => {
    const skill = await run(['--skill'])
    expect(skill).toContain('agentmux whoami')
    // skill 是确切用法的唯一真相——whoami 的坐标各项在这里被点到。
    expect(skill).toContain('Session')
    expect(skill).toContain('capabilities')
  })

  it('dispatches whoami as a real command that requires a managed caller, not an unknown one', async () => {
    // 无 managed 身份时 whoami 必须走到 MANAGED_AGENT_CONTEXT_REQUIRED——证明它被分发到了
    // whoamiCommand（managedCaller() 在那里抛），而不是落进 Unknown command 兜底。
    const unmanaged = await fail(['whoami'], { AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' })
    const payload = JSON.parse(unmanaged.stderr)
    expect(payload).toMatchObject({ error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
    expect(payload.error.message).not.toContain('Unknown command')
    // 参数校验也证明分发到位：whoami 无参，多给一个会走到它自己的校验错误，而非 Unknown command。
    const extra = await fail(['whoami', 'extra'], { AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: 'agent-self' })
    expect(JSON.parse(extra.stderr)).toMatchObject({
      error: { code: 'INVALID_CLI_ARGUMENT', message: 'whoami takes no arguments.' }
    })
  })

  // T-005 验收 #1/#5：handoff 进入既有 verb 注册/help/skill 与分发，不另起一套；失败沿用 typed 错误。
  // 这个文件经 bin/agentmux 走 dist——删掉 src 里的 handoff 分发再 build，下面「真被分发」那条会红
  // （落回 Unknown command）。这正是 gate agent-handoff.test.ts（只测纯函数）守不住的那一侧。
  it('lists handoff in --help and resolves handoff --help through the shared registry', async () => {
    const help = await run(['--help'])
    expect(help).toContain('handoff')
    const handoffHelp = await run(['handoff', '--help'])
    expect(handoffHelp).toContain('agentmux handoff --to-session')
    // help 说清边界：只转移所有权，不投递消息（呼应验收 #2/#3）。
    expect(handoffHelp).toContain('--task <task-id>')
    expect(handoffHelp).toContain('originAwaits')
  })

  it('documents handoff in --skill as ownership transfer, not a message', async () => {
    const skill = await run(['--skill'])
    expect(skill).toContain('agentmux handoff --to-session')
    expect(skill).toContain('--task <task-id>')
    // skill 明说不要用 send 措辞模拟交接——所有权转移是 Core 事实。
    expect(skill).toContain('ownership')
  })

  it('dispatches handoff as a real command requiring managed identity, not an unknown one', async () => {
    // 无 managed 身份时 handoff 必须走到 MANAGED_AGENT_CONTEXT_REQUIRED——证明它分发到了
    // handoffCommand（managedCaller() 在那里抛），而不是落进 Unknown command 兜底。删掉 src 的分发
    // 行、重建 dist，这条会翻成 INVALID_CLI_ARGUMENT + "Unknown command"。
    const unmanaged = await fail(['handoff', '--to-session', 'agent-b', '--task', 't-1'], { AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' })
    const payload = JSON.parse(unmanaged.stderr)
    expect(payload).toMatchObject({ error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
    expect(payload.error.message).not.toContain('Unknown command')
  })

  // T-004 验收 #1：promote 进入既有 verb 注册/help/skill 与分发，不另起一套；失败沿用 typed 错误。
  // 这个文件经 bin/agentmux 走 dist——删掉 src 里的 promote 分发再 build，「真被分发」那条会红
  // （落回 Unknown command）。这正是只测 store/纯函数守不住的那一侧。
  it('lists promote in --help and resolves promote --help through the shared registry', async () => {
    const help = await run(['--help'])
    expect(help).toContain('promote')
    const promoteHelp = await run(['promote', '--help'])
    expect(promoteHelp).toContain('agentmux promote --region')
    // help 说清边界：促升不碰 Run（呼应「移动不调用 Runtime lifecycle」验收）。
    expect(promoteHelp).toContain('never starts, stops, or restarts')
  })

  it('dispatches promote as a real command requiring managed identity for self, not an unknown one', async () => {
    // 无 managed 身份时 promote --region self 必须走到 MANAGED_AGENT_CONTEXT_REQUIRED——证明它被分发到了
    // promoteCommand（callerForSelf→managedCaller() 在那里抛），而不是落进 Unknown command 兜底。删掉 src 的
    // 分发行、重建 dist，这条会翻成 INVALID_CLI_ARGUMENT + "Unknown command"。
    const unmanaged = await fail(['promote', '--region', 'self'], { AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' })
    const payload = JSON.parse(unmanaged.stderr)
    expect(payload).toMatchObject({ error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
    expect(payload.error.message).not.toContain('Unknown command')
    // 缺选择器：typed INVALID_CLI_ARGUMENT，不静默、不 Unknown command。
    const noRegion = await fail(['promote'])
    expect(JSON.parse(noRegion.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
  })

  it('handoff fails closed on missing target/task and rejects self as a target', async () => {
    const managed = { AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: 'agent-self', AGENTMUX_AGENT_CAPABILITY: 'cap-x' }
    // 缺目标：typed INVALID_CLI_ARGUMENT，不静默。
    const noTarget = await fail(['handoff', '--task', 't-1'], managed)
    expect(JSON.parse(noTarget.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    // 缺 task：同样 typed 失败。
    const noTask = await fail(['handoff', '--to-session', 'agent-b'], managed)
    expect(JSON.parse(noTask.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    // 交给"自己"没有意义——self 是保留选择器，目标必须是显式 id。
    const selfTarget = await fail(['handoff', '--to-session', 'self', '--task', 't-1'], managed)
    expect(JSON.parse(selfTarget.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
  })
})

// T-009：`browser` 是与 `open` 同级的顶层动词。`open browser` 开一个浏览器，`browser run` 驱动一个
// 已经开着的——两件事两个命令，互不取代。下面每条都能区分"真的分发到了 browserCommand"与"落进了
// Unknown command 兜底"，所以不会因为本机没跑 Desktop Host 而假绿。
describe('agentmux browser 顶层动词', () => {
  it('browser 在主帮助里列得出来，且说清它不是 open browser', async () => {
    const help = await run(['--help'])
    expect(help, 'browser 不在主帮助里，Agent 不会知道它存在').toMatch(
      /browser\s+Drive an already-open Browser/
    )
    const verb = await run(['browser', '--help'])
    expect(verb, 'browser --help 没讲它和 open browser 的分工').toContain('neither replaces the other')
    expect(verb, 'browser --help 没有回放模式').toContain('--preview')
  })

  // 一级 usage 表必须覆盖**实现真的接的每一个子命令**，判据从 `browserCommand` 的 dispatch 反推，
  // 不维护一份手写清单。此前这里是逐个手点 `history`/`replay` 两条——而 `follow` 加进实现时
  // 没人提醒它没进表，敲 `agentmux browser --help` 的人看不到它存在（实测漏了一轮）。
  // 手写清单必漏，漏的时候它自己不会响：这条改成从来源反推就是为了这个。
  it('一级 usage 表覆盖实现接的每一个子命令', async () => {
    const source = await readFile(new URL('../src/agentmux.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function browserCommand')
    expect(start, 'browserCommand 起锚点不在场——切出来会是空串，下面每条断言都会恒真').toBeGreaterThan(-1)
    const end = source.indexOf('async function readAllStdin', start)
    expect(end, 'browserCommand 收尾锚点不在场').toBeGreaterThan(start)
    const body = source.slice(start, end)

    const dispatched = [...body.matchAll(/args\[0\] === '([a-z-]+)'/g)].map((m) => m[1]!)
    // 兜底那条 `if (args[0] !== 'run') throw` 是 run 的分发形态，正则抓不到，单独认一次。
    expect(body, 'run 的兜底分发形态变了，下面这条补充就失效了').toContain("args[0] !== 'run'")
    const subcommands = [...new Set([...dispatched, 'run'])]
    expect(subcommands.length, '一个子命令都没抠到＝正则漂了，空集合上每条断言都恒真').toBeGreaterThan(4)

    const verb = await run(['browser', '--help'])
    const usage = verb.slice(verb.indexOf('Usage:'), verb.indexOf('`open browser` opens one'))
    expect(usage.length, 'usage 段抠成空串了').toBeGreaterThan(0)
    const missing = subcommands.filter((name) => !usage.includes(`agentmux browser ${name}`))
    expect(missing, `实现接了这些子命令但一级 usage 表没列：${missing.join(', ')}——敲 browser --help 的人看不到它们存在`).toEqual([])
  })

  // 每个子命令还要有自己那条 topic：一级表列了名字但 `browser X --help` 拿到的是讲别的命令的
  // 那一份，等于没有帮助（见下一条 run 的回归）。
  it('每个子命令都有自己的 help topic', async () => {
    const source = await readFile(new URL('../src/agentmux.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function browserCommand')
    const end = source.indexOf('async function readAllStdin', start)
    const body = source.slice(start, end)
    const subcommands = [...new Set([
      ...[...body.matchAll(/args\[0\] === '([a-z-]+)'/g)].map((m) => m[1]!), 'run'
    ])]
    expect(subcommands.length, '空集合上 for 循环什么都不证明').toBeGreaterThan(4)
    for (const name of subcommands) {
      const topic = agentMuxCommandHelp(`browser.${name}`)
      expect(topic, `browser ${name} 没有自己的 help topic`).toBeTruthy()
      expect(topic!.length, `browser ${name} 的 topic 是空的`).toBeGreaterThan(80)
    }
  })

  // operationPath 此前只对 `open` 做两级拼接。没有这条，把 browser 那一枝删掉后
  // `browser run --help` 会静默落到 'browser' 那条上——拿到一份讲别的命令的帮助，而不是报错。
  it('browser run --help 解析到自己那条，不是退回 browser 那条', async () => {
    const sub = await run(['browser', 'run', '--help'])
    expect(sub, 'browser run --help 落到了 browser 那条').toContain('Run a program in an open Browser')
    expect(sub, 'help 没说程序从 stdin 整份读，Agent 会去找 --code').toContain('read from stdin')
    // 四类结局里 indeterminate 最要紧：它意味着"别盲目重试"。help 里不写，等于没有这一类。
    expect(sub, 'help 没讲 indeterminate，Agent 会把它当普通失败重试').toContain('indeterminate')
    expect(sub, 'help 没讲授权开关在哪').toContain('Settings › Browser')
  })

  it('缺 --browser、self 与空程序都 typed 失败，而合法调用不再是参数错误', async () => {
    // 全程指向一个空运行时目录：本机常跑着真的 AgentMux.app，一旦某条断言下的实现变成"去连"，
    // 它会等满 long 预算的 60s 才红（见 cli-help-timeout-flake-is-the-live-app）。空目录让它立刻
    // CONTROL_UNAVAILABLE——变异该红的时候快速地红，而不是看起来像卡住。
    const offline = await mkdtemp(join(tmpdir(), 'agentmux-browser-run-offline-'))
    const env = { AGENTMUX_RUNTIME_DIRECTORY: offline }
    try {
      // 缺 --browser：typed INVALID_CLI_ARGUMENT，且不是 Unknown command——这一对区分证明它被分发到了
      // browserCommand。删掉 main() 里那行分发、重建 dist，这条会翻成含 "Unknown command" 的同码错误。
      const noBrowser = await runWithStdin(['browser', 'run'], 'return 1', env)
      const noBrowserError = JSON.parse(noBrowser.stderr)
      expect(noBrowserError, `stderr=${noBrowser.stderr}`).toMatchObject({
        error: { code: 'INVALID_CLI_ARGUMENT' }, operation: 'browser.run'
      })
      expect(noBrowserError.error.message, '落进了 Unknown command 兜底——分发没接上').not.toContain(
        'Unknown command'
      )

      // self 是保留选择器，指的是调用方自己这个 Agent Session；没有哪个 Browser 叫 self。放过去的话
      // 它会被当成一个字面 id 发给 Host，错法变成"找不到这个 browser"，把参数错误伪装成环境问题。
      const selfTarget = await runWithStdin(['browser', 'run', '--browser', 'self'], 'return 1', env)
      expect(JSON.parse(selfTarget.stderr), `stderr=${selfTarget.stderr}`).toMatchObject({
        error: { code: 'INVALID_CLI_ARGUMENT' }
      })

      // 空程序（最常见成因：忘了接管道）必须被拒。放过去的话，回执是一份"跑完了，什么都没发生"的成功，
      // 与真的跑完一段空程序在回执上无法区分。空白不算内容，所以判的是 trim 后。
      //
      // **码是 INVALID_CONTROL_REQUEST 而不是 INVALID_CLI_ARGUMENT，这正是 T-002 要证的那件事**：
      // 规则住在协议层，CLI 只是经过它的一条路。这个码等于一张收据——CLI 拿到的拒绝来自协议解析，
      // 而不是它自己又判了一遍。若 CLI 悄悄把这条规则抄回去，码会翻回 INVALID_CLI_ARGUMENT，这条会红。
      //
      // 判在**子进程真跑一遍 CLI** 上，不是直接调 parse：那才能证明这条路上没有别的东西先把它拦掉。
      // 协议层那句拒绝被删掉之后，这条必须红——它今天不再有 CLI 侧的第二道闸兜着。
      const empty = await runWithStdin(['browser', 'run', '--browser', 'browser-1'], '   \n', env)
      const emptyError = JSON.parse(empty.stderr)
      expect(emptyError, `stderr=${empty.stderr}`).toMatchObject({
        error: { code: 'INVALID_CONTROL_REQUEST' }, operation: 'browser.run'
      })
      expect(emptyError.error.message, '拒绝空程序时没告诉人怎么喂程序').toContain('Pipe it in')
      // 没连上运行时也要拒：证明它在**连接之前**就被判掉了。若拒绝发生在 Host 那一侧，这个空目录
      // 环境会先给 CONTROL_UNAVAILABLE——那就说明每个客户端都得先能连上才拿得到这条规则。
      expect(emptyError.error.code, '空程序是连上运行时之后才被拒的——规则没在请求解析层')
        .not.toBe('CONTROL_UNAVAILABLE')

      // 非法 step 同样只有协议那一个码。此前 CLI 用正则先判、拿 INVALID_CLI_ARGUMENT 拒掉，
      // 于是同一个非法输入经 CLI 与经协议得到两个码。两种形态各判一次：CLI 的正则只拦非数字与 0，
      // 小数 `1.5` 它其实放过（`/^\d+$/` 不匹配小数点，所以也拒）——重点是**码必须一致**。
      for (const bad of ['0', '-1', '1.5', 'two']) {
        const badStep = await runWithStdin(
          ['browser', 'replay', '--browser', 'browser-1', '--operation', 'op-1', '--step', bad], '', env
        )
        expect(JSON.parse(badStep.stderr), `--step ${bad} 的拒绝码与协议不一致：${badStep.stderr}`)
          .toMatchObject({ error: { code: 'INVALID_CONTROL_REQUEST' }, operation: 'browser.replay' })
      }
      // 反向的一半：合法 step 不再是参数错误，否则一个"--step 永远被拒"的实现也能让上面全绿。
      const goodStep = await runWithStdin(
        ['browser', 'replay', '--browser', 'browser-1', '--operation', 'op-1', '--step', '2'], '', env
      )
      expect(JSON.parse(goodStep.stderr), `合法 step 被判成非法：${goodStep.stderr}`)
        .toMatchObject({ error: { code: 'CONTROL_UNAVAILABLE' } })

      // 反向的那一半：给了 --browser 和一段真程序，就**不再**是参数错误。没有这一条，一个"browser run
      // 永远报参数错误"的实现，或者一个根本不读 stdin 的实现，都能让上面三条全绿。
      const real = await runWithStdin(
        ['browser', 'run', '--browser', 'browser-1'], 'return await snapshot()', env
      )
      expect(real.code, '带着合法参数却挂住了——stdin 没读到底').not.toBeNull()
      expect(JSON.parse(real.stderr), `合法请求仍被判成参数错误：${real.stderr}`).toMatchObject({
        operation: 'browser.run', error: { code: 'CONTROL_UNAVAILABLE' }
      })
    } finally {
      await rm(offline, { recursive: true, force: true })
    }
  }, 60_000)

  // `open browser` 不迁移、不加过时标记：AGENTMUX.md 原则 1 的反面用法是"给旧命令挂个 deprecated
  // 说改用新的"——这里两个命令做的根本不是同一件事，不存在谁取代谁。
  it('open browser 原样还在，没有被标成过时', async () => {
    const openHelp = await run(['open', 'browser', '--help'])
    expect(openHelp).toContain('agentmux open browser --url <url>')
    expect(openHelp, 'open browser 被标成了过时——它不该被 browser run 取代').not.toMatch(
      /deprecated|use .browser run/i
    )
  })

  // skill 是 Agent 的唯一用法真相。这里钉三件它不知道就用不起来的事：命令本身、按 ref 不按坐标、
  // 以及那句禁令的边界——禁的是"用键鼠模拟投递 payload"，不是"驱动页面"。措辞含糊的话，Agent 会读成
  // "browser run 也在禁令内"，于是有这个动词也不用。
  it('skill 教 browser run，且投递禁令没有把驱动页面一起禁掉', async () => {
    const skill = await run(['--skill'])
    expect(skill, 'skill 没教 browser run，Agent 不会用它').toContain(
      'agentmux browser run --browser <browser-id> < program.js'
    )
    expect(skill, 'skill 没讲"按 ref 不按坐标"——这是整个方案的核心约束').toContain('Never coordinates')
    expect(skill, 'skill 没说授权开关，Agent 撞到拒绝时不知道怎么办').toContain('Settings › Browser')
    expect(skill, 'skill 没讲 indeterminate 要先看页面再动').toMatch(/indeterminate[\s\S]*do not blind-retry/)
    expect(skill, '投递禁令仍然笼统，会把 browser run 一起吓退').toContain(
      'This is about how the payload is delivered, not about driving the page afterwards'
    )
  })

  /**
   * 每一个真实存在的 browser 子命令都要有自己那条 --help。
   *
   * `operationPath` 把 `browser <verb>` 拼成 `browser.<verb>`，HELP 表里没有这一条时**不是**退回
   * 上一级，而是一句 "Unknown command. Run agentmux --help."——一个真实存在、真能跑的命令被 --help
   * 说成不存在。实测这曾是 `history` 与 `replay` 的状态。
   *
   * 子命令清单**从分发器反推**，不手写：手写清单会和源码一起漂，而漂的时候它自己不会响（加一个
   * 子命令忘了加 help，清单里也没有它，判据照旧全绿）。
   */
  it('每个 browser 子命令都有自己那条 --help，不会被说成不存在', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/agentmux.ts', import.meta.url)), 'utf8')
    // 取 browserCommand 那个函数体，再从里面捞 `args[0] === 'x'` 与 `args[0] !== 'x'`（最后那条
    // run 走的是 `!==` 兜底）。两端都判一次：起锚点不在了 indexOf 给 -1，slice 会切出**空串**，
    // 之后每一条断言恒真（MEMORY：indexOf 锚点没了就切出空串）。
    const start = source.indexOf('async function browserCommand')
    expect(start, 'browserCommand 不在源码里了——这条判据失去靶子').toBeGreaterThan(-1)
    const end = source.indexOf('\nasync function readAllStdin', start)
    expect(end, 'browserCommand 的结束锚点不在了').toBeGreaterThan(start)
    const body = source.slice(start, end)
    const verbs = [...body.matchAll(/args\[0\] [!=]==? '([a-z]+)'/g)].map((match) => match[1]!)
    // 前提自检：真的捞到了子命令。捞空的话下面的循环一次都不跑，而"零个子命令全都有 help"恒真。
    expect(verbs.length, '一个子命令都没捞到——下面的循环是死代码').toBeGreaterThan(3)
    expect(verbs, 'run 没被捞到（它走 !== 兜底那条）').toContain('run')

    for (const verb of verbs) {
      const help = await run(['browser', verb, '--help'])
      expect(help, `browser ${verb} 真能跑，但 --help 说它不存在`).not.toContain('Unknown command')
      // 而且拿到的是**自己**那条，不是碰巧落到了别人的 help 上。每条 help 的 Usage 里都必须
      // 出现这个子命令本身。
      expect(help, `browser ${verb} --help 拿到的是别的命令的帮助`).toContain(`agentmux browser ${verb} `)
    }
  })
})
