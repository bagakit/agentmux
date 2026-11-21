import { act } from 'react'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { connectionLinkUrl, connectionOfferUrl, type ConnectionOffer } from '@agentmux/relay/offer'
import { meshDevicePartition } from '../src/main/mesh-device-partition'
import { readMeshDeviceLink } from '../src/shared/mesh-device-link'
import { MeshDeviceAccess } from '../src/renderer/src/components/settings/MeshDeviceAccess'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const original: ConnectionOffer = { v: 2, serverId: 'device-original', daemonPublicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  relay: { endpoint: 'localhost:4123', useTls: false } }
const newKey = { ...original, daemonPublicKeyB64: Buffer.alloc(32, 2).toString('base64') }
const secondPath = { ...original, relay: { endpoint: 'localhost:4124', useTls: false } }
const link = (offer: ConnectionOffer) => connectionOfferUrl('http://' + offer.relay.endpoint + '/', offer)
const dom = composerDOM()
let dispose: (() => void) | undefined
beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => dispose?.())

it('pastes and previews the exact device before opening its workspace', async () => {
  useAppStore.setState({ meshDeviceLinks: { saved: [], draft: '' } })
  const clipboard = vi.spyOn(api.ui, 'readClipboardText').mockResolvedValue(link(original))
  const open = vi.spyOn(api.ui, 'openMeshDevice').mockResolvedValue(undefined)
  await dom.render(<MeshDeviceAccess />)
  await dom.click('.mesh-recovery-actions button')
  expect(clipboard).toHaveBeenCalledOnce()
  expect(dom.container.querySelector('.mesh-network-note')?.textContent).toContain(original.serverId)
  expect(open).not.toHaveBeenCalled()
  await dom.click('.mesh-recovery-actions button')
  expect(open).toHaveBeenCalledExactlyOnceWith(link(original))
  expect(dom.container.textContent).toContain('If its window asks for approval')
})

it('retains credentials across original routes and isolates changed endpoint keys', () => {
  expect(meshDevicePartition(original)).toBe(meshDevicePartition(secondPath))
  expect(meshDevicePartition(original)).not.toBe(meshDevicePartition(newKey))
  expect(meshDevicePartition(original)).not.toBe(meshDevicePartition({ ...original, serverId: 'foreign-device' }))
})

it('accepts only a complete original endpoint offer at the selected gateway', () => {
  expect(readMeshDeviceLink(link(original))).toEqual({ url: link(original), offer: original })
  expect(() => readMeshDeviceLink(connectionLinkUrl('http://localhost:4123/', original))).toThrow()
  expect(() => readMeshDeviceLink(connectionOfferUrl('http://localhost:4124/', original))).toThrow()
  expect(() => readMeshDeviceLink('http://localhost:4123/')).toThrow()
})

it('opens the chosen path and requires explicit pairing before using a replacement key', async () => {
  useAppStore.setState({ meshDeviceLinks: { saved: [link(original)], draft: link(newKey) } })
  const open = vi.spyOn(api.ui, 'openMeshDevice').mockResolvedValue(undefined)
  const click = async (text: string) => {
    const button = Array.from(dom.container.querySelectorAll('button')).find(item => item.textContent === text)
    expect(button?.disabled).toBe(false)
    await act(async () => button!.click())
  }
  try {
    await dom.render(<MeshDeviceAccess />)
    await click('Open device workspace')
    expect(open).not.toHaveBeenCalled()
    expect(useAppStore.getState().meshDeviceLinks.draft).toBe(link(newKey))
    await click('Pair as a separate identity')
    expect(open).toHaveBeenCalledWith(link(newKey))
    expect(useAppStore.getState().meshDeviceLinks.saved).toEqual([link(original), link(newKey)])
    await act(async () => useAppStore.setState({ meshDeviceLinks: { saved: [link(original)], draft: link(secondPath) } }))
    await click('Open device workspace')
    expect(open).toHaveBeenLastCalledWith(link(secondPath))
    expect(useAppStore.getState().meshDeviceLinks).toEqual({ saved: [link(original), link(secondPath)], draft: '' })
  } finally { open.mockRestore() }
})
