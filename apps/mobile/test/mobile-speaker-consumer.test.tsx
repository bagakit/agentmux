import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, mount, mounted, session } from './conversation-fixture'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })

it.each(['exact', 'wrong-SID'] as const)('reads the recorded peer speaker through the exact SDK target and rejects %s mismatch without cloning the full directory', async result => {
  const f = fixture(), read = f.client.agentSession.bind(f.client)
  f.sessions.set('peer', { ...session('peer'), providerId: 'claude' })
  const pointRead = vi.spyOn(f.client, 'agentSession').mockImplementation(id => id === 'peer' && result === 'wrong-SID' ? { ...session('other'), providerId: 'gemini' } : read(id))
  const fullRead = vi.spyOn(f.client, 'agentSessions')
  f.setTimeline({ agentSessionId: 'session-original', revision: 1, items: [{ id: 'original-peer-message', agentSessionId: 'session-original', kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: 1, updatedAt: 1, title: 'Input', content: 'Original recorded peer message', authorAgentSessionId: 'peer' }] })
  const props = { client: f.client, agentSessionId: 'session-original', connection: { state: 'connected' as const, message: '已连接' }, platform: createBrowserPlatform() }
  const view = await mount(<MobileConversationSurface {...props} />)
  const message = view.element.querySelector('[data-message-id="captured:original-peer-message"]')!
  expect(message).not.toBeNull()
  expect(message.querySelector('.log-turn__who')?.textContent).toBe(result === 'exact' ? 'claude Agent' : 'Agent')
  expect(message.querySelector('.log-turn__sender-id')?.textContent).toContain('peer')
  expect(message.textContent).not.toContain('gemini Agent')
  pointRead.mockClear(); fullRead.mockClear()
  await view.render(<MobileConversationSurface {...props} />)
  expect(pointRead.mock.calls.map(([id]) => id)).toContain('peer')
  expect(fullRead).not.toHaveBeenCalled()
  expect(f.submit).not.toHaveBeenCalled()
})
