import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest } from '../src/control-host.js'
import type { AgentMuxControlFocusRequest, AgentMuxControlRequest } from '../src/control.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { focusFacts } from './fixtures/desktop-focus-facts.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

const loader = new URL('../../../apps/desktop/scripts/fixtures/desktop-map/source-loader.mjs', import.meta.url)
const environment = (directory: string) => objectCliEnvironment(directory, { NODE_NO_WARNINGS: '1',
  ...Object.fromEntries(['AGENTMUX_DESKTOP_MAP_MUTATION', 'AGENTMUX_DESKTOP_MAP_LOADED'].filter(name => process.env[name]).map(name => [name, process.env[name]])) })
const cli = (args: readonly string[], directory: string) => runSourceObjectCli(args, environment(directory), '', 15000, loader)
const request = (target: unknown) => ({ schemaVersion: 5, requestId: 'map-navigation', operation: 'focus', target, inputPolicy: 'preserve' })
let directory: string, server: AgentMuxControlServer, seen: AgentMuxControlRequest[]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'map-nav-')); seen = []
  server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: async input => {
    seen.push(input)
    if (input.operation === 'focus') return focusFacts(input)
    throw Error('Only original presentation navigation is authorized by this fixture')
  } })
  await server.start()
})
afterEach(async () => { await server.stop(); await rm(directory, { recursive: true }) })

it('routes actual source CLI map and workbench navigation through the original public focus owner', async () => {
  for (const view of ['map', 'workbench']) {
    const result = await cli(['app', 'focus', '--surface', 'space', '--view', view], directory)
    expect(result.code, result.stderr).toBe(1) // The truthful mock presentation is unconfirmed, not a native visibility proof.
    expect(result.stdout, result.stderr).not.toBe('')
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({ ok: true, operation: 'app.focus', result: { navigation: { requested: { kind: 'surface', surface: 'space', view }, selection: { surface: 'space', spaceView: view } }, input: { policy: 'preserve', outcome: 'unconfirmed' }, partial: true } })
  }
  expect(seen).toHaveLength(2)
  expect(seen.map(input => input.operation === 'focus' && input.target)).toEqual([{ kind: 'surface', surface: 'space', view: 'map' }, { kind: 'surface', surface: 'space', view: 'workbench' }])
}, 30000)

it('rejects invalid view and non-Space map parameters before the original owner executes', async () => {
  const invalid = [ ['--surface', 'focus', '--view', 'map'] ]
  expect(invalid).toHaveLength(1)
  for (const args of invalid) {
    const result = await cli(['app', 'focus', ...args], directory)
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout || result.stderr)).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^INVALID_(CONTROL_REQUEST|CLI_ARGUMENT)$/u) } })
  }
  expect(seen).toEqual([])
}, 30000)

it('validates exact map view receipts without presenting a retained Region or upgrading hidden input', () => {
  const input = parseAgentMuxControlRequest(request({ kind: 'surface', surface: 'space', view: 'map' })) as AgentMuxControlFocusRequest
  const { operation, ...facts } = focusFacts(input)
  const receipt = { schemaVersion: 5, requestId: input.requestId, operation, ok: true, result: { ...facts, partial: false, issues: [], presentation: { ...facts.presentation, provenance: 'observed', state: 'main-visible' }, input: { ...facts.input, outcome: 'preserved' } } }
  expect(facts.navigation.selection.space?.regionId).toBe('region')
  expect(() => parseAgentMuxControlReceipt(receipt)).not.toThrow()
  expect(parseAgentMuxControlReceipt(receipt)).toMatchObject({ result: { navigation: { selection: { spaceView: 'map', space: { regionId: 'region' } } }, presentation: { tabId: null, regionId: null }, partial: false } })
  const invalid = [
    { ...receipt, result: { ...receipt.result, navigation: { ...facts.navigation, selection: { ...facts.navigation.selection, spaceView: 'workbench' } }, presentation: { ...receipt.result.presentation, tabId: 'tab', regionId: 'region' } } },
    { ...receipt, result: { ...receipt.result, presentation: { ...receipt.result.presentation, tabId: 'tab', regionId: 'region' } } },
    { ...receipt, result: { ...receipt.result, presentation: { ...receipt.result.presentation, state: 'floating' } } },
    { ...receipt, result: { ...receipt.result, input: { ...receipt.result.input, after: { ...facts.input.after, visible: false } } } }
  ]
  expect(invalid).toHaveLength(4)
  for (const value of invalid) expect(() => parseAgentMuxControlReceipt(value)).toThrow()
  for (const state of ['pending', 'unknown', 'covered'] as const) {
    const pending = { ...receipt, result: { ...receipt.result, partial: true,
      presentation: { ...receipt.result.presentation, state, blockers: state === 'covered' ? ['settings'] : [] } } }
    expect(() => parseAgentMuxControlReceipt(pending)).not.toThrow()
    expect(() => parseAgentMuxControlReceipt({ ...pending, result: { ...pending.result,
      presentation: { ...pending.result.presentation, tabId: 'tab', regionId: 'region' } } })).toThrow()
    expect(() => parseAgentMuxControlReceipt({ ...pending, result: { ...pending.result,
      presentation: { ...pending.result.presentation, windowId: 'native-window', documentGeneration: 'native-document' } } })).toThrow()
  }
  for (const state of ['floating', 'window'] as const) expect(() => parseAgentMuxControlReceipt({ ...receipt, result: { ...receipt.result, partial: true,
    presentation: { ...receipt.result.presentation, state, ...(state === 'window' ? { windowId: 'native-window', documentGeneration: 'native-document' } : {}) } } })).toThrow()
})

it('keeps omission distinct from an explicit Space view and exposes map usage from the original help and skill registry', async () => {
  expect(parseAgentMuxControlRequest(request({ kind: 'surface', surface: 'space' }))).toMatchObject({ target: { kind: 'surface', surface: 'space' } })
  const invalid = [ { kind: 'surface', surface: 'space', view: undefined }, { kind: 'surface', surface: 'goals', view: 'map' }, { kind: 'space', zoneId: 'zone', view: 'map' }, { kind: 'surface', surface: 'space', view: 'unknown' } ]
  expect(invalid).toHaveLength(4)
  for (const target of invalid) expect(() => parseAgentMuxControlRequest(request(target))).toThrow()
  expect(() => parseAgentMuxControlRequest({ ...request({ kind: 'surface', surface: 'space', view: 'map' }), inputPolicy: 'target' })).toThrow()
  expect(agentMuxCommandHelp('app.focus')).toContain('--view workbench|map')
  const result = await cli(['app', '--skill'], directory)
  expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain('app focus --surface space --view map')
  expect(result.stdout).toContain('selection.spaceView')
})
