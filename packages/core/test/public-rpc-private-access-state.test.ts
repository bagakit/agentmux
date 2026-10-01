import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterEach, expect, it } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentMuxRpcPrivateAccessState, type AgentMuxRpcPrivateAccessState,
  type AgentMuxRpcDeviceAdministration } from '../src/public-rpc-device.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const hostId = 'original-authority-host'
const fingerprint = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':')
const locator = { executable: upstreamFixturePath("Applications/Agent's Tools/Node `$()`"), entry: upstreamFixturePath("Applications/Agent's Tools/prepare-private-access.js"), electronRunAsNode: true }
const listening = { state: 'listening', message: 'Original private listener is serving.', origin: 'https://127.0.0.1:9443',
  issuerHostId: hostId, certificateFingerprint: fingerprint, expiresAt: 100, configurationPath: upstreamFixturePath("configuration/private-host.json"),
  certificatePreparation: locator, mobileBuildDigest: 'original-build-digest', assetIssue: 'Phone assets are currently unavailable.' } satisfies AgentMuxRpcPrivateAccessState
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-private-state-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  let response: unknown
  const calls: Array<{ method: string; params: unknown }> = []
  const owner: AgentMuxRpcDeviceAdministration = { call: (async (method, params) => {
    calls.push({ method, params }); return response
  }) as AgentMuxRpcDeviceAdministration['call'] }
  const path = join(directory, 'service.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [], deviceAdministration: owner })
  await server.start(); cleanups.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  cleanups.push(() => client.dispose())
  return { directory, path, calls, client, set(value: unknown) { response = value } }
}
function result(privateAccess: unknown) { return { hostId, devices: [], requests: [], privateAccess } }

/** Actual public Unix dispatcher/SDK/compiled CLI, with a controlled finite callback.
 * This does not stand in for the original Host getter, OS approval or Phone evidence. */
it('preserves three private access states and optional locators through the actual Unix service, SDK and compiled CLI', async () => {
  const f = await fixture()
  const states: readonly AgentMuxRpcPrivateAccessState[] = [
    { state: 'unconfigured', message: 'No manifest was selected.' },
    { state: 'unavailable', message: 'The original manifest could not be read.', configurationPath: upstreamFixturePath("configuration/missing.json"),
      certificatePreparation: { ...locator, electronRunAsNode: false } }, listening
  ]
  expect(states).toHaveLength(3)
  for (const state of states) {
    f.set(result(state))
    expect(await f.client.call('device.ls', {})).toEqual(result(state))
    const cli = await runCompiledObjectCli(['--endpoint', `unix:${f.path}`, 'device', 'ls'], objectCliEnvironment(f.directory))
    expect(cli.code, cli.stderr).toBe(0); expect(cli.stderr).toBe('')
    expect(JSON.parse(cli.stdout)).toEqual({ ok: true, operation: 'device.ls', result: result(state) })
  }
  expect(f.calls).toEqual(states.flatMap(() => [{ method: 'device.ls', params: {} }, { method: 'device.ls', params: {} }]))
  expect(parseAgentMuxRpcPrivateAccessState({ ...listening, origin: 'https://[::1]:9443', expiresAt: 0,
    configurationPath: '/' + 'a'.repeat(4095), certificatePreparation: { ...locator, electronRunAsNode: false } }, hostId)).toMatchObject({ expiresAt: 0 })
})

it('requires privateAccess without admitting the old result or defaults and leaves subsequent healthy reads usable', async () => {
  const f = await fixture(); f.set({ hostId, devices: [], requests: [] })
  await expect(f.client.call('device.ls', {})).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  f.set(result({ state: 'unavailable', message: 'Getter is unconfirmed.' }))
  expect(await f.client.call('device.ls', {})).toEqual(result({ state: 'unavailable', message: 'Getter is unconfirmed.' }))
  expect(f.calls).toEqual([{ method: 'device.ls', params: {} }, { method: 'device.ls', params: {} }])
})

it('rejects another issuer instead of borrowing Runtime identity and restores an exact original issuer read', async () => {
  const f = await fixture(); f.set(result({ ...listening, issuerHostId: 'foreign-runtime-host' }))
  await expect(f.client.call('device.ls', {})).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  f.set(result(listening)); expect(await f.client.call('device.ls', {})).toEqual(result(listening))
  expect(f.calls).toHaveLength(2)
})

it('rejects malformed certificate preparation blocks without invoking or guessing an executable', async () => {
  const f = await fixture()
  const locators = [null, {}, { ...locator, electronRunAsNode: 'true' }, { ...locator, electronRunAsNode: 1 },
    { ...locator, executable: 'node' }, { ...locator, entry: '../prepare-private-access.js' },
    { ...locator, executable: '' }, { ...locator, entry: upstreamFixturePath("bad entry") }, { ...locator, entry: upstreamFixturePath("bad entry") },
    { ...locator, entry: upstreamFixturePath("bad\u0000entry") }, { ...locator, executable: upstreamFixturePath("bad\nnode") }, { ...locator, executable: upstreamFixturePath("bad\rnode") },
    { ...locator, entry: '/' + 'a'.repeat(4096) }, { ...locator, entry: '/' + '界'.repeat(1366) },
    { ...locator, env: { ELECTRON_RUN_AS_NODE: '1' } }, { ...locator, shell: true }, { ...locator, args: [] }]
  expect(locators).toHaveLength(17)
  for (const certificatePreparation of locators) {
    f.set(result({ ...listening, certificatePreparation }))
    await expect(f.client.call('device.ls', {})).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  }
  f.set(result({ state: 'unavailable', message: 'Helper artifact is unconfirmed.' }))
  expect(await f.client.call('device.ls', {})).toEqual(result({ state: 'unavailable', message: 'Helper artifact is unconfirmed.' }))
  expect(f.calls).toHaveLength(locators.length + 1)
})

it('rejects extra secrets, non-origin URLs and invalid original certificate facts with typed errors', async () => {
  const f = await fixture()
  const invalid = [null, {}, { state: 'unknown', message: 'Unknown' }, { state: 'unavailable' },
    { state: 'unconfigured', message: '' }, { state: 'unavailable', message: '   ' },
    { ...listening, credential: 'fixture-secret' }, { ...listening, privateKey: 'fixture-secret' },
    { state: 'unconfigured', message: 'Unused', origin: listening.origin },
    ...['http://127.0.0.1:9443', 'https://user:password@127.0.0.1:9443', 'https://127.0.0.1:9443/path',
      'https://127.0.0.1:9443/?secret=fixture-secret', 'https://127.0.0.1:9443/#fragment', 'https://127.0.0.1:9443/',
      'https://127.0.0.1:9443?', ' https://127.0.0.1:9443', 'not-an-origin'].map(origin => ({ ...listening, origin })),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', null].map(expiresAt => ({ ...listening, expiresAt })),
    ...['', 'AA:BB', 'A'.repeat(64), 'GG:' + fingerprint.slice(3)].map(certificateFingerprint => ({ ...listening, certificateFingerprint })),
    ...['relative.json', '', upstreamFixturePath("bad\u0000path"), upstreamFixturePath("bad\tpath"), upstreamFixturePath("badpath"), upstreamFixturePath("bad path"), '/' + 'a'.repeat(4096)].map(configurationPath => ({ ...listening, configurationPath })),
    { ...listening, mobileBuildDigest: 4 }, { ...listening, assetIssue: '' }
  ]
  expect(invalid.length).toBeGreaterThan(30)
  for (const privateAccess of invalid) {
    f.set(result(privateAccess)); await expect(f.client.call('device.ls', {})).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  }
  expect(f.calls).toHaveLength(invalid.length)
})

it('keeps the existing four sibling results and every parameter tuple unchanged', async () => {
  const f = await fixture(), device = { deviceId: 'original-device', name: 'Original', createdAt: 7 }
  const siblings = [
    ['device.invite', {}, { hostId, invitation: 'original-invitation', expiresAt: 100 }],
    ['device.approve', { deviceId: device.deviceId, confirmationCode: '012345' }, { hostId, device }],
    ['device.reject', { deviceId: device.deviceId }, { hostId, deviceId: device.deviceId, state: 'denied' }],
    ['device.revoke', { deviceId: device.deviceId }, { hostId, device: { ...device, revokedAt: 10 } }]
  ] as const
  expect(siblings).toHaveLength(4)
  for (const [method, params, response] of siblings) {
    f.set(response); expect(await f.client.call(method, params)).toEqual(response)
  }
  expect(f.calls).toEqual(siblings.map(([method, params]) => ({ method, params })))
  await expect(f.client.call('device.ls', { privateAccess: listening } as unknown as Record<string, never>)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.calls).toHaveLength(4)
})

it('bundles the real browser HTTP entry and sole parser without Node, Host or Runtime modules', async () => {
  const bundled = await build({ entryPoints: [join(import.meta.dirname, '../dist/public-rpc-http.js')], bundle: true,
    platform: 'browser', format: 'esm', write: false, metafile: true })
  const inputs = Object.keys(bundled.metafile!.inputs)
  expect(inputs.length).toBeGreaterThan(0)
  expect(inputs.filter(path => path.endsWith('/public-rpc-device.js'))).toHaveLength(1)
  expect(inputs.filter(path => path.includes('ctxmux-run-adapter') || path.includes('/public-rpc-server.') || path.startsWith('node:'))).toEqual([])
  expect(bundled.outputFiles).toHaveLength(1)
  const browser = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.contents).toString('base64')}`)
  expect(browser.parseAgentMuxRpcPrivateAccessState(listening, hostId)).toEqual(listening)
  expect(() => browser.parseAgentMuxRpcPrivateAccessState({ ...listening, issuerHostId: 'foreign' }, hostId)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})
