// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import { fileUploadRevision } from '@agentmux/core/files'
import { expandComposerInput } from '@agentmux/client-ui/composer-semantic-reference'
import { FocusSearchLocations } from '../src/renderer/src/components/FocusSearchLocations'
import { FocusScanActions } from '../src/renderer/src/components/FocusScanActions'
import { LocalRetainedInputs } from '../src/renderer/src/components/LocalRetainedInputs'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import type { searchFocus } from '../src/renderer/src/lib/focus-search'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
const dom = composerDOM()
const result = (values: Partial<ReturnType<typeof searchFocus>> = {}): ReturnType<typeof searchFocus> => ({ contextKeys: new Set(), projectKeys: new Set(), locations: [], unplaced: [], sources: [], issue: null, ...values })
const source = (hostId: string): AgentSessionHistoryDescriptor => ({ hostId, agentSessionId: 'retained-shared', state: 'retired', history: {
 providerId: 'generic', executorId: 'generic', workspacePath: fixturePath('search/' + hostId), createdAt: 1,
 nativeHandle: { kind: 'provider', providerId: 'generic', sessionId: hostId + '-current' },
 observedNativeHandle: { kind: 'provider', providerId: 'generic', sessionId: hostId + '-observed' },
 previousNativeHandle: { kind: 'provider', providerId: 'generic', sessionId: hostId + '-previous' }
} })
const archivedInput = (operationId: string, text: string): AgentSteerQueueEntry => {
 const key = { kind: 'prompt' as const, agentSessionId: 'original-agent', expectedRun: { runId: 'original-run' }, submissionId: operationId }
 const ref = { key, waitGeneration: 1 }
 return { operationId, text, status: 'deferred', archived: true,
  directInputControl: { kind: 'agent', hostId: 'original-host', agentSessionId: 'original-agent', run: { runId: 'original-run' } },
  directInputBinding: { expectedRun: { runId: 'original-run' } },
  inputReceipt: { key, ref, status: 'terminal-confirmed', persistence: 'confirmed', observation: 'closed', admission: null,
   control: { ref, state: 'dispatch-authorized', gateId: 'original-gate', at: 2 } } }
}
const click = async (button: HTMLElement) => act(async () => button.click())
const query = async (text: string) => act(async () => {
 const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
 expect(input).not.toBeNull(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true }))
})
const savedQuery = async (text: string) => act(async () => {
 const input = document.querySelector<HTMLInputElement>('[aria-label="Search saved inputs"]')!
 expect(input).not.toBeNull(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true }))
})
const discloseDiagnostics = async (row: HTMLDetailsElement) => {
 const details = row.querySelector<HTMLDetailsElement>('.local-input-record__diagnostics')!
 expect(details).not.toBeNull(); await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
}

it('one result area retains every exact location and exposes full provenance only through its details', async () => {
 const locations = ['first', 'second'].map(groupId => ({ address: JSON.stringify(['workspace', groupId, 'original-tab', 'original-region']), name: 'original-region', kind: 'agent', sessionId: 'same-session',
  reference: { displayWorkspaceId: 'workspace', groupId, tabId: 'original-tab', regionId: 'original-region' } }))
 const selected = vi.fn(), read = vi.fn(), sources = [source('host-a'), source('host-b')]
 await dom.render(<FocusSearchLocations result={result({ locations, sources, unplaced: [{ kind: 'region', id: 'unplaced-original', name: 'unplaced-original' }] })} onSelect={selected} onRead={read}
  nameLocation={() => 'Readable original task'} nameSource={source => source.hostId === 'host-a' ? 'First retained task' : 'Second retained task'} describeLocation={location => 'Original project · ' + location.reference.groupId} />)
 expect(dom.container.querySelectorAll('.focus-search-results')).toHaveLength(1)
 expect(dom.container.querySelectorAll('.focus-search-locations')).toHaveLength(1)
 expect(dom.container.querySelectorAll('[data-focus-search-result]')).toHaveLength(5)
 const buttons = [...dom.container.querySelectorAll<HTMLButtonElement>('.focus-location-choice')]
 expect(buttons).toHaveLength(2); expect(buttons[1]!.querySelector('strong')!.textContent).toBe('Readable original task')
 expect(selected).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
 await click(buttons[1]!); expect(selected.mock.calls).toEqual([[locations[1]]])
 for (const location of locations) {
  const row = [...dom.container.querySelectorAll<HTMLElement>('[data-focus-search-address]')].find(row => row.dataset.focusSearchAddress === location.address)!
  const details = row.querySelector('details')!; expect(details.open).toBe(false)
  expect(details.textContent).toContain(location.address); expect(details.textContent).toContain(location.reference.groupId)
 }
 const unplaced = dom.container.querySelector('[data-focus-search-result="unplaced"]')!
 expect(unplaced.querySelector('strong')!.textContent).toBe('Region'); expect(unplaced.querySelector('details')!.textContent).toContain('unplaced-original')
 const retained = [...dom.container.querySelectorAll<HTMLElement>('[data-focus-search-result="conversation"]')]
 expect(retained.map(row => row.querySelector('strong')!.textContent)).toEqual(['First retained task', 'Second retained task'])
 for (let index = 0; index < retained.length; index++) {
  const details = retained[index]!.querySelector('details')!; expect(details.open).toBe(false)
  for (const fact of [sources[index]!.hostId, 'retained-shared', sources[index]!.hostId + '-current', sources[index]!.hostId + '-observed', sources[index]!.hostId + '-previous', sources[index]!.history!.workspacePath]) expect(details.textContent).toContain(fact)
  await act(async () => { details.open = true }); expect(details.open).toBe(true)
  expect([...details.querySelectorAll('dl > div')].find(row => row.querySelector('dt')?.textContent === 'Workspace')?.querySelector('dd')?.textContent).toBe(sources[index]!.history!.workspacePath)
 }
 await click(retained[1]!.querySelector('button')!); expect(read.mock.calls).toEqual([[sources[1]]])
})

it('missing friendly metadata keeps technical defaults in details instead of promoting them to titles', async () => {
 const location = { address: 'original-address', name: 'original-tab', kind: 'agent', sessionId: 'original-session', reference: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'original-tab', regionId: 'original-region' } }
 await dom.render(<FocusSearchLocations result={result({ locations: [location], sources: [source('host-a')] })} onSelect={() => {}} describeLocation={() => 'Original source'} nameLocation={() => ''} nameSource={() => 'retained-shared'} />)
 expect(dom.container.querySelector('.focus-location-choice strong')?.textContent).toBe('Agent')
 expect(dom.container.querySelector('[data-focus-search-result="conversation"] strong')?.textContent).toBe('Recorded conversation')
 expect(dom.container.querySelector('[data-focus-search-result="location"] details')?.textContent).toContain('original-tab')
 expect(dom.container.querySelector('[data-focus-search-result="conversation"] details')?.textContent).toContain('retained-shared')
})

it('actual Global search uses the exact current Region name and keeps retained names partitioned by Host', async () => {
 const workspace = composerConfig.workspaces[0]!, session = composerSession('live-original')
 const tab = createWorkbenchTab('live-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'live-region', sessionId: session.id })
 const sources = [source('host-a'), source('host-b')]
 useAppStore.setState({ loading: false, mainSurface: 'agents', config: composerConfig, sessions: [session], agentNames: { [session.id]: 'Readable live task', 'retained-shared': 'Wrong local same-ID name' },
  tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('live-group', [tab.id]) }, timelines: {},
  agentFocus: { execution: { sessionId: null, history: sources.map((source, index) => ({ sessionId: source.agentSessionId, focusedAt: index + 1,
   identity: { hostId: source.hostId, kind: 'agent' as const, name: index ? 'Remote second task' : 'Remote first task', workspacePath: source.history!.workspacePath } })) }, pmo: { sessionId: null } } })
 vi.spyOn(api.spatial, 'read').mockImplementation(async () => ({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) }))
 vi.spyOn(api.sessions, 'historySources').mockResolvedValue({ sources, warnings: [] })
 vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
 vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
 await initializeSpatialControlFixture(); await dom.render(<GlobalFocusSurface />)
 await query('live-original')
 expect(dom.container.querySelector('.focus-location-choice strong')?.textContent).toBe('Readable live task')
 await query('retained-shared')
 expect([...dom.container.querySelectorAll('[data-focus-search-result="conversation"] strong')].map(node => node.textContent)).toEqual(['Remote first task', 'Remote second task'])
 expect(dom.container.querySelector('.focus-search-results')?.textContent).not.toContain('Wrong local same-ID name')
 await act(async () => useAppStore.setState(state => ({ agentFocus: { ...state.agentFocus, execution: { ...state.agentFocus.execution, history: state.agentFocus.execution.history.map((entry, index) => ({ ...entry, identity: { ...entry.identity!, name: index ? '' : entry.sessionId } })) } } })))
 expect([...dom.container.querySelectorAll('[data-focus-search-result="conversation"] strong')].map(node => node.textContent)).toEqual(['Recorded conversation', 'Recorded conversation'])
})

it('drafts and queue remain readable and copy-only with unknown keys and original image references intact', async () => {
 const draft = 'Unassociated original draft 中🙂\n  exact end  ', text = 'queued image\n  exact end  '
 const image = { start: 0, end: 6, bodyRevision: fileUploadRevision(new TextEncoder().encode(text)), upload: { hostId: 'original-host', agentSessionId: 'original-agent', expectedRun: { runId: 'original-run' }, operationId: 'original-upload', name: 'photo.png', mimeType: 'image/png', byteLength: 4, revision: 'sha256:' + '0'.repeat(64) } }
 const queue: AgentSteerQueueEntry = { operationId: 'original-input', text, inputImages: [image], status: 'deferred', archived: true, awaitingExplicitSend: true,
  directInputControl: { kind: 'agent', hostId: 'original-host', agentSessionId: 'original-agent', run: { runId: 'original-run' } } }
 useAppStore.setState({ sessions: [], tabs: {}, agentComposerDrafts: { 'orphan-original-region': draft }, agentSteerQueues: { 'original-agent': [queue] } })
 const before = { drafts: useAppStore.getState().agentComposerDrafts, queues: useAppStore.getState().agentSteerQueues }
 const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
 const submit = vi.spyOn(api.sessions, 'submitPrompt'), reopen = vi.spyOn(api.sessions, 'reopen'), stop = vi.spyOn(api.sessions, 'stop')
 await dom.render(<FocusScanActions order="priority" onOrderChange={() => {}} />)
 const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Drafts"]')!; expect(trigger).not.toBeNull(); expect(trigger.querySelector('svg')).not.toBeNull()
 await click(trigger)
 expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Saved inputs')
 const rows = [...document.querySelectorAll<HTMLDetailsElement>('.local-input-record')]; expect(rows).toHaveLength(2)
 expect(document.querySelector('textarea')).toBeNull()
 for (const row of rows) await act(async () => { row.open = true; row.dispatchEvent(new Event('toggle')) })
 for (const row of rows) await discloseDiagnostics(row)
 expect(rows[0]!.querySelector('textarea')!.value).toBe(draft)
 expect(rows[0]!.textContent).toContain('orphan-original-region'); expect(rows[0]!.textContent).toContain('Unknown · original key kept'); expect(rows[1]!.textContent).toContain('original-input')
 expect(rows[1]!.textContent).toContain('original-host / original-agent'); expect(rows[1]!.textContent).toContain('explicit send required')
 await click(rows[0]!.querySelector('button')!); expect(copy).toHaveBeenLastCalledWith(draft)
 await click(rows[1]!.querySelector('button')!)
 expect(expandComposerInput(copy.mock.calls.at(-1)![0])).toEqual({ text, inputImages: [image] })
 expect(useAppStore.getState().agentComposerDrafts).toBe(before.drafts); expect(useAppStore.getState().agentSteerQueues).toBe(before.queues)
 expect(submit).not.toHaveBeenCalled(); expect(reopen).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})

it('saved input search keeps archive paging explicit and presents attachments without raw paths', async () => {
 const earlier = archivedInput('earlier-design', 'Earlier design note')
 const read = vi.spyOn(api.ui, 'readWorkbenchInputArchive')
  .mockResolvedValueOnce({ entries: [], nextCursor: 'earlier-page' })
  .mockResolvedValueOnce({ entries: [{ ownerKey: 'original-agent', entry: earlier }], nextCursor: null })
 useAppStore.setState({ sessions: [], tabs: {}, agentSteerQueues: {},
  agentComposerDrafts: { 'orphan-original-region': '@' + fixturePath('retained-draft-home/.agentmux/pasted/paste-example.png') + '   message tool\n refinement' } })
 const submit = vi.spyOn(api.sessions, 'submitPrompt')
 await dom.render(<FocusScanActions order="priority" onOrderChange={() => {}} />)
 await click(dom.container.querySelector<HTMLButtonElement>('[aria-label="Drafts"]')!)
 expect(read).toHaveBeenCalledExactlyOnceWith({ limit: 30 })
 expect(document.querySelector('.local-input-record__excerpt')?.textContent).toBe('message tool refinement')
 expect(document.querySelector('.local-input-record__attachment')?.textContent).toBe('paste-example.png')
 expect(document.querySelector('.local-input-record summary')?.textContent).not.toContain(fixturePath('retained-draft-home'))

 await savedQuery('Earlier design')
 expect(document.querySelector('.local-input-record')).toBeNull()
 expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No matches in loaded inputs')
 expect(document.querySelector('[role="dialog"]')?.textContent).toContain('earlier inputs available')
 expect(read).toHaveBeenCalledExactlyOnceWith({ limit: 30 })
 const loadEarlier = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Load earlier saved inputs')!
 await click(loadEarlier)
 expect(read).toHaveBeenLastCalledWith({ limit: 30, after: 'earlier-page' })
 await vi.waitFor(() => expect(document.querySelector('.local-input-record__excerpt')?.textContent).toBe('Earlier design note'))

 await click(document.querySelector<HTMLButtonElement>('[aria-label="Clear saved input search"]')!)
 expect(read).toHaveBeenCalledTimes(2)
 expect(document.querySelectorAll('.local-input-record')).toHaveLength(2)
 await savedQuery('paste-example.png')
 expect([...document.querySelectorAll('.local-input-record__excerpt')].map(node => node.textContent)).toEqual(['message tool refinement'])
 expect(read).toHaveBeenCalledTimes(2)
 expect(submit).not.toHaveBeenCalled()
})

it('Continue opens only the exact eligible draft location while orphan and archived inputs stay copy-only', async () => {
 const workspace = composerConfig.workspaces[0]!, session = composerSession('draft-location')
 const tab = createWorkbenchTab('draft-tab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'draft-region', sessionId: session.id })
 const archived: AgentSteerQueueEntry = { operationId: 'copy-only-archive', text: 'Copy only archive', status: 'deferred', archived: true,
  directInputControl: { kind: 'agent', hostId: 'original-host', agentSessionId: 'original-agent', run: { runId: 'original-run' } } }
 useAppStore.setState({ config: composerConfig, activeWorkspaceId: workspace.id, sessions: [session], tabs: { [tab.id]: tab },
  layouts: { [workspace.id]: createWorkspaceLayout('draft-group', [tab.id]) }, agentSteerQueues: { 'original-agent': [archived] },
  agentComposerDrafts: { 'draft-region': 'Exact original draft', 'orphan-region': 'Orphan original draft' },
  workbenchSpaceSelection: { workspaceId: workspace.id, spaceId: null, zoneId: null, topicId: null, groupId: 'draft-group', tabId: tab.id, regionId: 'draft-region' } })
 const openLocation = vi.fn(() => true), submit = vi.spyOn(api.sessions, 'submitPrompt'), reopen = vi.spyOn(api.sessions, 'reopen')
 await dom.render(<FocusScanActions order="priority" onOrderChange={() => {}} onOpenLocation={openLocation} />)
 await click(dom.container.querySelector<HTMLButtonElement>('[aria-label="Drafts"]')!)
 const rows = [...document.querySelectorAll<HTMLDetailsElement>('.local-input-record')]
 expect(rows).toHaveLength(3)
 const exact = rows.find(row => row.querySelector('.local-input-record__excerpt')?.textContent === 'Exact original draft')!
 const copyOnly = rows.filter(row => row !== exact)
 const continueButton = [...exact.parentElement!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Continue writing')!
 expect(continueButton).toBeDefined()
 for (const row of copyOnly) expect(row.parentElement!.textContent).not.toContain('Continue writing')
 await click(continueButton)
 expect(openLocation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ displayWorkspaceId: workspace.id, groupId: 'draft-group', tabId: tab.id, regionId: 'draft-region' }))
 expect(document.querySelector('[role="dialog"]')).toBeNull()
 expect(useAppStore.getState().agentComposerDrafts).toMatchObject({ 'draft-region': 'Exact original draft', 'orphan-region': 'Orphan original draft' })
 expect(useAppStore.getState().agentSteerQueues['original-agent']).toEqual([archived])
 expect(submit).not.toHaveBeenCalled(); expect(reopen).not.toHaveBeenCalled()
})

it('an exactly scoped empty shelf keeps the all-inputs route and unknown association honest', async () => {
 useAppStore.setState({ sessions: [], agentComposerDrafts: { 'unknown-region': 'Original draft' }, agentSteerQueues: {} })
 await dom.render(<LocalRetainedInputs target={{ hostId: 'missing-host', agentSessionId: 'missing-agent' }} />)
 expect(dom.container.querySelector('.local-input-record')).toBeNull()
 expect(dom.container.textContent).toContain('No exactly associated local inputs')
 expect(dom.container.textContent).toContain('Focus actions')
})
