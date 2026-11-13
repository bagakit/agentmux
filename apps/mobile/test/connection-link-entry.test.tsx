// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectionOfferUrl } from '@agentmux/relay/offer'
import { generateKeyPair } from '@agentmux/relay/e2ee'
import type { MobileConnection } from '../src/conversation/use-hosted-conversation'

const ports = vi.hoisted(() => ({ connect: vi.fn(), roots: [] as Root[], observation: null as MobileConnection | null }))
vi.mock('@agentmux/core/relay-hosted', () => ({ connectRelayHostedClient: ports.connect }))
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: async () => generateKeyPair() }))
vi.mock('../src/platform/native/device', () => ({ createNativePlatform: () => { throw new Error('The Web entry must use its browser platform') } }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }))
vi.mock('react-dom/client', async original => {
  const actual = await original<typeof import('react-dom/client')>()
  return { ...actual, createRoot: (...args: Parameters<typeof actual.createRoot>) => {
    const root = actual.createRoot(...args); ports.roots.push(root); return root
  } }
})
vi.mock('../src/MobileApp', () => ({ MobileApp: ({ connection }: { connection: MobileConnection }) => {
  ports.observation = connection
  return <main data-connection={connection.state}>{connection.message}</main>
} }))

beforeEach(() => { vi.resetModules(); globalThis.IS_REACT_ACT_ENVIRONMENT = true })

afterEach(async () => {
  await act(async () => { for (const root of ports.roots.splice(0)) root.unmount() })
  document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/')
  ports.connect.mockReset(); ports.observation = null
})

it('the actual Web entry refuses a damaged new link without falling through to its saved Mac or altering the backup', async () => {
  document.body.innerHTML = '<div id="root"></div><div id="mobile-overlays"></div>'
  const saved = { v: 2 as const, serverId: 'saved-host', daemonPublicKeyB64: 'A'.repeat(43) + '=', relay: { endpoint: '127.0.0.1:9999', useTls: false } }
  const incoming = { ...saved, serverId: 'incoming-host' }
  const originalBackup = JSON.stringify(saved)
  localStorage.setItem('agentmux.connection-offer.v2', originalBackup)
  const intact = connectionOfferUrl(location.origin + '/', incoming)
  const damaged = intact.slice(0, intact.indexOf('#') + 21)
  history.replaceState(null, '', damaged)
  // The Host connection port is controlled; startup parsing, state selection and rendering are real.
  ports.connect.mockImplementation(() => new Promise(() => {}))
  await act(async () => { await import('../src/main') })
  expect(ports.observation).toMatchObject({ state: 'unavailable', message: '连接链接无法读取，请在 Mac 重新复制完整链接。' })
  expect(document.querySelector('main')?.textContent).toContain('连接链接无法读取')
  expect(ports.connect).not.toHaveBeenCalled()
  expect(localStorage.getItem('agentmux.connection-offer.v2')).toBe(originalBackup)
  expect(location.hash).toBe(new URL(damaged).hash)
})

it.runIf(Boolean(process.env.AGENTMUX_TEST_MOBILE_LINK_HANDOFF))('the actual Web entry consumes the same Host link proven through the actual CLI Relay endpoint', async () => {
  const handoff = JSON.parse(readFileSync(process.env.AGENTMUX_TEST_MOBILE_LINK_HANDOFF!, 'utf8'))
  expect(handoff.offer.serverId).toBe(handoff.hostId)
  document.body.innerHTML = '<div id="root"></div><div id="mobile-overlays"></div>'
  location.href = handoff.url
  ports.connect.mockImplementation(() => new Promise(() => {}))
  await act(async () => { await import('../src/main') })
  await vi.waitFor(() => expect(ports.connect).toHaveBeenCalledOnce())
  expect(ports.connect.mock.calls[0]![0].offer).toEqual(handoff.offer)
  expect(JSON.parse(localStorage.getItem('agentmux.connection-offer.v2')!)).toEqual(handoff.offer)
  expect(location.hash).toBe('')
})
