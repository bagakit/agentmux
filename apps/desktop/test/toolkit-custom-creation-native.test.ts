import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }))
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, type AgentMuxClientEvent, type AgentMuxRun, type AgentMuxTerminalCreateInput } from '@agentmux/core'
import type { ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'
import { ConfigOwner } from '../src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { CustomToolkitOwner } from '../src/main/toolkit-custom-owner.js'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port.js'
import { toolkitRuntime } from './helpers/toolkit-runtime.fixture.js'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
it('repeats the exact private create input on pinned Native after a lost acknowledgement without executing twice', async () => {
  const native = await toolkitRuntime()
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', native.directory)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(native.directory, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(native.directory, 'messages.ndjson'))
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [] })
  const owners: CustomToolkitOwner[] = []
  let unsubscribe = () => {}, originalRun: AgentMuxRun | null = null, originalInputHash: string | null = null, continuedInputHash: string | null = null
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  let closeout: Awaited<ReturnType<typeof native.cleanup>> | undefined
  let verified = false
  try {
    await client.connect()
    let listener: (event: AgentMuxClientEvent) => void = () => {}, calls = 0
    unsubscribe = client.onEvent(event => listener(event))
    const port: ToolkitRunPort = { create: async (input, onEvent) => {
      listener = onEvent; calls++
      if (calls === 1) originalInputHash = hash(input)
      else continuedInputHash = hash(input)
      const run = await client.createTerminal(input)
      if (calls === 1) { originalRun = run; throw new Error('original-create-acknowledgement-lost') }
      expect(run.runId).toBe(originalRun!.runId)
      return run
    }, attach: async (ref, after, onEvent) => { if (onEvent) listener = onEvent; return await client.attachTerminal(ref.runId, after, 'raw') },
    replay: async (ref, after) => await client.readRunReplay(ref, after, 'raw'), release: async ref => await client.releaseRunAttachment(ref),
    stop: vi.fn(async ref => await client.stopTerminal(ref)), remove: async ref => await client.removeTerminal(ref) }
    const definition = { id: 'native-document', revision: 'revision', name: 'Native document', icon: 'terminal', enabled: true,
      statusBar: 'icon', workspacePath: native.directory, args: [], script: "import{appendFileSync}from'node:fs';appendFileSync(process.env.RESULT_COUNTER,'x');console.log('original-native-ack')" } satisfies ToolkitToolDefinition
    const config = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [definition] } }, receipts = new Map<string, unknown>()
    const configOwner = new ConfigOwner({ read: () => config, save: async next => next, publish: () => {} })
    const storage = { read: async (id: string) => structuredClone(receipts.get(id) ?? null), save: async (id: string, value: unknown) => { receipts.set(id, structuredClone(value)) } }
    const makeOwner = (runner = process.execPath) => { const owner = new CustomToolkitOwner({ config: configOwner, receipts: storage, openRunPort: async () => port,
      runner, env: { RESULT_COUNTER: join(native.directory, 'counter') } }); owners.push(owner); return owner }
    const original = makeOwner(), input = { invocationId: 'original-native-invocation', expectedRevision: definition.revision, expectedLatestExecutionId: null }
    const lost = await original.run(definition.id, input, new AbortController().signal) as ToolkitScriptSnapshot
    expect(lost).toMatchObject({ state: 'unknown', admission: { run: null }, latestConfirmed: null })
    const retained = receipts.get(definition.id) as { createIntent: AgentMuxTerminalCreateInput }
    expect(hash(retained.createIntent)).toBe(originalInputHash)
    expect(JSON.stringify(lost)).not.toContain('createIntent')
    expect(JSON.stringify(lost)).not.toContain('AGENTMUX_TOOLKIT_RESULT_TOKEN')
    const restored = makeOwner(join(native.directory, 'replacement-runner'))
    await restored.get(definition.id); expect(calls).toBe(1)
    const repeated = await restored.run(definition.id, input, new AbortController().signal)
    expect(continuedInputHash, repeated.reason ?? 'Original creation input must remain exact.').toBe(originalInputHash)
    await vi.waitFor(async () => expect(await restored.get(definition.id)).toMatchObject({ state: 'succeeded', admission: null,
      latestConfirmed: { executionId: lost.admission!.executionId, run: { runId: originalRun!.runId }, text: expect.stringContaining('original-native-ack') } }), { timeout: 10000, interval: 20 })
    expect(await readFile(join(native.directory, 'counter'), 'utf8')).toBe('x')
    expect(calls).toBe(2); expect(port.stop).not.toHaveBeenCalled()
    expect(Object.hasOwn(receipts.get(definition.id)!, 'createIntent')).toBe(false)
    verified = true
  } finally {
    try { for (const owner of owners.reverse()) await owner.dispose() }
    finally { unsubscribe(); try { await client.dispose() } finally { closeout = await native.cleanup() } }
    expect(closeout.childExit).toBe('confirmed'); expect(closeout.namespace).toBe('removed')
  }
  const target = process.env.AGENTMUX_TOOLKIT_CONNECTION_NATIVE_EVIDENCE
  if (target && verified) {
    const manifest = JSON.parse(await readFile(new URL('../../../packages/core/vendor/ctxmux/' + process.platform + '-' + process.arch + '/manifest.json', import.meta.url), 'utf8'))
    await writeFile(target, JSON.stringify({ status: 'passed', originalRunId: originalRun!.runId, createCalls: 2, executionCount: 1,
      originalInputHash, continuedInputHash, publicIntentAbsent: true, explicitStops: 0,
      pinnedNative: { protocol: manifest.product.protocol, sourceCommit: manifest.source.commit, sourceTree: manifest.source.tree },
      cleanup: { childExit: closeout!.childExit, namespace: closeout!.namespace } }) + '\n')
  }
}, 30000)
