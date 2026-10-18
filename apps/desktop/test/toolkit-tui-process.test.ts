import { expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { ToolkitScriptSnapshot } from '@agentmux/core/control'
import { toolkitRuntime } from './helpers/toolkit-runtime.fixture.js'
vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }))
import { DEFAULT_CONFIG } from '../src/main/config-store.js'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild') as typeof import('../../../packages/core/node_modules/esbuild/lib/main.js')
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

async function childSource(directory: string) {
  const consumed: { path: string; originalSHA256: string; consumedSHA256: string }[] = []
  const entry = join(directory, 'toolkit-owner.mjs')
  const mutant = process.env.AGENTMUX_TOOLKIT_RECOVERY_MUTANT
  assert.ok(mutant === undefined || mutant === 'stop-on-dispose', 'Unknown recovery mutation')
  await build({ entryPoints: [join(root, 'apps/desktop/test/helpers/toolkit-tui-process.ts')], outfile: entry,
    bundle: true, platform: 'node', target: 'node24', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'production-toolkit-owner-in-a-real-process', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'host-paths' }))
      builder.onLoad({ filter: /.*/, namespace: 'host-paths' }, () => ({ contents:
        'export const app = { getPath: () => process.argv[2], getAppPath: () => process.argv[2] };', loader: 'js' }))
      builder.onResolve({ filter: /^@agentmux\// }, args => {
        const [, name] = /^@agentmux\/([^/]+)/u.exec(args.path)!
        const base = join(root, 'packages', name!)
        const manifest = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
        const key = args.path === `@agentmux/${name}` ? '.' : '.' + args.path.slice(`@agentmux/${name}`.length)
        const pattern = Object.keys(manifest.exports).filter(value => value.includes('*') &&
          key.startsWith(value.split('*')[0]!) && key.endsWith(value.split('*')[1]!)).sort((a, b) => b.length - a.length)[0]
        const selected = manifest.exports[key] ?? (pattern && manifest.exports[pattern])
        const target = typeof selected === 'string' ? selected : selected?.import
        assert.equal(typeof target, 'string', 'Missing built public package export: ' + args.path)
        const path = target.includes('*') ? target.replace('*', key.slice(pattern!.split('*')[0]!.length,
          pattern!.split('*')[1] ? -pattern!.split('*')[1]!.length : undefined)) : target
        return { path: resolve(base, path), external: true }
      })
      builder.onResolve({ filter: /^[^./]/ }, args => isBuiltin(args.path)
        ? { path: args.path, external: true } : { path: require.resolve(args.path), external: true })
      builder.onLoad({ filter: /\.ts$/ }, async args => {
        const original = await readFile(args.path, 'utf8'), path = relative(root, args.path)
        let source = original
        if (mutant && path === 'apps/desktop/src/main/toolkit-custom-owner.ts') {
          const anchor = '// The durable Run outlives this host owner; closing its observer is not Stop.'
          assert.equal(source.split(anchor).length - 1, 1, 'Recovery mutation must affect the actual disposal owner once')
          source = source.replace(anchor, 'await execution.port!.stop(ref(execution))\n        ' + anchor)
        }
        consumed.push({ path, originalSHA256: digest(original), consumedSHA256: digest(source) })
        return { contents: source, loader: 'ts', resolveDir: dirname(args.path) }
      })
    } }] })
  expect(consumed.some(value => value.path === 'apps/desktop/src/main/toolkit-custom-owner.ts')).toBe(true)
  return { entry, consumed, bundleSHA256: digest(await readFile(entry)) }
}

function start(entry: string, directory: string) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  const child = spawn(process.execPath, [entry, directory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    ...clean, AGENTMUX_RUNTIME_DIRECTORY: directory, AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson'), AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json')
  } })
  let stderr = ''
  child.stderr!.on('data', value => { stderr += value })
  child.stdout!.resume()
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  const response = (kind: 'ready' | 'disposed') => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Toolkit child did not report ${kind}: ${stderr}`)), 15000)
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer); child.off('message', receive); child.off('error', finish); child.off('exit', exited)
      if (error) reject(error); else resolve(value)
    }
    const receive = (value: any) => {
      if (value?.kind === kind) finish(undefined, value)
      else if (value?.kind === 'failed') finish(new Error(value.message))
    }
    const exited = () => finish(new Error(`Toolkit child exited before ${kind}: ${stderr}`))
    child.on('message', receive); child.once('error', finish); child.once('exit', exited)
  })
  return { child, ready: response('ready'), closed, async dispose() {
    const receipt = response('disposed')
    child.send('dispose')
    await receipt
    expect(await closed).toEqual({ code: 0, signal: null })
  } }
}

it('reconnects the original TUI after two physical owner processes exit normally', async () => {
  const native = await toolkitRuntime(), children: ChildProcess[] = []
  let proof: unknown, failure: unknown
  try {
    const source = await childSource(native.directory)
    const config = structuredClone(DEFAULT_CONFIG)
    config.toolkit = { tools: [{ id: 'interactive', revision: 'original', name: 'Interactive tool', icon: 'terminal',
      enabled: true, statusBar: 'label', mode: 'tui', workspacePath: native.directory, args: [process.execPath],
      script: `exec "$1" -e 'require("node:fs").appendFileSync("executions", "x");process.stdout.write("READY\\r\\n");setInterval(()=>{},1000)'` }] }
    await writeFile(join(native.directory, 'config.json'), JSON.stringify(config))
    const first = start(source.entry, native.directory); children.push(first.child)
    const original = (await first.ready).snapshot as ToolkitScriptSnapshot
    expect(original).toMatchObject({ state: 'running', admission: { definition: { mode: 'tui' }, text: '' } })
    const runId = original.admission!.run!.runId, executionId = original.admission!.executionId
    const before = await native.activation.client.status(runId)
    expect(before.state.type).toBe('running'); expect(before.pid).toBeGreaterThan(0)
    await first.dispose()
    const between = await native.activation.client.status(runId)
    expect(between).toMatchObject({ id: runId, pid: before.pid, state: { type: 'running' } })
    const persisted = JSON.parse(await readFile(join(native.directory, 'receipts.json'), 'utf8'))
    expect(persisted.tools.interactive.admission).toMatchObject({ executionId, run: { runId } })
    const second = start(source.entry, native.directory); children.push(second.child)
    const restored = (await second.ready).snapshot as ToolkitScriptSnapshot
    expect(restored).toMatchObject({ state: 'running', admission: { executionId, run: original.admission!.run } })
    expect(second.child.pid).not.toBe(first.child.pid)
    await second.dispose()
    const after = await native.activation.client.status(runId)
    expect(after).toMatchObject({ id: runId, pid: before.pid, state: { type: 'running' } })
    expect(await native.activation.client.daemonInstance()).toBe(native.activation.runtime.daemonInstanceId)
    expect((await native.activation.client.list()).map(run => run.id)).toEqual([runId])
    await vi.waitFor(async () => expect(await readFile(join(native.directory, 'executions'), 'utf8')).toBe('x'))
    proof = { executionId, runId, originalPid: before.pid, afterPid: after.pid,
      ownerPids: children.map(child => child.pid), ownerExits: await Promise.all([first.closed, second.closed]),
      daemonInstance: native.activation.runtime.daemonInstanceId, executionCount: 1, source }
  } catch (error) { failure = error; throw error }
  finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await closed
    }
    // Independent parent SDK remains responsible even when production disposal is mutated.
    for (const run of await native.activation.client.list()) {
      if (run.state.type === 'running') await native.activation.client.stop(await native.activation.client.prepareStop(run.id))
      await native.activation.client.remove(run.id)
    }
    expect(await native.activation.client.list()).toEqual([])
    const cleanup = await native.cleanup()
    expect(cleanup.childExit).toBe('confirmed'); expect(cleanup.namespace).toBe('removed')
    if (process.env.AGENTMUX_TOOLKIT_EVIDENCE) await appendFile(join(process.env.AGENTMUX_TOOLKIT_EVIDENCE, 'tui-process-recovery.jsonl'),
      JSON.stringify({ proof, failure: failure === undefined ? null : String(failure), cleanup }) + '\n')
  }
}, 60000)
