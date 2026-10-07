// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { expect, it, vi } from 'vitest'
import { expandSemanticReferences } from '@agentmux/client-ui/composer-semantic-reference'
import { createCodexProvider } from '../../../packages/core/src/providers/codex'
import { defineAgentProvider } from '../../../packages/core/src/agent-provider'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { AgentComposerTools } from '../src/renderer/src/components/AgentComposerTools'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const skills = [
  { name: 'Review', description: 'Inspect exact changes', source: 'project' as const, path: fixturePath('skills/review/SKILL.md') },
  { name: 'Explain', description: 'Describe the architecture', source: 'user' as const, path: fixturePath('skills/explain/SKILL.md') }
]
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!
const query = () => menu().querySelector<HTMLInputElement>('input')!
const items = () => [...menu().querySelectorAll<HTMLElement>('[role="menuitem"]')]
const trigger = (kind = 'skill') => dom.container.querySelector<HTMLButtonElement>('[aria-label="Choose a ' + kind + '"]')!
const key = async (node: HTMLElement, value: string, extra = {}) => {
  await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra })))
  await act(async () => new Promise(done => setTimeout(done, 30)))
}
async function search(value: string) {
  await act(async () => {
    const input = query()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function open(kind = 'skill') { await act(async () => { trigger(kind).focus() }); await key(trigger(kind), 'ArrowDown'); await vi.waitFor(() => expect(menu()).not.toBeNull()) }
async function session() { await dom.render(<AgentSessionComposer sessionId="agent-1" />); await dom.click('.composer-tool--mode') }
async function close() { await key(query(), 'Escape'); await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull()) }

it('queries real skill descriptions and sources, then inserts the exact original choice', async () => {
  const discover = vi.spyOn(api.ui, 'listAgentSkills').mockResolvedValue(skills)
  await session(); const original = dom.draft()
  await open(); await search('architecture')
  expect(items()).toHaveLength(1); expect(items()[0]!.textContent).toContain('Explain')
  expect(dom.draft()).toBe(original)
  await search('project'); expect(items()).toHaveLength(1); expect(items()[0]!.textContent).toContain('Review')
  await search('architecture'); await key(query(), 'ArrowDown'); expect(document.activeElement).toBe(items()[0])
  await key(items()[0]!, 'Enter')
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  expect(discover).toHaveBeenCalledExactlyOnceWith('agent-1')
  expect(dom.draft()).toContain(original); expect(expandSemanticReferences(dom.draft()!)).toContain('@' + skills[1]!.path); expect(dom.draft()).not.toContain(skills[0]!.path)
  // The original maintained insertion can retain its editor; menu dismissal can restore
  // its trigger. Neither path may move focus to another Session or the document body.
  await vi.waitFor(() => expect([trigger(), dom.container.querySelector('.tiptap')]).toContain(document.activeElement))
})

it('query, no match, clear and reopen preserve original editor, draft and selection', async () => {
  vi.spyOn(api.ui, 'listAgentSkills').mockResolvedValue(skills)
  const write = vi.spyOn(api.sessions, 'write')
  await session()
  const editor = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')!
  await act(async () => editor.editor.commands.setTextSelection({ from: 2, to: 5 }))
  const selection = editor.editor.state.selection.toJSON(), draft = dom.draft()
  await open(); await search('no matching skill')
  expect(items()).toHaveLength(0); expect(menu().querySelector('[role="status"]')?.textContent).toBe('No matching skills.')
  await key(query(), 'Enter'); expect(menu()).not.toBeNull(); expect(dom.draft()).toBe(draft); expect(write).not.toHaveBeenCalled()
  await key(query(), 'Tab'); const clear = menu().querySelector<HTMLButtonElement>('[aria-label="Clear skills search"]')!
  expect(document.activeElement).toBe(clear)
  await act(async () => clear.click()); expect(query().value).toBe(''); expect(document.activeElement).toBe(query()); expect(items()).toHaveLength(2)
  await search('project'); await close(); await vi.waitFor(() => expect(document.activeElement).toBe(trigger()))
  await open(); expect(query().value).toBe(''); expect(items()).toHaveLength(2)
  expect(dom.container.querySelector('.tiptap')).toBe(editor); expect(editor.editor.state.selection.toJSON()).toEqual(selection); expect(dom.draft()).toBe(draft)
})

it('search IME and modified Enter do not select, close or submit from the real menu', async () => {
  vi.spyOn(api.ui, 'listAgentSkills').mockResolvedValue(skills)
  const write = vi.spyOn(api.sessions, 'write')
  await session(); const draft = dom.draft(); await open(); await search('architecture')
  for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
    await key(query(), 'Enter', extra); await key(query(), 'Escape', extra); await key(query(), 'ArrowDown', extra)
    expect(document.activeElement).toBe(query()); expect(menu()).not.toBeNull()
  }
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) await key(query(), 'Enter', extra)
  expect(dom.draft()).toBe(draft); expect(write).not.toHaveBeenCalled(); expect(items()).toHaveLength(1)
  await key(query(), 'ArrowDown'); const item = items()[0]!
  await key(item, 'Enter', { isComposing: true }); expect(menu()).not.toBeNull(); expect(dom.draft()).toBe(draft)
})

it('hover keeps rich-editor focus and Range; explicitly using search pins the original menu', async () => {
  vi.spyOn(api.ui, 'listAgentSkills').mockResolvedValue(skills)
  await session()
  const editor = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')!
  await act(async () => { editor.focus(); editor.editor.commands.setTextSelection({ from: 2, to: 5 }) })
  const selection = editor.editor.state.selection.toJSON()
  await act(async () => trigger().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(menu()).not.toBeNull(); expect(document.activeElement).toBe(editor); expect(editor.editor.state.selection.toJSON()).toEqual(selection)
  await act(async () => { query().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })); query().focus() })
  await act(async () => menu().dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body, buttons: 0 })))
  await act(async () => new Promise(done => setTimeout(done, 220)))
  expect(menu()).not.toBeNull(); expect(document.activeElement).toBe(query()); expect(dom.draft()).toBe('Keep my draft')
})

it('clicking the original hovered trigger enters query so subsequent typing never changes the draft', async () => {
  vi.spyOn(api.ui, 'listAgentSkills').mockResolvedValue(skills)
  await session()
  const editor = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')!
  await act(async () => { editor.focus(); editor.editor.commands.setTextSelection({ from: 2, to: 5 }) })
  const selection = editor.editor.state.selection.toJSON()
  await act(async () => trigger().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  expect(document.activeElement).toBe(editor)
  await act(async () => trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 })))
  expect(document.activeElement).toBe(query())
  await search('architecture')
  await act(async () => menu().dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body, buttons: 0 })))
  await act(async () => new Promise(done => setTimeout(done, 220)))
  expect(menu()).not.toBeNull(); expect(items()).toHaveLength(1); expect(dom.draft()).toBe('Keep my draft')
  expect(editor.editor.state.selection.toJSON()).toEqual(selection)
})

it.each(['resolve', 'reject'] as const)('stale discovery %s after reopen cannot replace current choices or failure', async outcome => {
  let resolve!: (value: typeof skills) => void, reject!: (error: Error) => void
  vi.spyOn(api.ui, 'listAgentSkills').mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no })).mockResolvedValueOnce([skills[1]!])
  await session(); await open(); expect(menu().textContent).toContain('Loading skills…'); await close(); await open()
  expect(items()[0]!.textContent).toContain('Explain')
  await act(async () => { if (outcome === 'resolve') resolve([skills[0]!]); else reject(new Error('Old discovery failed')) })
  expect(items()).toHaveLength(1); expect(items()[0]!.textContent).toContain('Explain'); expect(document.body.textContent).not.toContain('Old discovery failed')
  expect(dom.draft()).toBe('Keep my draft')
})

it('switching exact Session invalidates its old query and discovery through original parent scope', async () => {
  let resolve!: (value: typeof skills) => void
  const discover = vi.spyOn(api.ui, 'listAgentSkills').mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValueOnce([skills[1]!])
  useAppStore.setState({ sessions: [composerSession(), composerSession('agent-2')], agentComposerDrafts: { 'agent-1': 'First draft', 'agent-2': 'Second draft' } })
  await session(); await open(); await search('old query')
  await dom.render(<AgentSessionComposer sessionId="agent-2" />)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  await dom.click('.composer-tool--mode'); await open(); expect(query().value).toBe('')
  await act(async () => resolve([skills[0]!]))
  expect(items()[0]!.textContent).toContain('Explain'); expect(discover.mock.calls).toEqual([['agent-1'], ['agent-2']])
  expect(dom.draft()).toBe('First draft'); expect(dom.draft('agent-2')).toBe('Second draft')
})

it('original Launcher command menu queries descriptions and inserts only its explicit command', async () => {
  vi.spyOn(useAppStore.getState(), 'prewarmTerminal').mockResolvedValue(undefined)
  vi.spyOn(useAppStore.getState(), 'releaseWarmTerminal').mockResolvedValue(undefined)
  vi.spyOn(useAppStore.getState(), 'detectExecutors').mockResolvedValue(undefined)
  useAppStore.setState({ tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) }, activeWorkspaceId: 'workspace', agentComposerDrafts: { region: 'Launch draft' } })
  useAppStore.setState({ providerCatalog: [createCodexProvider(defineAgentProvider).catalog] })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" />)
  await act(async () => [...dom.container.querySelectorAll<HTMLButtonElement>('.agent-pick')].find(button => button.textContent?.includes('Codex'))!.click())
  const originalEditor = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')!.editor
  await act(async () => originalEditor.commands.setTextSelection(1))
  const draft = dom.draft('region'); await open('command'); expect(items().length).toBeGreaterThan(1)
  const target = items().find(item => item.textContent?.includes('/status'))!
  expect(target).toBeDefined(); const text = target.querySelector('span')!.firstChild!.textContent!
  const description = target.querySelector('small')!.textContent!
  await search(description); expect(items().some(item => item.textContent?.includes(text))).toBe(true); expect(dom.draft('region')).toBe(draft)
  await search('no matching command'); expect(items()).toHaveLength(0); expect(menu().textContent).toContain('No matching commands.')
  await search(description); await act(async () => items().find(item => item.textContent?.includes(text))!.click())
  expect(dom.draft('region')).toBe(text + ' ' + draft); expect(document.querySelector('[role="menu"]')).toBeNull(); await vi.waitFor(() => expect(document.activeElement).toBe(trigger('command')))
})

it('still-open menu cannot insert once its original surface becomes disabled', async () => {
  const onCommand = vi.fn()
  const props = { commands: [{ text: '/status', description: 'Status' }], loadSkills: async () => [], onChooseSkill: vi.fn(), onCommand, runAction: async (action: () => void | Promise<void>) => { await action() }, layoutControl: false }
  await dom.render(<AgentComposerTools {...props} disabled={false} />); await open('command')
  await dom.render(<AgentComposerTools {...props} disabled />)
  await act(async () => items()[0]!.click())
  expect(onCommand).not.toHaveBeenCalled()
})
