// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it } from 'vitest'
import { AgentAvatar, ExecutorIdentityContext } from '../src/renderer/src/components/AgentAvatar'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

declare global { var __avatarSelectorReads: Record<string, number> }
const dom = composerDOM()
const observations = () => { globalThis.__avatarSelectorReads = {} }
const related = 'retained-avatar', unrelated = 'other-session'

it.each([1, 32])('routes real Store events only to related mounted Avatars among %i consumers', async count => {
  const ids = [related, ...Array.from({ length: count - 1 }, (_, index) => `avatar-${index}`)]
  useAppStore.setState({ sessions: [...ids.map(id => composerSession(id)), composerSession(unrelated)],
    timelines: {}, recoveryCandidates: [], pendingAgentLaunches: {}, sessionNameMetadata: {} })
  const scene = (visible: boolean, config = composerConfig) => <ExecutorIdentityContext.Provider value={{ config }}>
    {ids.map(id => <AgentAvatar key={id} sessionId={id} visible={visible} />)}
  </ExecutorIdentityContext.Provider>
  const status = async (id: string, offset: number) => await act(async () => useAppStore.getState().applyEvent({
    type: 'core', hostId: 'local', event: { type: 'agent-status', agentSessionId: id, state: 'working',
      evidence: { source: 'native-hook', run: { runId: `run-${id}` }, observedAt: Date.now() + offset } }
  }))
  observations(); await dom.render(scene(false))
  expect(dom.container.querySelectorAll('.agent-avatar')).toHaveLength(count)
  const original = dom.container.querySelector('.agent-avatar')!
  // Related hidden facts remain live before testing the unrelated cost boundary.
  observations(); await status(related, 1)
  expect(globalThis.__avatarSelectorReads[related]).toBeGreaterThan(0)
  expect(original.classList.contains('status--working')).toBe(true)
  observations()
  for (let index = 0; index < 8; index++) await status(unrelated, index + 2)
  expect(useAppStore.getState().sessions.find(item => item.id === unrelated)?.status.state).toBe('working')
  expect(globalThis.__avatarSelectorReads, 'Unrelated Runtime events must not execute retained Avatar selectors').toEqual({})
  await dom.render(scene(true))
  expect(dom.container.querySelector('.agent-avatar')).toBe(original)
  expect(original.classList.contains('status--working')).toBe(true)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(item => item.id !== related) })))
  expect(original.classList.contains('status--working')).toBe(false)
  // Configuration still belongs to the original window context, not the Session router.
  const renamed = { ...composerConfig, executors: { ...composerConfig.executors,
    codex: { ...composerConfig.executors.codex!, label: 'Configured executor' } } }
  await dom.render(<ExecutorIdentityContext.Provider value={{ config: renamed }}>
    <AgentAvatar sessionId={related} executorId="codex" visible />
  </ExecutorIdentityContext.Provider>)
  await dom.hover('.agent-avatar')
  expect(document.querySelector('.agent-identity-popover')?.textContent).toContain('Configured executor')
  await dom.render(<ExecutorIdentityContext.Provider value={{ config: renamed }}>
    <AgentAvatar sessionId={unrelated} executorId="codex" visible />
  </ExecutorIdentityContext.Provider>)
  observations()
  await act(async () => useAppStore.setState(state => ({ sessions: [...state.sessions, composerSession(related)] })))
  expect(globalThis.__avatarSelectorReads, 'Rebinding must release the old Session scope').toEqual({})
  await status(unrelated, 30)
  expect(globalThis.__avatarSelectorReads[unrelated]).toBeGreaterThan(0)
  await dom.render(null)
  observations(); await status(unrelated, 50)
  expect(globalThis.__avatarSelectorReads).toEqual({})
})
