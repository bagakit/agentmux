import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { parseAgentMuxRpcDeviceResult } from '../../../packages/core/src/public-rpc-device'
import { DeviceManagementSettings } from '../src/renderer/src/components/settings/DeviceManagementSettings'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), fingerprint = `sha256:${'a1'.repeat(32)}`
const list = (): AgentMuxRpcResult<'device.ls'> => ({ hostId: 'original-host', mobileAccess: { state: 'connected', message: 'Ready' }, devices: [
  { deviceId: 'connected-id', name: 'My phone', createdAt: _reshape_fixtureEpoch(0, 0, 1_000), online: true, keyFingerprint: fingerprint,
    connection: { connectedAt: _reshape_fixtureEpoch(0, 0, 2_000), observedAt: _reshape_fixtureEpoch(0, 0, 3_000), address: '2001:db8:85a3::8a2e:370:7334', userAgent: 'Mobile browser; client-reported platform' },
    operations: [{ id: 'original-operation', method: 'submitAgentPrompt', target: 'Original Session', at: _reshape_fixtureEpoch(0, 0, 2_500), result: 'confirmed' }] },
  { deviceId: 'disconnected-id', name: 'My phone', createdAt: _reshape_fixtureEpoch(0, 0, 1_000), online: false,
    connection: { connectedAt: _reshape_fixtureEpoch(0, 0, 2_000), disconnectedAt: _reshape_fixtureEpoch(0, 0, 4_000), address: '192.0.2.24' } },
  { deviceId: 'unknown-id', name: 'Earlier device', createdAt: _reshape_fixtureEpoch(0, 0, 1_000) },
  { deviceId: 'revoked-id', name: 'Revoked device', createdAt: _reshape_fixtureEpoch(0, 0, 1_000), revokedAt: _reshape_fixtureEpoch(0, 0, 5_000), online: false }
] })
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }) })
async function mount() {
  const value = list(), read = vi.spyOn(api.deviceManagement, 'ls').mockImplementation(async () => parseAgentMuxRpcDeviceResult('device.ls', structuredClone(value), {}))
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const revoke = vi.spyOn(api.deviceManagement, 'revoke').mockResolvedValue({ hostId: value.hostId, device: { ...value.devices[0]!, revokedAt: _reshape_fixtureEpoch(0, 0, 6_000) } })
  await dom.render(<DeviceManagementSettings active />)
  return { value, read, clipboard, revoke }
}
const record = (id = 'connected-id') => dom.container.querySelector<HTMLDetailsElement>(`[data-device-record="${id}"]`)!
const records = () => dom.container.querySelector<HTMLDetailsElement>('[data-device-records]')!
async function click(label: string) {
  const node = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
  expect(node).toBeDefined(); await act(async () => node.click())
}
it('starts with folded device records and folded identities, separating true, false and unknown without business logs', async () => {
  const f = await mount()
  expect(records().open).toBe(false)
  expect(Array.from(dom.container.querySelectorAll<HTMLDetailsElement>('[data-device-record]')).map(n => n.open)).toEqual([false, false, false])
  expect(record().querySelector('summary')?.textContent).toContain('Connected')
  expect(record('disconnected-id').querySelector('summary')?.textContent).toContain('Disconnected')
  expect(record('unknown-id').querySelector('summary')?.textContent).toContain('Connection unconfirmed')
  expect(dom.container.textContent).not.toContain('Offline')
  expect(dom.container.textContent).not.toContain('Original Session')
  expect(dom.container.textContent).not.toContain('Send message')
  expect(dom.container.querySelector('[data-device-record="revoked-id"]')).toBeNull()
  expect(f.value.devices[0]!.operations).toHaveLength(1)
})
it('shows complete key, IPv6, source time and reported browser with original identity and only last connection times', async () => {
  await mount(); records().open = true; record().open = true
  const text = record().textContent!
  expect(text).toContain(fingerprint); expect(text).toContain('2001:db8:85a3::8a2e:370:7334')
  expect(text).toContain('Mobile browser; client-reported platform'); expect(text).toContain('Browser (reported)')
  expect(text).toContain('connected-id'); expect(text).toContain(new Date(_reshape_fixtureEpoch(0, 0, 3_000)).toLocaleString())
  expect(record('disconnected-id').querySelectorAll('.device-management__connection-record time')).toHaveLength(2)
  expect(record('unknown-id').textContent).toContain('Not yet confirmed')
  expect(record('unknown-id').textContent).toContain('No connection times recorded yet')
})
it('copies the full verified fingerprint without creating or refreshing a connection', async () => {
  const f = await mount(); records().open = true; record().open = true
  await click('Copy key fingerprint for My phone')
  expect(f.clipboard).toHaveBeenCalledExactlyOnceWith(fingerprint)
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(record().textContent).toContain('Key fingerprint copied')
})
it('keeps clipboard failure local to the original device with a full selectable value', async () => {
  const f = await mount(); f.clipboard.mockRejectedValue(new Error('Clipboard unavailable'))
  await click('Copy key fingerprint for My phone')
  expect(record().textContent).toContain('Select the full value below')
  expect(record().textContent).toContain(fingerprint)
  expect(dom.container.textContent).not.toContain('Device status is unavailable')
})
it('refresh preserves the same expanded device identity and retains its facts when the read is unavailable', async () => {
  const f = await mount(); records().open = true; record().open = true
  await click('Refresh'); expect(records().open).toBe(true); expect(record().open).toBe(true)
  f.read.mockRejectedValueOnce(new Error('Temporary observation gap'))
  await click('Refresh')
  expect(records().open).toBe(true); expect(record().open).toBe(true)
  expect(record().textContent).toContain(fingerprint)
  expect(dom.container.textContent).toContain('Previous records are kept')
})
it('revokes only the opened original device while preserving the connection and record controls', async () => {
  const f = await mount(); records().open = true; record().open = true
  const button = record().querySelector<HTMLButtonElement>('.device-management__record-body > button')!
  await act(async () => button.click())
  expect(f.revoke).toHaveBeenCalledExactlyOnceWith({ deviceId: 'connected-id' })
  expect(dom.container.textContent).toContain('Agent sessions are preserved')
  expect(records().open).toBe(true); expect(record().open).toBe(true)
})
