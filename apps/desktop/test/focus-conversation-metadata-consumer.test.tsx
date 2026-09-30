// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { AgentSessionHistoryPage, AgentSessionUserMessage } from '@agentmux/core'
import type { AgentTimelineSnapshot, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import * as senderDetails from '../src/renderer/src/lib/conversation-sender-details'

// Sealed genuine Composer/Main/Core receipt/FileStore/public projector output.
// This consumer changes only the current Workspace fixture, never record facts.
const producer = JSON.parse(readFileSync(resolve(import.meta.dirname,
  '../../../docs/reviews/evidence/focus-conversation-metadata-consumer-2026-10-04/public-producer.json'), 'utf8')) as {
  now: number; sessionId: string; senderId: string; sessions: SessionSnapshot[]; config: AppConfig
  agentNames: Record<string, string>; captured: AgentTimelineSnapshot; nativePage: AgentSessionHistoryPage
  messages: AgentSessionUserMessage[]; sources: Awaited<ReturnType<typeof api.sessions.historySources>>
}
const baseline = useAppStore.getState()
let root: Root, host: HTMLDivElement
let onSelect: ReturnType<typeof vi.fn>
let reads: { page: number; catalog: number; timeline: number }
let detailsRead: MockInstance<typeof senderDetails.currentConversationSenderDetails>
const senderPath = '/private-controlled-focus-peer-own-project'
const goal = (id: string, sessionIds: string[]): DemandRecord => ({
  id, title: id, sessionIds, description: '', status: 'todo', priority: 'normal',
  projectId: null, projectName: null, createdAt: producer.now, updatedAt: producer.now, source: 'session'
})
const settle = async (assertion: () => void): Promise<void> => {
  await vi.waitFor(async () => { await act(async () => {}); assertion() }, { timeout: 1500, interval: 5 })
}
const dialog = () => document.querySelector<HTMLElement>('.recent-focus__message-preview[role="dialog"]')!
const info = (turn: HTMLElement) => turn.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!
async function pin(role: 'agent' | 'unknown' | 'human'): Promise<HTMLElement> {
  const marker = host.querySelector<HTMLButtonElement>(`.recent-focus__message[data-message-author="${role}"]`)
  expect(marker).not.toBeNull()
  await act(async () => marker!.click())
  await settle(() => expect(dialog()?.querySelector('.log-turn')).not.toBeNull())
  return dialog().querySelector<HTMLElement>('.log-turn')!
}
async function openInfo(turn: HTMLElement): Promise<HTMLElement> {
  expect(info(turn)).not.toBeNull()
  await act(async () => info(turn).click())
  const details = turn.querySelector<HTMLElement>('section[aria-label="Message details"]')
  expect(details).not.toBeNull()
  return details!
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(Date, 'now').mockReturnValue(producer.now)
  reads = { page: 0, catalog: 0, timeline: 0 }; onSelect = vi.fn()
  vi.spyOn(api.sessions, 'historySources').mockImplementation(async () => { reads.catalog++; return producer.sources })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async () => { reads.page++; return producer.nativePage })
  vi.spyOn(api.sessions, 'timeline').mockImplementation(async () => { reads.timeline++; return producer.captured })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  detailsRead = vi.spyOn(senderDetails, 'currentConversationSenderDetails')
  const sessions = producer.sessions.map(session => session.id === producer.senderId ? { ...session, workspacePath: senderPath } : session)
  const config: AppConfig = { ...producer.config, workspaces: [...producer.config.workspaces,
    { id: 'peer-own-project', hostId: 'local', name: 'Peer own project', path: senderPath, kind: 'folder' }] }
  useAppStore.setState({ sessions, config, agentNames: producer.agentNames,
    timelines: { [producer.sessionId]: producer.captured }, tabs: {}, layouts: {},
    demands: { linked: goal('Exact sender goal', [producer.senderId]), recipient: goal('Recipient only goal', [producer.sessionId]) },
    agentComposerDrafts: { original: 'Original draft' },
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
  expect(producer.messages.map(message => message.author.kind)).toEqual(['unknown', 'unknown', 'human', 'agent', 'unknown'])
  expect(senderDetails.currentConversationSpeakerMetadata(producer.senderId, {
    sessions, workspaces: config.workspaces, agentNames: producer.agentNames
  })?.project?.workspaceId).toBe('peer-own-project')
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
  await act(async () => root.render(<RecentFocusTimeline contexts={contexts} entries={[]} currentSessionId={producer.sessionId} onSelect={onSelect} />))
  await settle(() => expect(host.querySelectorAll('.recent-focus__message')).toHaveLength(4))
})
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove(); useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.getElementById('agentmux-window-overlay-host')?.remove()
})

it('retains the known Agent Info control and uses its exact current sender project avatar', async () => {
  const turn = await pin('agent')
  expect(info(turn)).not.toBeNull()
  expect(turn.querySelector('.conversation-message-avatar')?.getAttribute('data-project-workspace-id')).toBe('peer-own-project')
  expect(turn.querySelector('.log-turn__context')?.textContent).toContain('Peer own project')
  expect(detailsRead).not.toHaveBeenCalled()
})
it('passes the original recipient ID so another Agent has the shared incoming direction', async () => {
  const turn = await pin('agent')
  expect(turn.dataset.speakerRelation).toBe('other-agent')
  expect(turn.dataset.messageDirection).toBe('incoming')
  expect(dialog().querySelector('.recent-focus__message-caption')?.textContent).toContain('To ')
  expect(onSelect).not.toHaveBeenCalled()
})
it('native unknown keeps its author facts and opens the original native source Info', async () => {
  const turn = await pin('unknown'), details = await openInfo(turn)
  expect(dialog().dataset.messageAuthor).toBe('unknown')
  expect(turn.dataset.speakerRole).toBe('human')
  expect(details.querySelector('.conversation-input-details__facts')?.textContent).toContain('Provider native input · claude')
  expect(details.textContent).toContain('native-author-records')
  expect(details.textContent).toContain('native-timed')
  expect(details.textContent).toContain('Not recorded · shown as You')
  expect(details.querySelector('.conversation-input-details__sender')).toBeNull()
  expect(detailsRead).not.toHaveBeenCalled()
})
it('explicit Info reads only this sender and its linked Goals with the original submission source', async () => {
  const turn = await pin('agent')
  expect(detailsRead).not.toHaveBeenCalled()
  const details = await openInfo(turn)
  expect(details.querySelector('.conversation-input-details__facts')?.textContent).toContain('AgentMux submitted record')
  expect(details.textContent).toContain('prompt:known-agent')
  expect(details.textContent).toContain('Peer own project')
  expect(details.textContent).toContain('Exact sender goal')
  expect(details.textContent).not.toContain('Recipient only goal')
  expect(detailsRead.mock.calls.map(call => call[0])).toEqual([producer.senderId])
  expect(onSelect).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts.original).toBe('Original draft')
})
it('missing sender project stays absent rather than borrowing the recipient or active project', async () => {
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, workspaces: producer.config.workspaces } }))
  const turn = await pin('agent'), details = await openInfo(turn)
  expect(turn.querySelector('.conversation-message-avatar')).toBeNull()
  expect(turn.querySelector('[data-project-workspace-id]')).toBeNull()
  expect(details.textContent).toContain('Project not recorded.')
  expect(details.textContent).not.toContain(producer.config.workspaces[0]!.name)
  expect(detailsRead.mock.calls.map(call => call[0])).toEqual([producer.senderId])
})
it('Info open/close keeps the pinned body node and Range, sender Context, navigation and formatter', async () => {
  const turn = await pin('agent'), body = turn.querySelector<HTMLElement>('.log-turn__body')!
  expect(body.textContent?.length).toBeGreaterThan(0)
  const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(6, text.textContent!.length))
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  await openInfo(turn)
  await act(async () => info(turn).click())
  expect(dialog().querySelector('.log-turn__body')).toBe(body)
  expect(selection.getRangeAt(0)).toBe(range)
  expect(dialog().querySelector('.recent-focus__sender')).not.toBeNull()
  expect(dialog().textContent).toContain('Sender Run not recorded')
  expect(turn.querySelector('.log-turn__time')?.textContent?.length).toBeGreaterThan(0)
  const sender = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('View sender'))!
  await act(async () => sender.click())
  await pin('agent')
  const recipient = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Return to Context')!
  await act(async () => recipient.click())
  expect(onSelect.mock.calls).toEqual([[producer.senderId], [producer.sessionId]])
})
it('hover, closed Info and unrelated output do not read full details or native history again', async () => {
  const marker = host.querySelector<HTMLButtonElement>('.recent-focus__message[data-message-author="agent"]')!
  await act(async () => { marker.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise(done => setTimeout(done, 200)) })
  expect(document.querySelector('.recent-focus__message-preview')).not.toBeNull()
  expect(detailsRead).not.toHaveBeenCalled()
  const turn = await pin('agent'), before = { ...reads }
  expect(info(turn).getAttribute('aria-expanded')).toBe('false')
  await act(async () => useAppStore.setState({ demands: { unrelated: goal('Unrelated goal', ['unrelated-session']) },
    timelines: { ...useAppStore.getState().timelines, unrelated: { ...producer.captured, agentSessionId: 'unrelated-session' } } }))
  expect(detailsRead).not.toHaveBeenCalled()
  expect(reads).toEqual(before)
  expect(onSelect).not.toHaveBeenCalled()
})
