import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
const packageManifestUrl = new URL('../package.json', import.meta.url)
async function run(args: readonly string[]): Promise<string> {
  return (await execFileAsync(cli, args, { timeout: 5_000, maxBuffer: 512 * 1024 })).stdout
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

  it('CLI 抛出的每一个码都在 CLI_ERROR_CODES 里——不在册的会被静默折成 AGENTMUX_FAILED', async () => {
    // 上面那条是行为判据，只盯住一个码。这条是结构判据，盯住**下一个**码。
    //
    // 形状：`cliErrorCode` 对不在册的值一律返回 `AGENTMUX_FAILED`（agentmux.ts 顶层 catch）。于是
    // "在 agentmux.ts 里 throw 一个新 AgentMuxError 却忘了把码加进 CLI_ERROR_CODES" 这件事
    // **不产生任何编译错误、不产生任何测试失败**，只是机读侧永远看不到那个码。本仓记过这一族：
    // 声明与消费两份清单各自漂移，而漂移的一侧是沉默的那侧。
    //
    // 判据只扫 `agentmux.ts` 自己 throw 的字面量码，不扫整个 src/：从别处冒上来的码（control 那 39 个
    // 经 spread 已在册；core 内部还有 70 余个码走 daemon/IPC 而不经这个 CLI 顶层 catch）不归这条管。
    // 把判据放大到全仓会得到一张必须人手维护的豁免清单，而那种清单会漏——这正是本仓反复吃过的亏。
    const source = await readFile(new URL('../src/agentmux.ts', import.meta.url), 'utf8')

    const registry = /const CLI_ERROR_CODES = \[([\s\S]*?)\] as const/.exec(source)
    expect(registry, 'CLI_ERROR_CODES 的声明没解析出来——判据看不见它的目标就必须红').not.toBeNull()
    // spread 进来的那 39 个控制码在别处（control.ts）声明，这里只看本文件字面列出的。
    const registered = new Set([...registry![1]!.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!))

    const thrown = new Set(
      [...source.matchAll(/new AgentMuxError\([\s\S]*?,\s*'([A-Z_]+)'/g)].map((match) => match[1]!)
    )
    expect(thrown.size, 'agentmux.ts 里一个 throw 都没解析出来——下面的循环是死代码').toBeGreaterThan(2)

    // 控制码经 spread 在册，但它们不在本文件的字面量里，所以要单独放行。
    const { AGENTMUX_CONTROL_ERROR_CODES } = await import('../src/control.js')
    const control = new Set<string>(AGENTMUX_CONTROL_ERROR_CODES)

    const orphans = [...thrown].filter((code) => !registered.has(code) && !control.has(code))
    expect(
      orphans.sort(),
      `这些码 agentmux.ts 抛得出来，却不在 CLI_ERROR_CODES 里：${orphans.join(', ')}。` +
        'cliErrorCode 会把它们折成 AGENTMUX_FAILED——与「命令打错了」同一个码，机读侧分不出。' +
        '把它们加进 CLI_ERROR_CODES，或者确认它们真的不该有自己的码。'
    ).toEqual([])

    // 自检：两个解析都不许在空集上恒绿，且判据真的认得出"抛了但没在册"。
    expect(registered.has('AGENTMUX_FAILED'), '注册表解析漏了已知成员').toBe(true)
    expect(thrown.has('MAINTAINER_TARGET_UNRESOLVED'), 'throw 解析漏了已知的那一处').toBe(true)
    const probe = "throw new AgentMuxError('probe', 'NEVER_REGISTERED_CODE')"
    expect(
      [...probe.matchAll(/new AgentMuxError\([\s\S]*?,\s*'([A-Z_]+)'/g)].map((match) => match[1]!),
      '判据认不出一处普通的 throw——上面那条扫描是死代码'
    ).toEqual(['NEVER_REGISTERED_CODE'])
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
      const empty = await runWithStdin(['browser', 'run', '--browser', 'browser-1'], '   \n', env)
      const emptyError = JSON.parse(empty.stderr)
      expect(emptyError, `stderr=${empty.stderr}`).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
      expect(emptyError.error.message, '拒绝空程序时没告诉人怎么喂程序').toContain('Pipe it in')

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
})
