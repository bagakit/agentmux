// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import type { RuntimeEvent } from '../src/shared/contracts'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'

const dom = composerDOM()
it('the real A2A module saves only its authored preference and retains the dirty choice on failure', async () => {
  const current = useAppStore.getState().config!
  const save = vi.spyOn(api.config, 'save').mockRejectedValueOnce(new Error('Private save failure'))
    .mockImplementation(async next => { useAppStore.setState({ config: next }); return next })
  await dom.render(<SettingsPanel initialSection="a2a" onClose={() => {}} />)
  expect(dom.container.querySelectorAll('[data-a2a-settings] input[type=radio]')).toHaveLength(3)
  expect(dom.container.textContent).toContain('confirmed idle opportunity')
  await act(async () => dom.container.querySelector<HTMLInputElement>('input[value=notify]')!.click())
  await dom.click('[data-a2a-settings] [data-settings-save-bar] button')
  expect(dom.container.textContent).toContain('Private save failure')
  expect(dom.container.querySelector<HTMLInputElement>('input[value=notify]')!.checked).toBe(true)
  expect(useAppStore.getState().config?.a2a).toBeUndefined()
  await dom.click('[data-a2a-settings] [data-settings-save-bar] button')
  expect(save).toHaveBeenLastCalledWith({ ...current, a2a: { notifications: 'notify' } }, { ...current, a2a: { notifications: 'follow-global' } })
  expect(useAppStore.getState().config?.a2a).toEqual({ notifications: 'notify' })
  expect(dom.container.textContent).toContain('Changes saved')
})

it('the original central Runtime subscription consumes A2A without a mounted mailbox and skips its boot buffer', async () => {
  const listeners = new Set<(event: RuntimeEvent) => void>()
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { listeners.add(listener); return () => listeners.delete(listener) })
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  const message = (sequence: number): RuntimeEvent => ({ type: 'core', hostId: 'local', event: { type: 'agent-message-changed', sequence,
    messageSequence: sequence, messageId: `central-${sequence}`, live: true, recordKind: 'message', senderSessionId: 'sender', recipientSessionId: 'reader' } })
  const config = { ...composerConfig, a2a: { notifications: 'notify' as const }, notifications: { mode: 'off' as const, sound: true } }
  vi.spyOn(api.config, 'get').mockImplementation(async () => { for (const listener of listeners) listener(message(1)); return config })
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [composerSession('reader'), composerSession('sender')], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  const notify = vi.spyOn(api.ui, 'notifyAgentAttention').mockResolvedValue({ status: 'shown', presentation: 'as-requested' })
  const list = vi.spyOn(api.sessions, 'listMessages')
  useAppStore.setState({ loading: true, restoredWorkbench: null, mainSurface: 'board', tabs: {}, layouts: {}, agentSteerQueues: {} })
  const dispose = await useAppStore.getState().initialize()
  try {
    useAppStore.setState({ mainSurface: 'board' })
    expect(notify).not.toHaveBeenCalled()
    for (const listener of listeners) listener(message(1))
    for (const listener of listeners) listener(message(2))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce())
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'reader', mode: 'standard', sound: true }))
    expect(list).not.toHaveBeenCalled(); expect(dom.container.querySelector('[data-session-mailbox]')).toBeNull()
  } finally { dispose() }
})
