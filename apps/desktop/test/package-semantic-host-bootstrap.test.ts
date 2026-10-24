import { fixturePsBirth } from '../scripts/lib/fixture-values.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { prepareSemanticHostReload, inspectSemanticHostForInstall } from '../scripts/package-semantic-host.mjs'

type Row = { pid: number; uid: number; ppid: number; birth: string; command: string }
type Scope = { app: string; row: Row; mode: string; executions: Array<Record<string, unknown>> }
const boundary = vi.hoisted(() => ({ scope: undefined as Scope | undefined }))

// Only App OS snapshots are fixture ports. The bootstrap branch executes the
// actual Node child and original helper, including its real timeout when mutated.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execute = promisify(actual.execFile)
  const controlled = async (command: string, args: string[], options: Parameters<typeof execute>[2]) => {
    const f = boundary.scope
    if (!f) throw new Error('No private installer OS scope')
    if (command === process.execPath && args[1] === '--bootstrap') {
      const row: Record<string, unknown> = { command, args, startedAt: Date.now() }
      f.executions.push(row)
      const pending = execute(command, args, options)
      row.pid = pending.child.pid
      try { const result = await pending; row.exitCode = 0; return result }
      catch (error) {
        const failure = error as { signal?: string; killed?: boolean; code?: unknown }
        Object.assign(row, { exitCode: failure.code ?? null, signal: failure.signal ?? null, killed: failure.killed ?? false })
        throw error
      } finally { row.finishedAt = Date.now() }
    }
    if (command === '/bin/launchctl') {
      if (args[0] === 'managername') return { stdout: 'Aqua\n', stderr: '' }
      if (args[0] === 'manageruid') return { stdout: String(process.getuid!()) + '\n', stderr: '' }
      if (args[0] === 'list') return { stdout: 'PID\tStatus\tLabel\n-\t0\tprivate-unrelated-service\n', stderr: '' }
    }
    if (command === '/bin/ps') {
      if (args[0] === '-p' && Number(args[1]) !== f.row.pid) throw Object.assign(new Error('Private PID absent'), { code: 1 })
      const r = f.row
      return { stdout: `${r.uid} ${r.pid} ${r.ppid} ${r.birth} ${r.command}\n`, stderr: '' }
    }
    if (command === '/usr/bin/python3') return { stdout: JSON.stringify([{ ...f.row, mode: f.mode,
      executable: join(f.app, 'Contents/MacOS/AgentMux') }]), stderr: '' }
    throw new Error('Unowned installer OS command: ' + command)
  }
  return { ...actual, execFile: Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args),
    { [Symbol.for('nodejs.util.promisify.custom')]: controlled }) }
})

it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('default semantic bootstrap waits for the real delayed child and retains exact fenced ownership and healthy Run', async () => {
  const proofPath = process.env.AGENTMUX_SEMANTIC_BOOTSTRAP_PRODUCT
  const scope = await headlessFixture({ cli: true })
  let run: { runId: string } | undefined
  const product: Record<string, unknown> = { schema: 'agentmux.semantic-bootstrap-product.v1', userRuntimeTouched: false,
    boundary: 'Actual default prepare/inspect operations and real child/RPC/private Native; only App OS observations are fixture ports.' }
  try {
    for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
    for (const [key, value] of Object.entries(scope.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, value)
    const sdk = await scope.client()
    run = await sdk.createTerminal({ createOperationId: 'semantic-tool-original-run', workspacePath: scope.root,
      command: process.execPath, args: ['-e', "process.stdin.setEncoding('utf8');process.stdin.on('data',s=>process.stdout.write('tool-echo:'+s))"] })
    const attached = await sdk.attachTerminal(run.runId, 0), cursor = attached.run.acceptedInputBytes!
    const input = 'before-bootstrap\n', native = scope.owner.ctxmux!
    await sdk.writeTerminal(run, { ownerInstanceId: native.instanceId, operationId: 'semantic-tool-before', expectedByte: cursor, data: input })
    await until(() => sdk.readRunReplay(run!, 0, 'raw'), value => value.replay.some(chunk => Buffer.from(chunk.dataBytes).toString().includes('tool-echo:before-bootstrap')), 'private original input/output')
    const app = join(scope.root, 'Original.app'), candidate = join(scope.root, 'Candidate.app')
    for (const target of [app, candidate]) {
      await mkdir(join(target, 'Contents/MacOS'), { recursive: true })
      await mkdir(join(target, 'Contents/Resources/app'), { recursive: true })
      await writeFile(join(target, 'Contents/MacOS/AgentMux'), 'private image fixture')
      await writeFile(join(target, 'Contents/Resources/app/package-identity.json'), JSON.stringify({ sourceCommit: (target === app ? 'a' : 'b').repeat(40) }))
    }
    const core = join(app, 'Contents/Resources/app/node_modules/@agentmux/core/dist')
    await mkdir(core, { recursive: true })
    await writeFile(join(core, 'package.json'), '{"type":"module"}')
    const actualRpc = pathToFileURL(resolve(import.meta.dirname, '../../../packages/core/dist/public-rpc-client.js')).href
    const actualPaths = pathToFileURL(resolve(import.meta.dirname, '../../../packages/core/dist/runtime-paths.js')).href
    // Real child module initialization costs time before the original RPC begins.
    // No timeout budget or successful owner fact is injected into production.
    await writeFile(join(core, 'public-rpc-client.js'), `await new Promise(resolve=>setTimeout(resolve,11000));export {connectAgentMuxRpc} from ${JSON.stringify(actualRpc)};\n`)
    await writeFile(join(core, 'runtime-paths.js'), `export {defaultAgentMuxControlSocketPath} from ${JSON.stringify(actualPaths)};\n`)
    const row: Row = { uid: process.getuid!(), pid: scope.owner.processId, ppid: 1, birth: fixturePsBirth(60_000),
      command: `${app}/Contents/MacOS/AgentMux ${app}/Contents/Resources/app/out/main/agentmux-host.js --store ${scope.env.AGENTMUX_AGENT_SESSION_STORE}` }
    const os: Scope = { app, row, mode: 'node', executions: [] }; boundary.scope = os
    let plan: Awaited<ReturnType<typeof prepareSemanticHostReload>> | undefined, bootstrapError: unknown
    try { plan = await prepareSemanticHostReload(app, candidate) } catch (error) { bootstrapError = error }
    const after = await sdk.readRunReplay(run, 0, 'raw')
    expect(after.run).toMatchObject({ runId: run.runId, pid: attached.run.pid, state: 'running', acceptedInputBytes: cursor + Buffer.byteLength(input) })
    expect(sdk.runtimeOwnerIdentity()?.ctxmux?.instanceId).toBe(native.instanceId)
    product.runRetained = { runId: run.runId, pid: after.run.pid, nativeInstanceId: native.instanceId, acceptedInputBytes: after.run.acceptedInputBytes }
    product.executions = os.executions; product.bootstrapError = bootstrapError instanceof Error ? bootstrapError.message : null
    if (proofPath) await writeFile(proofPath, JSON.stringify(product, null, 2))
    expect(bootstrapError, 'The default wrapper must accept the actual child reply after ten seconds').toBeUndefined()
    expect(os.executions).toHaveLength(1)
    const execution = os.executions[0]!
    expect(Number(execution.finishedAt) - Number(execution.startedAt)).toBeGreaterThanOrEqual(11000)
    expect(execution.exitCode).toBe(0)
    expect(plan!.identity).toMatchObject({ hostProcessId: scope.owner.processId, storePath: scope.env.AGENTMUX_AGENT_SESSION_STORE,
      owner: { runtimeId: scope.owner.runtimeId, ownerInstanceId: scope.owner.ownerInstanceId, ctxmux: { instanceId: native.instanceId } } })
    expect(plan!.owner).toEqual(row)
    // A later exact process mismatch is still rejected by the default consumer.
    // Its helper is now fast; only the success sample needs the real 11s delay.
    await writeFile(join(core, 'public-rpc-client.js'), `export {connectAgentMuxRpc} from ${JSON.stringify(actualRpc)};\n`)
    os.row = { ...row, uid: row.uid + 1 }
    await expect(inspectSemanticHostForInstall(plan!)).rejects.toThrow('does not match the original installed namespace')
    os.row = row
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
    try {
      await expect(rpc.call('runtime.bootstrap', { consumerId: 'wrong-fence-private-reader', fence: {
        runtimeId: scope.owner.runtimeId, ownerInstanceId: 'another-owner' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
    } finally { await rpc.dispose() }
    const final = await sdk.readRunReplay(run, 0, 'raw')
    expect(final.run).toMatchObject({ pid: attached.run.pid, state: 'running', acceptedInputBytes: after.run.acceptedInputBytes })
    product.targetRejected = true; product.fenceRejected = true; product.passed = true
    if (proofPath) await writeFile(proofPath, JSON.stringify(product, null, 2))
  } finally {
    if (run) { const sdk = await scope.client(); await sdk.stopTerminal(run).catch(() => {}) }
    await scope.cleanup(); boundary.scope = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks()
  }
}, 45000)
