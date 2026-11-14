import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, exportPublicKey } from '@agentmux/relay/e2ee'
import { MobileConnectionRoot } from '../src/connection/MobileConnectionRoot'
import type { MobileConnection } from '../src/conversation/use-hosted-conversation'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { mount, mounted } from './conversation-fixture'

// The connection collaborator and the app surface are controlled here, so the case reads the exact
// connection state the root hands to MobileApp. Real relay admission is covered by relay tests.
const ports = vi.hoisted(() => ({ connect: vi.fn(), observation: null as MobileConnection | null }))
vi.mock('@agentmux/core/relay-hosted', async importOriginal => ({ ...await importOriginal<object>(), connectRelayHostedClient: ports.connect }))
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: async () => generateKeyPair() }))
vi.mock('../src/MobileApp', () => ({ MobileApp: ({ connection, connectionPanel }: { connection: MobileConnection; connectionPanel: ReactNode }) => {
  ports.observation = connection
  return <main data-connection={connection.state}><p>{connection.message}</p>{connection.issue && <p>{connection.issue}</p>}{connectionPanel}</main>
} }))
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); ports.connect.mockReset(); ports.observation = null })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() } })
const linkFor = (serverId: string) => ({ v: 2 as const, serverId, daemonPublicKeyB64: exportPublicKey(generateKeyPair().publicKey), relay: { endpoint: '127.0.0.1:9999', useTls: false } })

describe('the saved connection link', () => {
  it('marks a confirmed missing link as unpaired without offering a connection retry', async () => {
    const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} />)
    expect(ports.observation).toMatchObject({ state: 'unavailable', paired: false })
    expect(view.element.querySelector('button')).toBeNull()
    expect(ports.connect).not.toHaveBeenCalled()
  })
  it('keeps pairing unknown and a retry available when the saved link cannot be read', async () => {
    localStorage.setItem('agentmux.connection-offer.v2', '{unreadable')
    const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} />)
    expect(ports.observation).toMatchObject({ state: 'unavailable', message: expect.stringContaining('Mac 连接记录无法完整读取') })
    expect(ports.observation?.paired).toBeUndefined()
    expect(view.element.querySelector('button')?.textContent).toBe('重新检查连接')
    expect(localStorage.getItem('agentmux.connection-offer.v2')).toBe('{unreadable')
    expect(ports.connect).not.toHaveBeenCalled()
  })
  it('connects through a verified link even when this device cannot save it, and says it was not saved', async () => {
    ports.connect.mockResolvedValue({ onEvent: () => () => {}, connect: async () => {}, dispose: async () => {} })
    const original = localStorage.setItem.bind(localStorage)
    const save = vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === 'agentmux.connection-offer.v2') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      original(key, value)
    })
    const offer = linkFor('original-host')
    await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} offer={offer} />)
    expect(save).toHaveBeenCalledWith('agentmux.connection-offer.v2', JSON.stringify(offer))
    await vi.waitFor(() => expect(ports.connect).toHaveBeenCalledTimes(1))
    expect(ports.connect.mock.calls[0]![0]).toMatchObject({ offer, sessions: 'summary' })
    await vi.waitFor(() => expect(ports.observation).toMatchObject({ state: 'connected', paired: true, issue: expect.stringContaining('连接链接没有保存到这台设备') }))
    expect(localStorage.getItem('agentmux.connection-offer.v2')).toBeNull()
  })
  it('still refuses a link for another Mac without connecting', async () => {
    await getDeviceWorkface().confirmHost({ origin: location.origin, hostId: 'original-host' })
    await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} offer={linkFor('another-host')} />)
    expect(ports.observation).toMatchObject({ state: 'unavailable', message: expect.stringContaining('链接属于另一台 Mac') })
    expect(ports.connect).not.toHaveBeenCalled()
  })
})
