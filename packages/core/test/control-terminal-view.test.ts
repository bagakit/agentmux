import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxControlServer, parseAgentMuxControlReceipt, connectAgentMuxRpc,
  type AgentMuxControlResult, type AgentMuxInspectedRegion, type AgentMuxTerminalViewObservation
} from '../src/index.js'

const none = { kind: 'none' } as const
const base = { tabId: 'private-tab', regionId: 'private-region', workspaceId: 'private-workspace',
  bounds: { x: 0, y: 0, width: 1, height: 1 }, neighbors: { left: none, right: none, up: none, down: none } }
const terminal = { ...base, kind: 'terminal', runId: 'private-run' } as const
const agent = { ...base, kind: 'agent', agentSessionId: 'private-agent', providerId: 'codex', executorId: 'private-executor' } as const
const normal: AgentMuxTerminalViewObservation = { runId: terminal.runId, sampledAt: 10,
  visible: true, readOnly: false, liveReady: true, acceptsInput: true, viewGrid: { cols: 80, rows: 24 },
  buffer: { type: 'normal', baseY: 100, viewportY: 40, length: 124 }, mouseTrackingMode: 'none' }
const alternate: AgentMuxTerminalViewObservation = { ...normal, visible: false, readOnly: true,
  liveReady: false, acceptsInput: false, buffer: { type: 'alternate', baseY: 0, viewportY: 0, length: 24 }, mouseTrackingMode: 'any' }
function receipt(region: unknown) {
  return { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'private-inspection', ok: true,
    operation: 'inspect.region', result: { region } }
}
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('internal inspected DTO receipts carry exact normal/alternate and input facts with the unchanged owner schema', () => {
  expect(AGENTMUX_CONTROL_SCHEMA_VERSION).toBe(5)
  const cases = [{ ...terminal, terminalView: normal }, { ...agent, terminalView: alternate }]
  expect(cases).toHaveLength(2)
  for (const region of cases) expect(parseAgentMuxControlReceipt(receipt(region))).toEqual(receipt(region))
  const absent = receipt(terminal)
  expect(parseAgentMuxControlReceipt(absent)).toEqual(absent)
})

it('strictly rejects malformed present observations instead of presenting partial or guessed facts', () => {
  const invalid = [null, [], {}, { ...normal, runId: '' }, { ...normal, runId: 'wrong\nrun' },
    { ...normal, sampledAt: -1 }, { ...normal, sampledAt: Infinity }, { ...normal, sampledAt: '10' },
    ...(['visible', 'readOnly', 'liveReady', 'acceptsInput'] as const).map(field => ({ ...normal, [field]: 1 })),
    { ...normal, viewGrid: null }, { ...normal, viewGrid: { cols: 0, rows: 24 } },
    { ...normal, viewGrid: { cols: 80, rows: 0 } }, { ...normal, viewGrid: { cols: 80.5, rows: 24 } },
    { ...normal, viewGrid: { cols: 80, rows: Number.MAX_SAFE_INTEGER + 1 } },
    { ...normal, buffer: null }, { ...normal, buffer: { ...normal.buffer, type: 'unknown' } },
    { ...normal, buffer: { ...normal.buffer, baseY: -1 } },
    { ...normal, buffer: { ...normal.buffer, viewportY: -1 } },
    { ...normal, buffer: { ...normal.buffer, viewportY: 101 } },
    { ...normal, buffer: { ...normal.buffer, length: 100 } },
    { ...normal, buffer: { ...normal.buffer, length: 0 } },
    { ...normal, buffer: { ...normal.buffer, baseY: .5 } },
    { ...normal, buffer: { ...normal.buffer, viewportY: .5 } },
    { ...normal, buffer: { ...normal.buffer, length: .5 } },
    { ...normal, mouseTrackingMode: 'sgr' }]
  expect(invalid).toHaveLength(28)
  for (const terminalView of invalid) expect(() => parseAgentMuxControlReceipt(receipt({ ...terminal, terminalView })))
    .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})

it('only inspected Agent or Terminal regions can carry the observation and a Terminal must match its Run', () => {
  const otherRegions = [{ ...base, kind: 'browser', browserId: 'private-browser' },
    { ...base, kind: 'file', path: fixturePath("private/fixture.txt") }, { ...base, kind: 'launcher' }, { ...base, kind: 'view' }]
  expect(otherRegions).toHaveLength(4)
  for (const region of otherRegions) expect(() => parseAgentMuxControlReceipt(receipt({ ...region, terminalView: normal })))
    .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(() => parseAgentMuxControlReceipt(receipt({ ...terminal, terminalView: { ...normal, runId: 'different-run' } })))
    .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  // An Agent's canonical Run is known by the client, not this plain protocol decoder.
  expect(parseAgentMuxControlReceipt(receipt({ ...agent, terminalView: { ...normal, runId: 'client-owned-run' } })))
    .toEqual(receipt({ ...agent, terminalView: { ...normal, runId: 'client-owned-run' } }))
})

it('projects only public facts, preserves all mouse modes and does not infer a buffer size from the grid', () => {
  const modes: AgentMuxTerminalViewObservation['mouseTrackingMode'][] = ['none', 'x10', 'vt200', 'drag', 'any']
  expect(modes).toHaveLength(5)
  for (const mouseTrackingMode of modes) {
    const terminalView = { ...normal, sampledAt: .5, mouseTrackingMode,
      viewGrid: { cols: 80, rows: 100 }, buffer: { type: 'normal' as const, baseY: 0, viewportY: 0, length: 1 } }
    expect(parseAgentMuxControlReceipt(receipt({ ...terminal, terminalView: { ...terminalView, output: 'not an observation field',
      buffer: { ...terminalView.buffer, lines: ['not exported'] }, viewGrid: { ...terminalView.viewGrid, pixels: 500 } } })))
      .toEqual(receipt({ ...terminal, terminalView }))
  }
  const opening = { schemaVersion: 5, requestId: 'plain-region', ok: true, operation: 'open.terminal',
    result: { region: { ...terminal, terminalView: null } } }
  expect(parseAgentMuxControlReceipt(opening)).toEqual({ ...opening,
    result: { region: { tabId: terminal.tabId, regionId: terminal.regionId, workspaceId: terminal.workspaceId,
      kind: 'terminal', runId: terminal.runId } } })
})

it('actual public Unix-socket inspection carries a nonempty mixed Tab and the exact current view without input or lifecycle calls', async () => {
  const root = await mkdtemp(fixturePath("tmp/amux-terminal-view-")); roots.push(root)
  const path = join(root, 'control.sock'), seen: string[] = []
  const regions: AgentMuxInspectedRegion[] = [{ ...terminal, terminalView: normal },
    { ...agent, regionId: 'private-agent-region', terminalView: alternate }]
  const server = new AgentMuxControlServer({ coreClients: () => [], async execute(request): Promise<AgentMuxControlResult> {
    seen.push(request.operation)
    if (request.operation === 'inspect.tab') return { operation: request.operation,
      tab: { tabId: base.tabId, workspaceId: base.workspaceId, regions } }
    if (request.operation === 'inspect.region') return { operation: request.operation, region: regions[1]! }
    if (request.operation === 'space.inspect') return { operation: request.operation, catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] } }
    throw new Error('Inspection must not invoke input or lifecycle')
  } }, path)
  await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  try {
    await expect(client.call('space.inspect', { target: { tabId: base.tabId } })).resolves.toEqual({
      catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
      presentation: { tab: { tabId: base.tabId, workspaceId: base.workspaceId, regions }, region: null, unavailable: [] }
    })
    await expect(client.call('space.inspect', { target: { regionId: regions[1]!.regionId } })).resolves.toEqual({
      catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
      presentation: { region: regions[1], tab: null, unavailable: [] }
    })
    expect(seen).toEqual(['inspect.tab', 'space.inspect', 'inspect.region', 'space.inspect'])
  } finally { await client.dispose(); await server.stop() }
})
