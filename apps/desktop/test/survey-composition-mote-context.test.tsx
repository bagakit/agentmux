// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createMoteApp, moteClick, moteType, type MoteAppFixture } from './fixtures/mote-app'
import { defaultAgent, defaultTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useWorkbenchBrowserPresentation } from '../src/renderer/src/lib/workbench-presentation'
import { useMoteDialogueView } from '../src/renderer/src/lib/mote-dialogue-view'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { originalTopicAddress } from '../src/shared/space-addresses'
import { promptCarrierWaiting } from './helpers/prompt-carrier-receipt'

const observations = vi.hoisted(() => ({ owner: null as any, leaf: null as any, owners: [] as any[], presentation: null as any }))
// Observe the actual provider and actual input consumer without substituting either behavior.
vi.mock('../src/renderer/src/components/MoteMainActions', async original => {
  const module = await original<typeof import('../src/renderer/src/components/MoteMainActions')>()
  return { ...module, MoteMainActions(props: Parameters<typeof module.MoteMainActions>[0]) {
    const value = useMoteDialogueView(); if (props.scope.topic.id === moteTopics[0]!.id) { observations.owner = value; if (value && !observations.owners.includes(value)) observations.owners.push(value) }
    return createElement(module.MoteMainActions, props)
  } }
})
vi.mock('../src/renderer/src/components/AgentSessionComposer', async original => {
  const module = await original<typeof import('../src/renderer/src/components/AgentSessionComposer')>()
  return { ...module, AgentSessionComposer(props: Parameters<typeof module.AgentSessionComposer>[0]) {
    const value = useMoteDialogueView(), presentation = useWorkbenchBrowserPresentation(); if (props.sessionId === defaultAgent.id) { observations.leaf = value; observations.presentation = presentation }
    return createElement(module.AgentSessionComposer, props)
  } }
})
const actualSend = useAppStore.getState().send
let app: MoteAppFixture | undefined
afterEach(async () => { await app?.dispose(); app = undefined; observations.owner = null; observations.leaf = null; observations.owners = [] })
it('[composition-mote] ordinary Work retains the same Main dialogue scope and real Composer sends with its exact original target', async () => {
  app = createMoteApp()
  const current = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id, groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
  const topic = { ...moteTopics[0]!, quickMode: { status: 'saved' as const, version: 'original-main-settings', defaults: { conversation: current } } }
  const topics = [topic, ...moteTopics.slice(1)]
  const target = { ...originalTopicAddress(scratchWorkspace, topic, {})!, expectedResource: { hostId: scratchWorkspace.hostId, workspaceId: scratchWorkspace.id, workspacePath: scratchWorkspace.path } }
  useAppStore.setState({ send: actualSend, scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 0, topics, reading: false, error: null } } })
  vi.mocked(api.scratch.listTopics).mockResolvedValue(topics)
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics.find(topic => topic.id === id) ?? null)
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async input => ({ main: { target: input.target, identity: { hostId: 'local', moteId: topic.id }, status: 'ready', resource: null,
    documentRevision: 'original-document', roleRevision: 'original-main-role', current, issue: null }, links: [], incarnation: 'original-links', throughSequence: 0, next: null,
    coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }) as any)
  vi.spyOn(api.motePreferences, 'read').mockResolvedValue({ status: 'unconfirmed', issue: null, source: null, choices: { executors: [], conversations: [], destinations: [] }, defaults: {} } as any)
  vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null } as any)
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, _text, id) => promptCarrierWaiting(control.agentSessionId, control.run.runId, id))
  await app.mount()
  await vi.waitFor(() => expect(observations.owner?.page?.main.roleRevision).toBe('original-main-role'))
  expect(observations.owner.target).toEqual(target)
  await vi.waitFor(() => { expect(observations.leaf).not.toBeNull(); expect(observations.owners).toContain(observations.leaf) })
  expect(observations.presentation.surface).not.toBe('mote'); expect(observations.presentation.moteContextKey).toBeUndefined()
  expect(observations.leaf.target).toEqual(target); expect(observations.leaf.page.main.roleRevision).toBe('original-main-role')
  const terminal = app.container.querySelector('[data-activity-session="' + defaultAgent.id + '"]') ?? app.container.querySelector('[data-terminal-session="' + defaultAgent.id + '"]')
  const surface = terminal!.closest<HTMLElement>('.agent-surface')!
  expect(surface.closest('[data-workbench-tab-id]')).not.toBeNull()
  expect(surface.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull()
  await moteType(surface.querySelector<HTMLElement>('[aria-label="Message Agent"]')!, 'Continue the original Work Main')
  const send = [...surface.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Send' || button.getAttribute('aria-label') === 'Send')!
  await moteClick(send)
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  expect(submit.mock.calls[0]![4]?.moteMain).toEqual({ target, expectedRoleRevision: 'original-main-role' })
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})
