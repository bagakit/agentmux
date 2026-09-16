import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxControlServer, parseAgentMuxControlReceipt, requestAgentMuxControl,
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

it('public inspected receipts carry exact normal/alternate and input facts with the unchanged schema', () => {
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
    { ...base, kind: 'file', path: '/private/fixture.txt' }, { ...base, kind: 'launcher' }, { ...base, kind: 'view' }]
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
  const root = await mkdtemp('/tmp/amux-terminal-view-'); roots.push(root)
  const path = join(root, 'control.sock'), seen: string[] = []
  const regions: AgentMuxInspectedRegion[] = [{ ...terminal, terminalView: normal },
    { ...agent, regionId: 'private-agent-region', terminalView: alternate }]
  const server = new AgentMuxControlServer({ async execute(request): Promise<AgentMuxControlResult> {
    seen.push(request.operation)
    if (request.operation === 'inspect.tab') return { operation: request.operation,
      tab: { tabId: base.tabId, workspaceId: base.workspaceId, regions } }
    if (request.operation === 'inspect.region') return { operation: request.operation, region: regions[1]! }
    throw new Error('Inspection must not invoke input or lifecycle')
  } }, path)
  await server.start()
  try {
    await expect(requestAgentMuxControl({ schemaVersion: 5, requestId: 'socket-tab', operation: 'inspect.tab',
      target: { kind: 'tab', tabId: base.tabId } }, path)).resolves.toEqual({ schemaVersion: 5,
      requestId: 'socket-tab', ok: true, operation: 'inspect.tab', result: { tab: { tabId: base.tabId, workspaceId: base.workspaceId, regions } } })
    await expect(requestAgentMuxControl({ schemaVersion: 5, requestId: 'socket-region', operation: 'inspect.region',
      target: { kind: 'region', regionId: regions[1]!.regionId } }, path)).resolves.toEqual({ schemaVersion: 5,
      requestId: 'socket-region', ok: true, operation: 'inspect.region', result: { region: regions[1] } })
    expect(seen).toEqual(['inspect.tab', 'inspect.region'])
  } finally { await server.stop() }
})
