import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc } from '@agentmux/core'
import { startHeadlessAgentMux } from '@agentmux/core/headless-runtime'
import type { ToolkitScriptSnapshot, ToolkitToolFields } from '@agentmux/core/toolkit'
import { parseCapsuleRuntimeResult } from '../../../packages/core/src/capsule-runtime'
import { staleDistComplaint } from '../../../vitest.dist-freshness'
import { ConfigOwner } from '../src/main/config-owner'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { RuntimeController } from '../src/main/runtime-controller'
import { ToolkitOwner } from '../src/main/toolkit-owner'
import { toolkitRuntime } from './helpers/toolkit-runtime.fixture'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('runs the documented Custom TUI against the same Core management CLI without owning the Capsule service', async () => {
  for (const name of ['core', 'capsule']) expect(await staleDistComplaint(resolve('packages', name))).toBeNull()
  const native = await toolkitRuntime(), directory = native.directory
  for (const key of Object.keys(process.env)) if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(directory, 'sessions.json'))
  vi.stubEnv('PATH', dirname(process.execPath) + ':' + process.env.PATH)
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  let saved = structuredClone(DEFAULT_CONFIG), desktop!: RuntimeController
  const config = new ConfigOwner({ read: () => saved, save: async value => { saved = value; return value }, publish() {} })
  const receipts = join(directory, 'toolkit-receipts.json')
  const toolkit = new ToolkitOwner({ config, receiptPath: receipts, enabled: () => true,
    openRunPort: () => desktop.toolkitRunPort(),
    launch: () => ({ runner: process.execPath, cli: resolve('packages/core/dist/agentmux.js'),
      script: resolve('apps/desktop/resources/toolkit/performance.mjs'), cwd: directory, env: {} }) })
  let core: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    // This is the default headless composition, not a test-owned Capsule HTTP owner.
    core = await startHeadlessAgentMux({ stateDirectory: join(directory, 'state'), socketPath: join(directory, 'control.sock'), store, providers: [], service: { toolkit } })
    await core.client.connect()
    desktop = new RuntimeController(store, async () => core!.client as never)
    vi.spyOn(desktop as any, 'configuredClient').mockReturnValue(core.client)
    vi.spyOn(desktop as any, 'connectedClient').mockResolvedValue(core.client)
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: core.socketPath } })
    const idle = parseCapsuleRuntimeResult(await rpc.call('capsule.runtime.inspect', {}))
    await rpc.call('capsule.runtime.start', { operationId: 'original-service-start', expectedRevision: idle.revision })
    let service = idle
    await vi.waitFor(async () => {
      service = parseCapsuleRuntimeResult(await rpc!.call('capsule.runtime.inspect', {}))
      expect(service.phase, service.issue?.message).toBe('running')
    }, { timeout: 15000 })
    expect(service.desired).toBe('running'); expect(service.run).not.toBeNull(); expect(service.runtime).not.toBeNull()
    const before = await native.activation.client.status(service.run!.runId)
    expect(before.state.type).toBe('running')
    const sourcePath = join(directory, 'content'); await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'index.html'), '<!doctype html><title>Original service</title>Independent service content')
    const page = await rpc.call('capsule.create', { operationId: 'original-tui-page', sourcePath })
    expect(page.endpoint.status).toBe('available')

    // The production guide is the producer recipe. Only its documented placeholders change.
    const guide = await readFile(resolve('packages/core/guides/modules/toolkit.md'), 'utf8')
    const blocks = [...guide.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(match => JSON.parse(match[1]!))
    const examples = blocks.filter(value => value.name === 'Capsule status')
    expect(examples).toHaveLength(1)
    const value = { ...examples[0], workspacePath: directory,
      args: [resolve('packages/core/bin/amux'), 'unix:' + core.socketPath] } as ToolkitToolFields
    const added = await rpc.call('toolkit.create', { toolId: 'capsule-status-client', value })
    expect(added.definition).toMatchObject({ id: 'capsule-status-client', enabled: false, mode: 'tui', script: value.script, args: value.args })
    expect((await native.activation.client.list()).map(run => run.id)).toEqual([service.run!.runId])
    await rpc.call('toolkit.update', { toolId: added.definition.id, input: { expected: { enabled: false }, changes: { enabled: true } } })
    let snapshot!: ToolkitScriptSnapshot
    await vi.waitFor(async () => {
      snapshot = (await rpc!.call('toolkit.inspect', { toolId: added.definition.id })).snapshot as ToolkitScriptSnapshot
      expect(snapshot.latestConfirmed?.state, 'Documented Capsule CLI must succeed in the original TUI Run. ' + (snapshot.reason ?? '')).toBe('succeeded')
      expect(snapshot.admission).toBeNull()
    }, { timeout: 15000 })
    const execution = snapshot.latestConfirmed!
    expect(execution.run).not.toEqual(service.run)
    expect(execution.definition).toMatchObject({ id: added.definition.id, mode: 'tui', enabled: true, script: value.script, args: value.args })
    const toolRun = await native.activation.client.status(execution.run!.runId)
    expect(toolRun.state).toMatchObject({ type: 'exited', code: 0 })
    // TUI bytes belong to the original terminal owner, not Toolkit's finite result document.
    const replay = await core.client.readRunReplay(execution.run!, 0, 'raw')
    const bytes = Buffer.concat(replay.replay.map(frame => Buffer.from(frame.dataBytes)))
    const frames = bytes.toString('utf8').split(/\r?\n/u).filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    expect(frames).toHaveLength(1); expect(frames[0]).toMatchObject({ ok: true, operation: 'capsule.runtime.inspect' })
    const observed = parseCapsuleRuntimeResult(frames[0].result)
    expect(observed).toMatchObject({ desired: 'running', phase: 'running', run: service.run, runtime: service.runtime })
    expect(execution.document).toBeUndefined(); expect(execution.text).toBe('')
    const persisted = JSON.parse(await readFile(receipts, 'utf8')).tools[added.definition.id].latestConfirmed
    expect(persisted).toMatchObject({ executionId: execution.executionId, run: execution.run, definition: execution.definition })
    await toolkit.dispose(); await desktop.dispose(); await rpc.dispose(); rpc = undefined
    await core.stop(); core = undefined
    const after = await native.activation.client.status(service.run!.runId)
    expect(after).toMatchObject({ id: service.run!.runId, pid: before.pid, state: { type: 'running' } })
    if (page.endpoint.status !== 'available') throw new Error('Original page endpoint was not observed')
    expect(await (await fetch(page.endpoint.url)).text()).toContain('Independent service content')
    expect((await native.activation.client.list()).map(run => run.id).sort()).toEqual([service.run!.runId, execution.run!.runId].sort())
  } finally {
    await toolkit.dispose(); await desktop?.dispose(); await rpc?.dispose(); await core?.stop()
    // The original SDK fixture owns corrective cleanup, independently of product disposal.
    for (const run of await native.activation.client.list()) {
      if (run.state.type === 'running') await native.activation.client.stop(await native.activation.client.prepareStop(run.id))
      await native.activation.client.remove(run.id)
    }
    expect(await native.activation.client.list()).toEqual([])
    const cleanup = await native.cleanup()
    expect(cleanup.childExit).toBe('confirmed'); expect(cleanup.namespace).toBe('removed')
  }
}, 45000)
