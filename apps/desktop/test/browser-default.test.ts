import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, parseBrowserDefaultInspection } from '@agentmux/core'
import { inspectDefaultBrowser, openDefaultBrowserSettings, executeBrowserDefaultControl, type BrowserDefaultPort } from '../src/main/browser-default'

const native = vi.hoisted(() => ({ handler: vi.fn(), matches: vi.fn(), open: vi.fn() }))
vi.mock('electron', () => ({ app: { getApplicationInfoForProtocol: native.handler, isDefaultProtocolClient: native.matches } }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: (...args: unknown[]) => {
  native.open(args[0], args[1]); (args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void)(null, '', '')
} }))

beforeEach(() => { native.handler.mockReset().mockResolvedValue({ name: 'Other browser', path: join(tmpdir(), 'other-browser.app') }); native.matches.mockReset().mockReturnValue(false); native.open.mockReset() })
const application = { name: 'A browser', path: join(tmpdir(), 'browser.app') }
function port(http = false, https = false): BrowserDefaultPort {
  return { platform: 'darwin', handler: async scheme => ({ isCurrentApplication: scheme === 'http' ? http : https, application }), openSettings: vi.fn(async () => {}) }
}

describe('default browser facts and explicit system handoff', () => {
  it.each([[true, true, 'default'], [false, false, 'not-default'], [true, false, 'partial'], [false, true, 'partial']] as const)('reads both exact native protocols %s/%s as %s', async (http, https, outcome) => {
    const facts = await inspectDefaultBrowser(port(http, https))
    expect(facts).toEqual({ platform: 'darwin', outcome, protocols: {
      http: { state: 'known', isCurrentApplication: http, application }, https: { state: 'known', isCurrentApplication: https, application }
    } })
    expect(parseBrowserDefaultInspection(facts)).toEqual(facts)
  })
  it('keeps an observation failure unknown and the independent settings request usable', async () => {
    const p = port(true, true); p.handler = async scheme => { if (scheme === 'http') throw Object.assign(new Error('Original OS lookup failed'), { code: 'LOOKUP_FAILED' }); return { isCurrentApplication: true, application } }
    expect(await inspectDefaultBrowser(p)).toMatchObject({ outcome: 'unknown', protocols: { http: { state: 'unknown', cause: { code: 'LOOKUP_FAILED', message: 'Original OS lookup failed' } }, https: { state: 'known' } } })
    expect(await openDefaultBrowserSettings(p)).toEqual({ requested: true, target: 'default-web-browser', platform: 'darwin' })
    expect(p.openSettings).toHaveBeenCalledTimes(1)
  })
  it('does not claim a default after a request, and returns actual action failure', async () => {
    const p = port(); await openDefaultBrowserSettings(p)
    expect((await inspectDefaultBrowser(p)).outcome).toBe('not-default')
    p.openSettings = async () => { throw new Error('Original system launch failed') }
    await expect(openDefaultBrowserSettings(p)).rejects.toThrow('Original system launch failed')
  })
  it('reports unsupported platforms without pretending to query or set their defaults', async () => {
    const p = port(); p.platform = 'unsupported-host'; p.handler = vi.fn(p.handler)
    expect(await inspectDefaultBrowser(p)).toEqual({ platform: 'unsupported-host', outcome: 'unsupported', protocols: null })
    await expect(openDefaultBrowserSettings(p)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(p.handler).not.toHaveBeenCalled(); expect(p.openSettings).not.toHaveBeenCalled()
  })
  it('rejects contradictory or hidden OS facts at the public codec', () => {
    const known = { state: 'known', isCurrentApplication: false, application }
    expect(() => parseBrowserDefaultInspection({ platform: 'darwin', outcome: 'default', protocols: { http: known, https: known } })).toThrow()
    expect(() => parseBrowserDefaultInspection({ platform: 'darwin', outcome: 'not-default', protocols: { http: { ...known, secretlySet: true }, https: known } })).toThrow()
  })
})

it('real Core SDK and built CLI consume the same native inspection and explicit request owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-browser-default-'))
  const server = new AgentMuxControlServer({ coreClients: () => [], execute: async request => {
    if (request.operation !== 'settings.browser.default.inspect' && request.operation !== 'settings.browser.default.open-settings') throw new Error('Unexpected operation')
    return executeBrowserDefaultControl(request)
  } }, join(root, 'control.sock'))
  await server.start()
  try {
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    try {
      expect(await rpc.call('settings.browser-default.inspect', {})).toMatchObject({ outcome: 'not-default', protocols: { http: { isCurrentApplication: false }, https: { isCurrentApplication: false } } })
      expect(await rpc.call('settings.browser-default.open-settings', {})).toEqual({ requested: true, target: 'default-web-browser', platform: process.platform })
    } finally { await rpc.dispose() }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/.test(key)))
    Object.assign(env, { AGENTMUX_RPC_ENDPOINT: `unix:${server.path}`, AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state') })
    async function cli(action: string) {
      return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [join(import.meta.dirname, '../../../packages/core/bin/amux'), 'settings', 'browser-default', action], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''
        child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
        child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }))
      })
    }
    const inspection = await cli('inspect'); expect(inspection.code, inspection.stderr).toBe(0); expect(JSON.parse(inspection.stdout).result).toMatchObject({ outcome: 'not-default' })
    const request = await cli('open-settings'); expect(request.code, request.stderr).toBe(0); expect(JSON.parse(request.stdout).result).toMatchObject({ requested: true, target: 'default-web-browser' })
    expect(native.handler.mock.calls.map(([url]) => url)).toEqual(['http://', 'https://', 'http://', 'https://'])
    expect(native.open.mock.calls).toEqual([['/usr/bin/open', ['-b', 'com.apple.systempreferences']], ['/usr/bin/open', ['-b', 'com.apple.systempreferences']]])
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
}, 15000)
