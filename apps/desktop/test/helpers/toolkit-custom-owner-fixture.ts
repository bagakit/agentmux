import { vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { fixturePath as _hygiene_fixturePath } from '../../scripts/lib/fixture-values.mjs'
import { fixtureEpoch } from '../../../../test/fixture-values.mjs'
import { DEFAULT_CONFIG } from '../../src/main/config-store.js'
import { ConfigOwner } from '../../src/main/config-owner.js'
import { CustomToolkitOwner } from '../../src/main/toolkit-custom-owner.js'
import { prepareToolkitConfig } from '../../src/main/toolkit-config.js'
import type { ToolkitRunInput, ToolkitInlineToolConfiguration } from '@agentmux/core/control'
import type { AgentMuxClientEvent, AgentMuxRun, AgentMuxRunAttachment } from '@agentmux/core'
import type { ToolkitRunPort } from '../../src/main/toolkit-run-port.js'

export const tool: ToolkitInlineToolConfiguration = { id: 'quota', revision: 'author-1', name: 'Quota', icon: 'terminal', enabled: true,
  statusBar: 'icon', workspacePath: _hygiene_fixturePath("tmp"), script: "console.log('工具_ACK')", args: [], actions: [] }
export const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
export const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r }), release: () => resolve() } }
export function fixture(output = '工具_ACK', initialState: 'running' | 'exited' = 'exited', definition = tool) {
  let config = { ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [structuredClone(definition)] } }
  let custom!: CustomToolkitOwner, accept: (event: AgentMuxClientEvent) => void = () => {}
  let state = initialState, exitCode = 0, bytes = Buffer.from(output), finalBytes = bytes.byteLength
  const receipts = new Map<string, unknown>()
  const storage = { read: vi.fn(async (id: string) => receipts.get(id) ?? null), save: vi.fn(async (id: string, value: unknown) => { receipts.set(id, structuredClone(value)) }) }
  const owner = new ConfigOwner({ read: () => config,
    prepare: (current, next) => prepareToolkitConfig(current, next, id => custom.guardDelete(id)),
    save: vi.fn(async next => structuredClone(next)), publish: saved => { config = saved as typeof config; custom.configurationChanged() } })
  const run = (): AgentMuxRun => ({ runId: 'exact-tool-run', kind: 'terminal', state, ...(state === 'exited' ? { exitCode } : {}),
    providerId: null, executorId: null, agentSessionId: null, workspacePath: definition.workspacePath, pid: null, cols: null, rows: null,
    observedAt: fixtureEpoch(1), acceptedInputBytes: 0, nativeService: null, latestOutputBytes: finalBytes })
  const snapshot = (): AgentMuxRunAttachment => ({ run: run(), replay: bytes.length ? [{ type: 'data', runId: 'exact-tool-run',
    startByte: 0, endByte: bytes.length, dataBytes: bytes, data: bytes.toString('utf8') }] : [], gap: null, terminal: { type: 'not-requested' }, resizeRevision: 0 })
  const port: ToolkitRunPort = { prepare: async () => { throw new Error('This finite-tool fixture does not prepare TUI Runs') }, createPrepared: async () => { throw new Error('This finite-tool fixture does not create TUI Runs') }, observe: () => () => {}, create: vi.fn(async (_input, listener) => { accept = listener; return run() }),
    attach: vi.fn(async (_ref, _after, listener) => {
      if (listener) accept = listener
      // Production attach publishes state before returning replay. This cannot recurse into another attach.
      accept({ type: 'process-state', state, exitCode: state === 'exited' ? exitCode : undefined, run: { runId: 'exact-tool-run' } } as any)
      return snapshot()
    }), replay: vi.fn(async () => snapshot()), status: vi.fn(async () => run()),
    release: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    stop: vi.fn(async () => { state = 'exited'; accept({ type: 'process-state', state: 'exited', exitCode: 0, run: { runId: 'exact-tool-run' } } as any) }) }
  custom = new CustomToolkitOwner({ config: owner, receipts: storage, openRunPort: async () => port, runner: process.execPath, env: {} })
  const input = (latest: string | null = null): ToolkitRunInput => ({ invocationId: randomUUID(), expectedRevision: config.toolkit.tools[0]!.revision, expectedLatestExecutionId: latest })
  return { custom, owner, storage, receipts, port, input, get config() { return config },
    exit: (code = 0) => { state = 'exited'; exitCode = code; accept({ type: 'process-state', state: 'exited', exitCode: code, run: { runId: 'exact-tool-run' } } as any) },
    begin: () => { state = 'running'; bytes = Buffer.alloc(0); finalBytes = 0 },
    final: (text: string, barrier = Buffer.byteLength(text)) => { bytes = Buffer.from(text); finalBytes = barrier },
    liveBytes: (data: Uint8Array, startByte: number) => accept({ type: 'terminal-output', run: { runId: 'exact-tool-run' }, dataBytes: data,
      evidence: { outputByteRange: { startByte, endByte: startByte + data.byteLength } } } as any) }
}

