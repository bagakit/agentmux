import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import * as speakerMetadata from '../src/renderer/src/lib/conversation-sender-details'
import { expandSemanticReferences, parseComposerDraft } from '@agentmux/client-ui/composer-semantic-reference'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const editor = () => dom.container.querySelector<HTMLElement & { editor: Editor }>('[role="textbox"]')!.editor
const wait = async (assert: () => void) => { await vi.waitFor(async () => { await act(async () => {}); assert() }) }
async function text(value: string, caret = value.length) {
  await act(async () => { editor().commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: value ? [{ type: 'text', text: value }] : [] }] }); editor().commands.setTextSelection(caret + 1) })
}
const options = () => [...document.querySelectorAll<HTMLButtonElement>('.composer__suggestions [role="option"]')]
async function choose(find: (button: HTMLButtonElement) => boolean) {
  await wait(() => expect(options().some(find), options().map(item => item.textContent).join('\n')).toBe(true))
  await act(async () => options().find(find)!.click())
}
beforeEach(() => {
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ path: 'src', name: 'src', isDirectory: true, isSymlink: false }, { path: 'notes.md', name: 'notes.md', isDirectory: false, isSymlink: false }])
  vi.spyOn(api.ui, 'listAgentSkills').mockResolvedValue([{ name: 'review', path: _historyFixturePath("original/skills/review/SKILL.md"), description: 'Original project skill', source: 'project' }])
  vi.spyOn(api.ui, 'listWorkspaceSkills').mockResolvedValue([{ name: 'review', path: _historyFixturePath("original/skills/review/SKILL.md"), description: 'Original project skill', source: 'project' }])
  vi.spyOn(useAppStore.getState(), 'prewarmTerminal').mockResolvedValue(undefined)
  vi.spyOn(useAppStore.getState(), 'releaseWarmTerminal').mockResolvedValue(undefined)
  vi.spyOn(useAppStore.getState(), 'detectExecutors').mockResolvedValue(undefined)
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
  useAppStore.setState({ providerCatalog: [{ id: 'codex', label: 'Codex', composer: { commands: [{ text: '/context', description: 'Provider context command' }] } }] as never,
    sessions: [composerSession(), composerSession('peer-one'), composerSession('peer-two')],
    agentNames: { 'peer-one': 'Review Agent', 'peer-two': 'Review Agent' }, agentComposerDrafts: { 'agent-1': '' }, timelines: {},
    config: { ...composerConfig, composerShortcuts: [{ id: 'shortcut', keyword: 'brief', label: 'Write a brief', body: 'Exact original prompt' }] } })
})

it('actual Session uses the original skill owner at an interior caret, preserves following text and Undo, and tool selection emits the same payload', async () => {
  const dispatch = vi.spyOn(useAppStore.getState(), 'send').mockReturnValue(false)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await text('left $rev right', 'left $rev'.length)
  await choose(button => button.textContent?.includes('Original project skill') ?? false)
  const typed = expandSemanticReferences(dom.draft()!)
  expect(typed).toBe(("left @" + _historyFixturePath("original/skills/review/SKILL.md") + "  right"))
  await act(async () => { expect(editor().commands.undo()).toBe(true) })
  expect(dom.draft()).toBe('left $rev right')
  await text('left  right', 5)
  await dom.click('.composer-tool--mode')
  const skill = dom.container.querySelector('[aria-label="Choose a skill"]')!
  await act(async () => skill.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
  await wait(() => expect(document.querySelector('[role="menu"]')?.textContent).toContain('Original project skill'))
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.includes('Original project skill'))!.click())
  expect(expandSemanticReferences(dom.draft()!)).toBe(("left @" + _historyFixturePath("original/skills/review/SKILL.md") + " right"))
  expect(dispatch).not.toHaveBeenCalled()
})

it('original command tools search the visible prompt label and keep working when quick-input prefixes are disabled', async () => {
  const send = vi.spyOn(useAppStore.getState(), 'send').mockReturnValue(false)
  useAppStore.setState({ config: { ...useAppStore.getState().config!, messageToolCompletion: { command: null, skill: null, reference: null, keywords: false } } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await text('Original draft', 0)
  await dom.click('.composer-tool--mode')
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible={false} />)
  const trigger = dom.container.querySelector<HTMLElement>('[aria-label="Choose a command"]')!
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
  const input = document.querySelector<HTMLInputElement>('[aria-label="Find commands"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Write a')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items).toHaveLength(1)
  expect(items[0]!.textContent).toContain('Write a brief')
  await act(async () => items[0]!.click())
  expect(expandSemanticReferences(dom.draft()!)).toBe('Exact original prompt Original draft')
  expect(send).not.toHaveBeenCalled()
})

it('actual Session disambiguates same-name Agent references by original identity without navigation, dispatch or queue changes', async () => {
  const open = vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined)
  const send = vi.spyOn(useAppStore.getState(), 'send').mockReturnValue(false)
  const originalQueue = { operationId: 'unchanged', runId: 'run-agent-1', text: 'Original uncertain text', status: 'deferred' as const, inputIntakeStarted: true as const }
  useAppStore.setState({ agentSteerQueues: { 'agent-1': [originalQueue] } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await text('before @Review after', 'before @Review'.length)
  await choose(button => button.textContent?.includes('peer-two') ?? false)
  const chosen = parseComposerDraft(dom.draft()!).filter(part => 'reference' in part)
  expect(chosen).toHaveLength(1)
  expect(chosen[0]).toMatchObject({ reference: { kind: 'agent', label: 'Review Agent', reference: 'amux://agent/peer-two' } })
  expect(expandSemanticReferences(dom.draft()!)).toBe('before amux://agent/peer-two  after')
  expect(open).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues['agent-1']).toEqual([originalQueue])
  await act(async () => editor().commands.undo()); expect(dom.draft()).toBe('before @Review after')
})

it('configured command prefix keeps Provider syntax; turning a quick input off preserves ordinary Send and the written text', async () => {
  const send = vi.spyOn(useAppStore.getState(), 'send').mockReturnValue(false)
  useAppStore.setState({ config: { ...useAppStore.getState().config!, messageToolCompletion: { command: '!', skill: '%', reference: '#', keywords: false } } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await text('!cont')
  await choose(button => button.textContent?.includes('/context') ?? false)
  expect(dom.draft()).toBe('/context ')
  await text('#Review')
  await wait(() => expect(options().length).toBe(2))
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, messageToolCompletion: { command: '!', skill: '%', reference: null, keywords: false } } }))
  await wait(() => expect(options()).toHaveLength(0))
  expect(dom.draft()).toBe('#Review')
  await act(async () => editor().view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })))
  expect(send).toHaveBeenCalledWith('agent-1', '#Review', expect.any(Function), 'manual', undefined, { inputImages: [] })
})

it('a failed directory read keeps exact Agent choices and ordinary draft editing; directory selection reads only its original child path', async () => {
  const directory = vi.mocked(api.files.readDirectory)
  directory.mockRejectedValueOnce(new Error('Original workspace unavailable'))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await text('@Review')
  await wait(() => expect(document.body.textContent).toContain('Original workspace unavailable'))
  expect(options()).toHaveLength(2)
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!.click())
  await text('@src')
  await choose(button => button.textContent?.includes('src') ?? false)
  await wait(() => expect(directory).toHaveBeenCalledWith('workspace', 'src'))
  expect(dom.draft()).toBe('@src/')
})

it('Launcher consumes the same configured skill and Agent menu without starting an Agent or losing the original launch draft', async () => {
  const create = vi.spyOn(useAppStore.getState(), 'launchAgent').mockResolvedValue(undefined)
  useLauncherState.setState({ sections: { workspace: { agents: 'expanded', terminal: 'hidden' } } })
  useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) }, activeWorkspaceId: 'workspace',
    config: { ...useAppStore.getState().config!, messageToolCompletion: { command: '/', skill: '%', reference: '@', keywords: true } } })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" />)
  await text('left %rev right', 'left %rev'.length)
  await choose(button => button.textContent?.includes('Original project skill') ?? false)
  expect(api.ui.listWorkspaceSkills).toHaveBeenCalledWith('workspace', 'codex')
  expect(editor().getText()).toContain('review')
  await text('launch @Review later', 'launch @Review'.length)
  await choose(button => button.textContent?.includes('peer-one') ?? false)
  expect(editor().getJSON().content?.[0]?.content?.some(node => node.type === 'toolReference' && node.attrs?.reference === 'amux://agent/peer-one')).toBe(true)
  expect(create).not.toHaveBeenCalled()
})

it('same Session source replacement retires its open skill menu and late files, while the original editor and draft survive', async () => {
  let oldFiles!: (value: Awaited<ReturnType<typeof api.files.readDirectory>>) => void
  const directory = vi.mocked(api.files.readDirectory)
  directory.mockImplementationOnce(() => new Promise(resolve => { oldFiles = resolve }))
    .mockResolvedValue([{ name: 'current.txt', path: 'current.txt', isDirectory: false, isSymlink: false }])
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await text('@')
  await wait(() => expect(directory).toHaveBeenCalledTimes(1))
  await dom.click('.composer-tool--mode')
  await act(async () => dom.container.querySelector('[aria-label="Choose a skill"]')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })))
  await wait(() => expect(document.querySelector('[role="menu"]')?.textContent).toContain('Original project skill'))
  const retainedEditor = editor()
  await act(async () => useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(workspace => ({ ...workspace, path: _historyFixturePath("replacement-project") })) },
    sessions: state.sessions.map(session => session.id === 'agent-1' ? { ...session, workspacePath: _historyFixturePath("replacement-project") } : session) })))
  await wait(() => expect(options().some(option => option.textContent?.includes('current.txt'))).toBe(true))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await act(async () => oldFiles([{ name: 'obsolete.txt', path: 'obsolete.txt', isDirectory: false, isSymlink: false }]))
  expect(options().some(option => option.textContent?.includes('obsolete.txt'))).toBe(false)
  expect(editor()).toBe(retainedEditor); expect(dom.draft()).toBe('@')
})

it('an open Agent menu reuses identity projection when unrelated streaming tokens change, then updates a real renamed candidate', async () => {
  const project = vi.spyOn(speakerMetadata, 'createConversationSpeakerMetadataReader')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await text('@Review')
  await wait(() => expect(options()).toHaveLength(2))
  const reads = project.mock.calls.length
  expect(reads).toBeGreaterThan(0)
  for (let revision = 1; revision <= 6; revision++) await act(async () => useAppStore.setState(state => ({ timelines: {
    ...state.timelines, 'peer-two': { agentSessionId: 'peer-two', revision, items: [{ id: 'stream', agentSessionId: 'peer-two', kind: 'assistant_message', status: 'streaming', source: 'native-hook', content: `token ${revision}` }] }
  } })))
  expect(options()).toHaveLength(2)
  expect(project).toHaveBeenCalledTimes(reads)
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'peer-two': 'Different role' } })))
  await wait(() => expect(options()).toHaveLength(1))
  expect(project.mock.calls.length).toBeGreaterThan(reads)
})
