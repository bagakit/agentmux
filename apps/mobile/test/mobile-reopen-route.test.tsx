import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PMO_TEAMS_TOPIC_ID } from '@agentmux/core/mote-preferences'
import { MobileConnectionRoot } from '../src/connection/MobileConnectionRoot'
import { prepareReloadIdentity, reloadOfferIdentity } from '../src/connection/reload-identity'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import type { MobilePresentationRoute } from '../src/recovery/presentation-route'
import { createBrowserPlatform } from '../src/platform/browser'
import { button, click, fixture, mount, mounted } from './conversation-fixture'

const relay = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('@agentmux/core/relay-hosted', async original => ({ ...await original<object>(), connectRelayHostedClient: relay.connect }))
vi.mock('../src/connection/relay-identity', () => ({
  deviceRelayIdentity: async () => ({ publicKey: new Uint8Array(32).fill(2), secretKey: new Uint8Array(32).fill(7) }),
  existingDeviceRelayIdentity: async () => ({ publicKey: new Uint8Array(32).fill(2), secretKey: new Uint8Array(32).fill(7) })
}))
const identity = { publicKey: new Uint8Array(32).fill(2), secretKey: new Uint8Array(32).fill(7) }
const offer = { v: 2 as const, serverId: 'original-host', daemonPublicKeyB64: 'A'.repeat(43) + '=', relay: { endpoint: '127.0.0.1:1', useTls: false } }
const presentation = (showSession = false, showGoalWork = false): MobilePresentationRoute => ({
  primary: 'focus', showSession, showGoalWork, identity: null, profile: null
})
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/')
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); relay.connect.mockReset()
})

async function openSaved(route: MobilePresentationRoute, panel: 'conversation' | 'terminal', selectedSessionId: string | null, reopening = true) {
  const owner = getDeviceWorkface(), f = fixture()
  await owner.replaceBackup({ ...emptyDeviceWorkface(), host: { hostId: offer.serverId, origin: location.origin }, selectedSessionId, panel, presentation: route })
  const catalog = { spaces: [{ spaceId: 'main-mote', kind: 'mote', name: '原主 Mote', topicId: PMO_TEAMS_TOPIC_ID,
    hostId: offer.serverId, directoryPath: null, projectId: null }], zones: [], tabs: [], regions: [], bindings: [], locations: [],
    motePresentation: [{ spaceId: 'main-mote', content: null, conversation: null, quickMode: { status: 'saved', version: 'original-version',
      defaults: { conversation: { hostId: offer.serverId, sessionId: 'session-original', displayWorkspaceId: 'original-display', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' } } } }] }
  f.client.forwardRpc = vi.fn().mockImplementation(async method => method === 'space.ls' || method === 'space.inspect' ? { catalog }
    : method === 'goal.ls' ? { goals: [], unavailable: [] } : { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] })
  f.client.ensureAgentContinuity = vi.fn()
  Object.assign(f.client, { connect: vi.fn(async () => {}), dispose: vi.fn(async () => {}) })
  relay.connect.mockResolvedValue(f.client)
  localStorage.setItem('agentmux.connection-offer.v2', JSON.stringify(offer))
  if (reopening) prepareReloadIdentity(identity, reloadOfferIdentity(offer), owner.recordIdentity())
  history.replaceState(null, '', '/mobile/original-build/' + 'a'.repeat(64) + '/index.html' + (reopening ? '#amux-update' : ''))
  const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} />)
  await vi.waitFor(() => expect(view.element.querySelector('.mobile-app')?.getAttribute('data-connection')).toBe('connected'))
  return { ...f, ...view, owner }
}

it('resumes saved Focus after the verified handoff without letting default chat discovery replace it', async () => {
  const f = await openSaved(presentation(), 'conversation', null)
  await vi.waitFor(() => expect(f.element.querySelector('.mobile-app')?.getAttribute('data-page-header')).toBe('inline'))
  expect(f.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(true)
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
  expect(f.owner.snapshot().record.presentation).toMatchObject({ primary: 'focus', showSession: false, showGoalWork: false })
  expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

for (const mode of ['terminal', 'goal'] as const) it(`resumes the saved ${mode} workface after the verified handoff`, async () => {
  const f = await openSaved(presentation(true, mode === 'goal'), mode === 'terminal' ? 'terminal' : 'conversation', 'session-original')
  expect(f.element.querySelector(mode === 'terminal' ? '.mobile-terminal-panel' : '.mobile-goal-panel')?.hasAttribute('hidden')).toBe(false)
  expect(f.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(true)
  expect(f.owner.snapshot().record).toMatchObject({ selectedSessionId: 'session-original', panel: mode === 'terminal' ? 'terminal' : 'conversation',
    presentation: { showSession: true, showGoalWork: mode === 'goal' } })
  expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('resumes an open Profile and its original source reference without starting a default chat', async () => {
  const f = await openSaved({ ...presentation(), profile: { identity: { name: '原 Profile', project: '原项目' }, sourcePath: 'SOUL.md' } }, 'conversation', null)
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('原 Profile'))
  expect(f.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(true)
  expect(f.owner.snapshot().record.presentation?.profile?.sourcePath).toBe('SOUL.md')
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull(); expect(f.submit).not.toHaveBeenCalled()
})

it('keeps ordinary startup chat-first even when the saved directory and terminal route differ', async () => {
  const f = await openSaved(presentation(), 'terminal', null, false)
  await vi.waitFor(() => expect(f.owner.snapshot().record.selectedSessionId).toBe('session-original'))
  expect(f.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
  expect(f.element.querySelector('.mobile-terminal-panel')?.hasAttribute('hidden')).toBe(true)
  expect(f.owner.snapshot().record.panel).toBe('conversation')
  expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('lets the user explicitly recheck an empty restored conversation without inventing a background chat-start intent', async () => {
  const f = await openSaved(presentation(true), 'conversation', null)
  expect(f.owner.snapshot().record.selectedSessionId).toBeNull()
  expect(f.element.querySelector('.mobile-chat-start')?.textContent).toContain('原工作面已接回')
  await click(button(f.element, '重新核对'))
  await vi.waitFor(() => expect(f.owner.snapshot().record.selectedSessionId).toBe('session-original'))
  expect(f.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
  expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})
