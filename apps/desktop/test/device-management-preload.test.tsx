const { fixturePath: _hygiene_fixturePath, fixtureTime: _hygiene_fixtureTime } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxControlServer, AgentMuxError, type AgentMuxRpcResult, type AgentMuxRpcDeviceResult } from '@agentmux/core'
import { registerDeviceManagementIpc } from '../src/main/device-management-ipc'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn(), on: vi.fn(), off: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke, on: bridge.on, off: bridge.off }, webFrame: {},
  app: { getPath: () => _hygiene_fixturePath("tmp/amx-device-config") } }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.unstubAllGlobals(); vi.resetModules() })

it('mounts the original settings through Renderer API, preload, trusted IPC and the sole Unix dispatcher', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  const directory = await mkdtemp(join(tmpdir(), 'amx-device-preload-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const calls: string[] = []
  let readUnavailable = false
  const original: AgentMuxRpcResult<'device.ls'> = { hostId: 'original-host', devices: [], requests: [],
    privateAccess: { state: 'listening', message: 'The selected listener is active.',
      origin: 'https://192.168.1.20:1443', issuerHostId: 'original-host',
      certificateFingerprint: Array(32).fill('A2').join(':'), expiresAt: _hygiene_fixtureTime(232774400000) } }
  // Controlled device facts, real public service/client. No Authority mutation or OS dialog.
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'rpc.sock'), coreClients: () => [],
    deviceAdministration: { async call(method) {
      calls.push(method)
      if (readUnavailable) throw new AgentMuxError('The original read is unavailable.', 'CONTROL_UNAVAILABLE')
      if (method !== 'device.ls') throw new AgentMuxError('Only an explicit read was expected.', 'INVALID_CONTROL_REQUEST')
      return original as AgentMuxRpcDeviceResult<typeof method>
    } } })
  await server.start(); cleanup.push(() => server.stop())
  const sender = {}, handlers = new Map<string, (event: never, input: unknown) => Promise<unknown>>()
  registerDeviceManagementIpc({ socketPath: join(directory, 'rpc.sock'),
    handleWithEvent: (channel, handler) => handlers.set(channel, handler),
    assertTrusted: (_channel, event) => { expect(event.sender).toBe(sender) } })
  const clipboard: string[] = []
  const reads: Promise<unknown>[] = []
  bridge.invoke.mockImplementation(async (channel: string, input: unknown) => {
    if (channel === 'ui:writeClipboardText') { clipboard.push(String(input)); return }
    const handler = handlers.get(channel); expect(handler, `Registered exact preload channel ${channel}`).toBeDefined()
    const result = handler!({ sender } as never, input); reads.push(result)
    return await result
  })
  bridge.expose.mockImplementation((name, value) => { expect(name).toBe('agentmux'); window.agentmux = value })
  await import('../src/preload/index')
  expect(bridge.expose).toHaveBeenCalledOnce()
  const { HostSettingsPane } = await import('../src/renderer/src/components/settings/HostSettingsPane')
  const { DEFAULT_CONFIG } = await import('../src/main/config-store')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  cleanup.push(async () => { await act(async () => root.unmount()); container.remove(); delete (window as Partial<Window>).agentmux })
  await act(async () => root.render(<HostSettingsPane active config={DEFAULT_CONFIG} onSave={vi.fn()} />))
  await act(async () => {
    await vi.waitFor(() => expect(reads).toHaveLength(1)); await Promise.allSettled(reads)
  })
  const address = () => container.querySelector<HTMLInputElement>('[aria-label="Mac 的 HTTPS 地址"]')?.value
  expect(address()).toBe('https://192.168.1.20:1443')
  expect(calls).toEqual(['device.ls'])
  const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!
  await act(async () => button('复制 HTTPS 地址').click())
  expect(clipboard).toEqual(['https://192.168.1.20:1443']); expect(calls).toEqual(['device.ls'])
  readUnavailable = true
  await act(async () => {
    button('刷新设备状态').click()
    await vi.waitFor(() => expect(reads).toHaveLength(2)); await Promise.allSettled(reads)
  })
  expect(container.textContent).toContain('原结果保留')
  expect(await reads[1]!.catch((error: AgentMuxError) => error.code)).toBe('CONTROL_UNAVAILABLE')
  expect(container.textContent).toContain('The original read is unavailable.')
  expect(address()).toBe('https://192.168.1.20:1443')
  expect(container.textContent).toContain('上次读取的接入事实')
  expect(calls).toEqual(['device.ls', 'device.ls'])
  expect(bridge.invoke.mock.calls.every(([channel]) => channel === 'deviceManagement:ls' || channel === 'ui:writeClipboardText')).toBe(true)
  readUnavailable = false
  await act(async () => {
    button('刷新设备状态').click()
    await vi.waitFor(() => expect(reads).toHaveLength(3)); await Promise.allSettled(reads)
  })
  expect(calls).toEqual(['device.ls', 'device.ls', 'device.ls'])
  expect(container.textContent).not.toContain('设备列表尚未核实')
  expect(container.textContent).not.toContain('当前接入状态未重新核实')
  expect(container.textContent).not.toContain('The original read is unavailable.')
  expect(container.textContent).toContain('HTTPS 地址已复制')
})
