// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme, getSemanticIconCatalog } from '@agentmux/client-ui/theme'
import { semanticIconHref, type SemanticIconId } from '@agentmux/client-ui/icons'
import { NativeProcessObservation } from '@agentmux/client-ui/components/NativeProcessObservation'
import type { AgentSessionHistoryItem } from '@agentmux/core'
import { WorkbenchTabMarks } from '../src/renderer/src/components/WorkbenchTabMarks'
import { ComposerPendingDelivery } from '../src/renderer/src/components/ComposerPendingDelivery'
import { TopicKnowledgePanel } from '../src/renderer/src/components/TopicKnowledgePanel'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig } from './helpers/composer-dom-fixture'
import { ComposerOutbox } from '../src/renderer/src/components/ComposerOutbox'
import { ConversationRulerControls } from '../src/renderer/src/components/ConversationRulerControls'
import { NotebookHome, NotebookNavigation } from '../src/renderer/src/components/NotebookNavigation'
import { FilePathLabel } from '../src/renderer/src/components/FilePathLabel'
import { NotebookSelector } from '../src/renderer/src/components/NotebookSelector'
import { TopicActionsMenu } from '../src/renderer/src/components/TopicContextMenu'
import { BranchContextMenu } from '../src/renderer/src/components/BranchContextMenu'
import { SurfaceSwitch } from '../src/renderer/src/components/TopRowChrome'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM(), customPath = 'M4 5H20V19H4Z'
let release: () => void
beforeEach(() => { release = mountThemeRuntime(window) })
afterEach(() => release())
function drawing(node: ParentNode | null, id: SemanticIconId) {
  expect(node, `nonempty actual ${id} consumer`).not.toBeNull()
  expect(node!.querySelector(`use[href="${semanticIconHref(id)}"]`), `actual binding ${id}`).not.toBeNull()
}
async function override(id: SemanticIconId) {
  const theme = structuredClone(GRAPHITE_THEME); theme.id = 'custom.optimization'; theme.name = 'Only exact meaning'
  theme.icons = { [id]: { kind: 'paths', paths: [{ d: customPath }] } }
  await act(async () => { expect(previewTheme(theme).applied).toBe(true) })
  expect(document.getElementById(semanticIconHref(id).slice(1))?.querySelector('path')?.getAttribute('d')).toBe(customPath)
}
async function click(node: Element | null) { expect(node).not.toBeNull(); await act(async () => (node as HTMLElement).click()) }
async function open(node: Element | null) { expect(node).not.toBeNull(); await act(async () => { (node as HTMLElement).focus(); node!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) }) }
const item = (text: string) => [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find(node => node.textContent?.trim() === text) ?? null

it('move-to-draft themes the real Outbox action and retains the exact original queued identity and body', async () => {
  const move = vi.fn(async () => {}), select = vi.fn()
  const entry = { id: 'same-operation', text: 'Original queued body', status: 'failed' as const, deliverable: false, errorCode: 'AGENT_PROMPT_CONDITION_CHANGED' }
  await dom.render(<ComposerOutbox queued={[entry]} selectedId={null} onSelect={select} onMoveToDraft={move} />)
  const button = dom.container.querySelector('[aria-label="移至草稿"]')!
  drawing(button, 'action.move-to-draft')
  await override('action.move-to-draft')
  expect(dom.container.querySelector('[aria-label="移至草稿"]')).toBe(button)
  expect(dom.container.textContent).toContain(entry.text)
  expect(document.getElementById(semanticIconHref('action.move-to-folder').slice(1))?.querySelector('path')?.getAttribute('d')).not.toBe(customPath)
  await click(button)
  expect(move).toHaveBeenCalledExactlyOnceWith(entry.id, entry.text)
  expect(select).not.toHaveBeenCalled(); expect(dom.draft()).toBe('Keep my draft')
})

it('controlled Browser and generic file marks retain their object identity and independent exact theme roles', async () => {
  const marks = [{ regionId: 'same-file', kind: 'file' as const }, { regionId: 'same-controlled-browser', kind: 'browser' as const, driving: true }, { regionId: 'same-idle-browser', kind: 'browser' as const, driving: false }]
  await dom.render(<WorkbenchTabMarks marks={marks} />)
  drawing(dom.container, 'object.file'); drawing(dom.container, 'object.browser')
  const controlled = dom.container.querySelector('[aria-label="Agent driving"]')!
  drawing(controlled, 'object.agent-controlled-browser')
  expect(getSemanticIconCatalog().icons.find(row => row.id === 'object.agent-controlled-browser')?.defaultGlyph).toBe('browser-agent')
  expect(controlled.querySelector('[data-icon-animation]')).toBeNull()
  await override('object.agent-controlled-browser')
  expect(dom.container.querySelector('[aria-label="Agent driving"]')).toBe(controlled)
  drawing(dom.container, 'object.browser'); drawing(dom.container, 'object.file')
  expect(document.getElementById(semanticIconHref('object.agent').slice(1))?.querySelector('path')?.getAttribute('d')).not.toBe(customPath)
  expect(marks.map(mark => mark.regionId)).toEqual(['same-file', 'same-controlled-browser', 'same-idle-browser'])
})

it('Desktop navigation consumes shared destination meanings and keeps original Store destinations', async () => {
  const set = vi.fn(); useAppStore.setState({ setMainSurface: set })
  await dom.render(<SurfaceSwitch />)
  for (const [label, role, destination] of [
    ['Space: show terminal and file workbench', 'navigation.space', 'workbench'],
    ['Focus: show execution contexts', 'navigation.focus', 'agents'],
    ['Goals: show goals and progress', 'navigation.goals', 'board'],
    ['Survey: browse and explore', 'navigation.survey', 'survey'],
    ['Recall: keep and revisit knowledge', 'navigation.recall', 'recall']
  ] as const) {
    const button = dom.container.querySelector(`[aria-label^="${label}"]`)!
    drawing(button, role); expect(button.querySelector('[data-icon-animation]')).toBeNull()
    await override(role); expect(dom.container.querySelector(`[aria-label^="${label}"]`)).toBe(button)
    await click(button); expect(set).toHaveBeenLastCalledWith(destination)
  }
  expect(set).toHaveBeenCalledTimes(5)
})

it('history window keeps recorded-time selection independent of schedules and original records', async () => {
  const choose = vi.fn(), opened = vi.fn()
  await dom.render(<ConversationRulerControls window="1h" onWindow={choose} untimed={[]} onSelect={vi.fn()} describe={() => ({ name: 'Original' }) as never} onOpen={opened} />)
  const button = dom.container.querySelector('[aria-label="History window: 1h"]')!
  drawing(button, 'conversation.history-window'); await override('conversation.history-window')
  await open(button); await click(item('All · bounded reading'))
  expect(choose).toHaveBeenCalledExactlyOnceWith('all'); expect(opened).toHaveBeenCalled()
  expect(dom.container.querySelector('[aria-label="History window: 1h"]')).toBe(button)
})

it('Notebook switcher identifies the collection and selects the exact original Notebook', async () => {
  const select = vi.fn(), create = vi.fn()
  await dom.render(<NotebookSelector active pending={false} notebooks={[{ notebookId: 'one', name: 'Original book', createdAt: _historyFixtureEpoch(0, 0, 1) }, { notebookId: 'two', name: 'Second book', createdAt: _historyFixtureEpoch(0, 0, 2) }]} selectedId="one" onSelect={select} onCreate={create} />)
  const button = dom.container.querySelector('[aria-label="Switch notebook"]')!
  drawing(button, 'object.notebook'); await override('object.notebook'); await open(button)
  const target = document.querySelector('[aria-label="Switch to notebook: Second book"]')!
  drawing(target, 'object.notebook'); await click(target)
  expect(select).toHaveBeenCalledExactlyOnceWith('two'); expect(create).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[aria-label="Switch notebook"]')).toBe(button)
})

it('Topic reveal and Wiki menu use location and note actions while retaining exact original callbacks', async () => {
  const reveal = vi.fn(), wiki = vi.fn()
  const props = { title: 'Original Topic', pinned: false, onCopyPath: vi.fn(), onCopyLink: vi.fn(), onRename: vi.fn(), onReveal: reveal, onTogglePin: vi.fn(), onEditWiki: wiki }
  await dom.render(<TopicActionsMenu {...props} />)
  const trigger = dom.container.querySelector('[aria-label="Actions for Original Topic"]')!
  await open(trigger); drawing(item('Reveal in Files'), 'action.locate'); drawing(item('Edit Topic Wiki'), 'action.edit-note')
  await override('action.locate'); await click(item('Reveal in Files')); expect(reveal).toHaveBeenCalledOnce()
  // Menu removal precedes Radix FocusScope's deferred return-focus. Reopen only
  // after the original invoker has actually received it, as a real key user does.
  await vi.waitFor(() => { expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger) })
  await open(trigger); await vi.waitFor(() => expect(item('Edit Topic Wiki')).not.toBeNull())
  await click(item('Edit Topic Wiki')); await vi.waitFor(() => expect(wiki).toHaveBeenCalledOnce())
  expect(props.onCopyPath).not.toHaveBeenCalled(); expect(props.onRename).not.toHaveBeenCalled()
})

it('Create Worktree is the original filesystem action and no longer claims to fork a conversation', async () => {
  const create = vi.fn()
  await dom.render(<BranchContextMenu hasWorktree={false} onOpen={create} onCopyBranchName={vi.fn()} onCopyWorktreePath={vi.fn()} onRefresh={vi.fn()} onRemoveWorktree={vi.fn()}><button>Original branch</button></BranchContextMenu>)
  await act(async () => dom.container.querySelector('button')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })))
  drawing(item('Create Worktree'), 'action.create-worktree'); await click(item('Create Worktree'))
  expect(create).toHaveBeenCalledOnce()
})

it('recorded native collaboration remains a read-only observation with original participants and record body', async () => {
  const record = { id: 'same-record', contentParts: [], collaboration: { kind: 'operation', operation: 'send-input', status: 'running', sender: { providerId: 'protocol', nativeSessionId: 'source-native' }, receivers: [{ providerId: 'protocol', nativeSessionId: 'target-native' }], agentStates: [], prompt: 'Original recorded prompt' } } as unknown as AgentSessionHistoryItem
  await dom.render(<NativeProcessObservation id="same-group" items={[record]} renderRecord={(original, wrap) => <div key={original.id}>{wrap(<p>Original untouched native record</p>)}</div>} />)
  const row = dom.container.querySelector('[data-native-step-id="same-record"]')!
  drawing(row, 'object.collaboration'); expect(row.querySelector('[data-icon-animation]')).toBeNull()
  await override('object.collaboration'); await click(row.querySelector('button'))
  expect(row.textContent).toContain('source-native'); expect(row.textContent).toContain('target-native'); expect(row.textContent).toContain('Original recorded prompt')
  expect(row.textContent).toContain('Original untouched native record'); expect(record.collaboration?.status).toBe('running')
})

it('Notebook graph entrance and cover retain original collection identity without borrowing Git branches or Note pages', async () => {
  const book = { notebookId: 'one', name: 'Original collection', createdAt: _historyFixtureEpoch(0, 0, 1) }, openGraph = vi.fn(), create = vi.fn()
  await dom.render(<><NotebookNavigation notebooks={[book]} pages={[]} selectedId="one" selectedNoteId={null} onSelect={vi.fn()} onOpen={vi.fn()} onCreateChild={vi.fn()} query="" onQuery={vi.fn()} onCreate={create} pending={false} actions={null} archived={false} onArchivedChange={vi.fn()} onOpenGraph={openGraph} /><NotebookHome notebook={book} pages={[]} pending={false} onCreate={create} onOpen={vi.fn()} query="" /></>)
  const graph = dom.container.querySelector('[aria-label="Notebook graph"]')!
  drawing(graph, 'object.relationships'); drawing(dom.container.querySelector('.notebook-cover-mark'), 'object.notebook')
  await override('object.relationships'); await click(graph)
  expect(openGraph).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-notebook-id="one"]')).not.toBeNull()
})

it.each(['server.p12', 'server.pfx'])('the real path label identifies %s as key-container syntax without claiming encryption', async path => {
  await dom.render(<FilePathLabel path={'certificates/' + path} />)
  const label = dom.container.querySelector('.file-path-label')!
  drawing(label, 'file.key'); expect(label.getAttribute('title')).toBe('certificates/' + path)
  await override('file.key'); expect(dom.container.querySelector('.file-path-label')).toBe(label)
  expect(label.textContent).toContain(path); expect(label.querySelector('[data-semantic-icon="file.locked"]')).toBeNull()
})

it('pending delivery separates queued, unknown and active preparation drawings without changing original message facts', async () => {
  const send = vi.fn(), more = vi.fn()
  const entries = [
    { id: 'queued', text: 'Original queued', status: 'queued' as const, deliverable: true },
    { id: 'unknown', text: 'Original unknown', status: 'deferred' as const, deliverable: false, unconfirmed: true },
    { id: 'busy', text: 'Original preparation', status: 'queued' as const, deliverable: true, preparing: true }
  ]
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
  function Harness() { const anchor = useRef<HTMLButtonElement>(null), surface = useRef<HTMLElement>(null)
    return <><button ref={anchor}>Original anchor</button><ComposerPendingDelivery queued={entries} pendingInteraction={false} anchorRef={anchor} surfaceRef={surface} onSend={send} onMore={more} /></>
  }
  await dom.render(<Harness />)
  for (const [id, role, animation] of [['queued', 'status.queued', null], ['unknown', 'status.unknown', null], ['busy', 'status.loading', 'spin']] as const) {
    const row = document.querySelector(`[data-operation-id="${id}"].composer-pending__card`)!
    drawing(row.querySelector('.composer-pending__state'), role)
    expect(row.querySelector('.composer-pending__state [data-icon-animation]')?.getAttribute('data-icon-animation') ?? null).toBe(animation)
    expect(row.textContent).toContain(entries.find(entry => entry.id === id)!.text)
  }
  await override('status.queued'); expect(entries[2]!.preparing).toBe(true)
  expect(send).not.toHaveBeenCalled(); expect(more).not.toHaveBeenCalled()
})

it('Topic knowledge header uses the Topic identity and reads only its exact original target', async () => {
  const workspace = composerConfig.workspaces[0]!, topic = { id: 'launcher:semantic-topic', title: 'Original Topic', directoryPath: workspace.path + '/topic--launcher--semantic-topic', topicPath: workspace.path + '/topic--launcher--semantic-topic/topic.md', summary: '', collaborators: [] }
  const read = vi.spyOn(api.topics, 'call').mockImplementation(async method => (method === 'topic.inspect' ? { topic: { topicId: topic.id, title: topic.title, categorySpaceIds: [] }, unavailable: [] } : { entries: [], documents: [], unavailable: [] }) as never)
  await dom.render(<TopicKnowledgePanel workspace={workspace} topic={topic} />)
  const header = dom.container.querySelector('.topic-knowledge-scope')!
  drawing(header, 'object.topic'); await override('object.topic')
  expect(dom.container.querySelector('.topic-knowledge-scope')).toBe(header); expect(header.textContent).toBe(topic.title)
  expect(read).toHaveBeenCalledWith('topic.inspect', { topicId: topic.id }); expect(read).toHaveBeenCalledWith('topic.knowledge.ls', { topicId: topic.id, limit: 100 })
  expect(read).toHaveBeenCalledTimes(2); expect(dom.draft()).toBe('Keep my draft')
})
