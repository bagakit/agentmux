import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { generateKeyPair, exportPublicKey } from '@agentmux/relay/e2ee'
import { MobileConnectionRoot } from '../src/connection/MobileConnectionRoot'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { mount, mounted } from './conversation-fixture'

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }))
// The connection collaborator is controlled here. Actual compiled SDK / real
// WS / E2EE error production is exercised by relay/test/admission-authority.
vi.mock('@agentmux/core/relay-hosted', async importOriginal => ({ ...await importOriginal<object>(), connectRelayHostedClient: connect }))
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: async () => generateKeyPair() }))
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); connect.mockReset() })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; vi.useRealTimers() })
async function surface(code: 'CONTROL_UNAVAILABLE' | 'AGENT_CAPABILITY_INVALID') {
  connect.mockRejectedValue(new AgentMuxError('Private connection outcome', code))
  const offer = { v: 2 as const, serverId: 'private-authority', daemonPublicKeyB64: exportPublicKey(generateKeyPair().publicKey), relay: { endpoint: '127.0.0.1:9999', useTls: false } }
  return await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} offer={offer} />)
}
it('the actual mounted connection root retries unavailable observation without asserting revocation', async () => {
  vi.useFakeTimers()
  const view = await surface('CONTROL_UNAVAILABLE')
  expect(connect).toHaveBeenCalledTimes(1)
  expect(view.element.textContent).toContain('自动重试')
  expect(view.element.textContent).not.toContain('已撤销')
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(connect).toHaveBeenCalledTimes(2)
})
it('an explicit Host capability rejection stops this attempt and requests authorization confirmation', async () => {
  vi.useFakeTimers()
  const view = await surface('AGENT_CAPABILITY_INVALID')
  expect(connect).toHaveBeenCalledTimes(1)
  expect(view.element.textContent).toContain('授权未通过确认')
  expect(view.element.textContent).not.toContain('已撤销')
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(connect).toHaveBeenCalledTimes(1)
})
