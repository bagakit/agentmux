import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxControlServer, parseAgentMuxControlRequest, parseAgentMuxControlReceipt } from '../src/control-host.js'
import type { AgentMuxControlFocusRequest, AgentMuxControlRequest } from '../src/control.js'
import { focusFacts } from './fixtures/desktop-focus-facts.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
const loader = new URL('../../../apps/desktop/scripts/fixtures/desktop-map/source-loader.mjs', import.meta.url)
let directory: string, server: AgentMuxControlServer, seen: AgentMuxControlRequest[]
const target = { kind: 'focus-agent', hostId: 'original-host', agentSessionId: 'original-agent' } as const
const request = () => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'focus-agent-navigation', operation: 'focus', target, inputPolicy: 'preserve' }) as AgentMuxControlFocusRequest
const cli = (args: string[]) => runSourceObjectCli(['app', 'focus', ...args], objectCliEnvironment(directory, { NODE_NO_WARNINGS: '1', ...Object.fromEntries(['AGENTMUX_DESKTOP_MAP_LOADED'].filter(name => process.env[name]).map(name => [name, process.env[name]])) }), '', 15000, loader)
beforeEach(async () => {
 directory = await mkdtemp(join(tmpdir(), 'focus-agent-')); seen = []
 server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), coreClients: () => [], execute: async input => { seen.push(input); if (input.operation === 'focus') return focusFacts(input); throw Error('Only focus is authorized') } }); await server.start()
})
afterEach(async () => { await server.stop(); await rm(directory, { recursive: true }) })
it('routes the actual source CLI exact Focus target without deriving a Host or transferring input', async () => {
 const result = await cli(['--surface', 'focus', '--host', target.hostId, '--session', target.agentSessionId])
 expect(result.code, result.stderr).toBe(1)
 expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation: 'app.focus', result: { navigation: { requested: target, state: 'unconfirmed', selection: { surface: 'focus', focusView: 'list' } }, focus: { agent: { hostId: target.hostId, agentSessionId: target.agentSessionId, state: 'unconfirmed' } }, partial: true } })
 expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ operation: 'focus', target, inputPolicy: 'preserve' })
}, 20000)
it('rejects incompatible exact Agent CLI targets before any client executes', async () => {
 const invalid = [ ['--surface','focus','--host','H'], ['--surface','focus','--session','SID'], ['--surface','space','--host','H','--session','SID'], ['--surface','focus','--host','H','--session','SID','--view','map'], ['--surface','focus','--host','H','--session','SID','--input','target'] ]
 for (const args of invalid) { const result = await cli(args); expect(result.code).toBe(1); expect(JSON.parse(result.stdout || result.stderr)).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^INVALID_(CONTROL_REQUEST|CLI_ARGUMENT)$/u) } }) }
 expect(seen).toEqual([])
}, 60000)
it('rejects receipts that only selected Focus or mismatched the visible exact Agent', () => {
 const input = request(), { operation, ...body } = focusFacts(input)
 const receipt = { schemaVersion: 5, requestId: input.requestId, operation, ok: true, result: { ...body,
  navigation: { ...body.navigation, state: 'applied' }, presentation: { ...body.presentation, provenance: 'observed', state: 'main-visible' },
  focus: { ...body.focus, agent: { hostId: target.hostId, agentSessionId: target.agentSessionId, presentationSessionId: 'original-presentation', state: 'visible' } } } }
 expect(() => parseAgentMuxControlReceipt(receipt)).not.toThrow()
 for (const agent of [null, { ...receipt.result.focus.agent, hostId: 'another-host' }, { ...receipt.result.focus.agent, agentSessionId: 'another-agent' }, { ...receipt.result.focus.agent, state: 'hidden' }, { ...receipt.result.focus.agent, presentationSessionId: null }]) {
  expect(() => parseAgentMuxControlReceipt({ ...receipt, result: { ...receipt.result, focus: { ...receipt.result.focus, agent } } })).toThrow()
 }
 expect(() => parseAgentMuxControlReceipt({ ...receipt, result: { ...receipt.result, navigation: { ...receipt.result.navigation, selection: { ...body.navigation.selection, focusView: 'map' } } } })).toThrow()
})
