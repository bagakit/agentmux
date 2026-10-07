import { act, useState, type Dispatch, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ComposerCompletionEditor, type ComposerCompletionProps } from '../src/components/ComposerCompletionEditor.js'
import { AgentComposer } from '../src/components/AgentComposer.js'
import { documentDraft } from '../src/components/InlineComposer.js'
import { encodeSemanticReference, expandSemanticReferences } from '../src/lib/composer-semantic-reference.js'
import type { ComposerInsertionHandle } from '../src/lib/composer-insertion.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
const original = encodeSemanticReference({ token: '', kind: 'file', label: 'original.txt', reference: '@original.txt' })
const agent = (sid: string) => encodeSemanticReference({ token: '', kind: 'agent', label: 'Same name', reference: 'amux://agent/' + sid })
async function mount(value: string, props: ComposerCompletionProps = {}, shell = false) {
  let setProps!: Dispatch<SetStateAction<ComposerCompletionProps>>, setDisabled!: Dispatch<SetStateAction<boolean>>
  let insertion: ComposerInsertionHandle | null = null
  const changed = vi.fn(), submitted = vi.fn(), queued = vi.fn(), activated = vi.fn(), downstream = vi.fn()
  function Scene() {
    const [draft, setDraft] = useState(value), [completion, update] = useState(props), [disabled, disable] = useState(false)
    setProps = update; setDisabled = disable
    const common = { value: draft, disabled, placeholder: 'Message', insertionRef: (handle: ComposerInsertionHandle | null) => { insertion = handle }, ...completion }
    const change = (value: string) => { changed(value); setDraft(value) }
    return <ClientUiProvider platform={platform}>{shell
      ? <AgentComposer {...common} onChange={change} onSubmit={submitted} onQueue={queued} onActivateSemanticReference={activated} />
      : <ComposerCompletionEditor {...common} aria-label="Draft" onValueChange={change} onKeyDown={downstream} onActivateReference={activated} />}</ClientUiProvider>
  }
  await act(async () => root.render(<Scene />))
  return { changed, submitted, queued, activated, downstream, insertion: () => insertion!,
    update: async (next: ComposerCompletionProps) => { await act(async () => setProps(next)) },
    disable: async () => { await act(async () => setDisabled(true)) } }
}
const editor = () => (host.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
const draft = () => documentDraft(editor().getJSON())
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
async function caretAtText(value: string) {
  let target = 0
  editor().state.doc.descendants((node, pos) => { const at = node.isText ? node.text!.indexOf(value) : _historyFixtureEpoch(0, 0, -1); if (at >= 0) { target = pos + at + value.length; return false } })
  expect(target).toBeGreaterThan(0)
  await act(async () => { editor().commands.setTextSelection(target); editor().commands.focus() })
}
async function key(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement?.closest('[role="option"]') ?? host.querySelector('[role="textbox"]')!
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  if (init.isComposing !== undefined) Object.defineProperty(event, 'isComposing', { value: init.isComposing })
  await act(async () => target.dispatchEvent(event)); return event
}
it('replaces the configured query at the real caret and preserves following text, prior semantic nodes, Undo and Redo', async () => {
  const selected = { id: 'specific-command', text: '/review', description: 'Original command', insertText: '/review actual' }
  const choose = vi.fn(() => undefined), query = vi.fn()
  const initial = original + ' before !rev after @untouched'
  await mount(initial, { completionConfig: { command: '!', skill: '%', reference: '#', keywords: true }, commands: [selected], onCompletionQuery: query, onSelectSuggestion: choose })
  await caretAtText('!rev')
  expect(options().map(item => item.textContent)).toEqual(['/reviewOriginal command'])
  expect(query).toHaveBeenLastCalledWith({ kind: 'command', query: 'rev' })
  await act(async () => options()[0]!.click())
  expect(draft()).toBe(original + ' before /review actual  after @untouched')
  expect(choose).toHaveBeenCalledWith('/review', 'command', selected)
  expect(host.querySelectorAll('[data-tool-reference="file"]')).toHaveLength(1)
  expect(document.activeElement).toBe(host.querySelector('.tiptap'))
  await act(async () => editor().commands.undo()); expect(draft()).toBe(initial)
  await act(async () => editor().commands.redo()); expect(draft()).toBe(original + ' before /review actual  after @untouched')
})
it('chooses the original duplicate-name Agent by id and stores a readable durable card with exact link, disclosure and removal Undo', async () => {
  const first = { id: 'agent:first', text: '@Same', label: 'Same name', description: 'Host one', insertText: agent('first') }
  const second = { id: 'agent:second', text: '@Same', label: 'Same name', description: 'Host two', insertText: agent('second') }
  const { activated, submitted, queued } = await mount('before @Sa after', { references: [first, second] }, true)
  await caretAtText('@Sa'); expect(options()).toHaveLength(2)
  await act(async () => options()[1]!.click())
  const selected = 'before ' + agent('second') + '  after'
  expect(draft()).toBe(selected)
  expect(expandSemanticReferences(draft())).toBe('before amux://agent/second  after')
  const name = host.querySelector<HTMLButtonElement>('[aria-label="Agent reference: amux://agent/second"]')!
  expect(name).not.toBeNull(); expect(name.textContent).toBe('Same name')
  await act(async () => name.click())
  expect(host.querySelector('.composer-file__reference code')?.textContent).toBe('amux://agent/second')
  expect(host.querySelector('.composer-file__reference button')).toBeNull()
  expect(activated).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled(); expect(queued).not.toHaveBeenCalled()
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove Agent from draft"]')!.click())
  expect(draft()).toBe('before   after')
  await act(async () => editor().commands.undo()); expect(draft()).toBe(selected)
  await act(async () => editor().commands.undo()); expect(draft()).toBe('before @Sa after')
})
it('uses one actual item for keyword menu and Tab expansion; moving caret and selected text retain editing ownership', async () => {
  const selected = { id: 'prompt:original', text: 'review-changes', description: 'Prompt', insertText: 'original full prompt' }
  const { downstream } = await mount('before review-changes after', { promptKeywords: [selected] })
  await caretAtText('review-changes'); expect(options()).toHaveLength(1)
  expect((await key('Tab')).defaultPrevented).toBe(true)
  expect(draft()).toBe('before original full prompt  after')
  await act(async () => editor().commands.undo())
  await caretAtText('review-'); expect(options()).toHaveLength(1)
  expect((await key('Tab')).defaultPrevented).toBe(false); expect(draft()).toBe('before review-changes after')
  await act(async () => editor().commands.setTextSelection({ from: 1, to: 7 }))
  expect(options()).toHaveLength(0)
  await key('ArrowDown'); expect(downstream).toHaveBeenCalled()
})
it('respects live disabled triggers and ordinary Send, while IME and modified Enter never select candidates', async () => {
  const props = { references: [{ text: '@Same', description: 'Exact original Agent', insertText: agent('original') }] }
  const { update, queued, submitted } = await mount('@Sa', props, true)
  await caretAtText('@Sa'); expect(options()).toHaveLength(1)
  await act(async () => host.querySelector('[role="textbox"]')!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  expect(editor().view.composing).toBe(true); expect(options()).toHaveLength(0)
  await key('Enter', { isComposing: true })
  expect(queued).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled(); expect(draft()).toBe('@Sa')
  await act(async () => host.querySelector('[role="textbox"]')!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  await vi.waitFor(() => expect(editor().view.composing).toBe(false))
  await caretAtText('@Sa')
  await key('Enter', { ctrlKey: true }); expect(submitted).toHaveBeenCalledTimes(1); expect(draft()).toBe('@Sa')
  await update({ ...props, completionConfig: { command: null, skill: null, reference: null, keywords: false } })
  expect(options()).toHaveLength(0)
  await key('Enter'); expect(queued).toHaveBeenCalledTimes(1)
  await update(props); expect(options()).toHaveLength(1)
})
it('retains real focused-option arrow/Enter/Escape ownership without taking ordinary editor Enter', async () => {
  const { queued } = await mount('/re', { commands: [{ text: '/review', description: 'First' }, { text: '/retry', description: 'Second' }] }, true)
  await caretAtText('/re'); await key('ArrowDown'); expect(document.activeElement).toBe(options()[0])
  await key('ArrowDown'); expect(document.activeElement).toBe(options()[1])
  await key('Enter'); expect(draft()).toBe('/retry '); expect(queued).not.toHaveBeenCalled()
  await act(async () => editor().commands.undo()); await caretAtText('/re')
  await key('ArrowDown'); await key('Escape'); expect(options()).toHaveLength(0)
  expect(document.activeElement).toBe(host.querySelector('.tiptap'))
  await key('Enter'); expect(queued).toHaveBeenCalledTimes(1)
})
it('continues directory queries but commits final skill/file choices using the maintained insertion handle', async () => {
  const onQuery = vi.fn()
  const { update, insertion } = await mount('before @sr after', { references: [{ text: '@src/', description: 'Directory', keepOpen: true, insertText: '@src/' }], onCompletionQuery: onQuery })
  await caretAtText('@sr'); await act(async () => options()[0]!.click())
  expect(draft()).toBe('before @src/ after'); expect(onQuery).toHaveBeenLastCalledWith({ kind: 'reference', query: 'src/' })
  const file = { text: '@src/a.ts', description: 'Original file', insertText: encodeSemanticReference({ token: '', kind: 'file', label: 'a.ts', reference: '@src/a.ts' }) }
  await update({ references: [file] }); await act(async () => options()[0]!.click())
  expect(draft()).toBe('before ' + file.insertText + '  after')
  const beforeTool = draft()
  await act(async () => insertion().insert(() => '$original-skill ', { separate: true }))
  expect(draft()).toContain('$original-skill ')
  await act(async () => editor().commands.undo()); expect(draft()).toBe(beforeTool)
})
it('rejects a stale exact range or read-only editor without touching the saved draft or ordinary controls', async () => {
  const { insertion, disable } = await mount('before @Sa after', { references: [{ text: '@Same', description: 'Original' }] })
  await caretAtText('@Sa')
  const old = { from: editor().state.selection.from - 3, to: editor().state.selection.to, expected: '@Sa' }
  await act(async () => editor().commands.insertContentAt({ from: old.from, to: old.to }, 'changed'))
  const changed = draft()
  let result = true
  await act(async () => { result = insertion().replaceRange!(old, agent('wrong')) })
  expect(result).toBe(false); expect(draft()).toBe(changed)
  await disable()
  const selection = editor().state.selection
  await act(async () => { result = insertion().replaceRange!({ from: selection.from, to: selection.to, expected: '' }, agent('wrong')) })
  expect(result).toBe(false); expect(draft()).toBe(changed)
})
it('keeps Prompt underline and Tab on the same bare original word, including punctuation and live prefix preferences', async () => {
  const prompt = { text: 'review', description: 'Original Prompt', insertText: 'expanded original' }
  const config = { command: '/', skill: '%', reference: '#', keywords: true }
  const { update } = await mount('review /review %review (review) reviewMore', { promptKeywords: [prompt], completionConfig: config })
  expect(host.querySelectorAll('[data-composer-keyword="review"]')).toHaveLength(2)
  await caretAtText('/review'); expect((await key('Tab')).defaultPrevented).toBe(false)
  expect(draft()).toBe('review /review %review (review) reviewMore')
  await caretAtText('reviewM'); await act(async () => editor().commands.setTextSelection(editor().state.selection.from - 1))
  expect((await key('Tab')).defaultPrevented).toBe(false)
  await caretAtText('(review'); expect((await key('Tab')).defaultPrevented).toBe(true)
  expect(draft()).toBe('review /review %review (expanded original ) reviewMore')
  await act(async () => editor().commands.undo())
  await update({ promptKeywords: [prompt], completionConfig: { ...config, keywords: false } })
  expect(host.querySelectorAll('[data-composer-keyword="review"]')).toHaveLength(0)
  await caretAtText('(review'); expect((await key('Tab')).defaultPrevented).toBe(false)
})
it('observes only the current original text token rather than copying unrelated preceding draft text', async () => {
  const before = '前'.repeat(200000) + ' unrelated leading words '
  const initial = before + '@Sa untouched'
  const observed = vi.fn()
  await mount(initial, { ...{ onSelectionChange: observed }, references: [{ text: '@Same', description: 'Original Agent', insertText: agent('bounded') }] })
  await caretAtText('@Sa')
  expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ before: '@Sa', after: ' ', composing: false }))
  expect(options()).toHaveLength(1)
  await act(async () => options()[0]!.click())
  expect(draft()).toBe(before + agent('bounded') + '  untouched')
  await act(async () => editor().commands.undo()); expect(draft()).toBe(initial)
})

it.each(['before', 'after'] as const)('separates tool text beside the original Agent atom on its %s side and preserves Undo', async side => {
  const token = agent('original'), initial = token + ' after'
  const { insertion, submitted, queued, activated } = await mount(initial, {}, true)
  await act(async () => editor().commands.setTextSelection(side === 'before' ? 1 : 2))
  await act(async () => insertion().insert(() => '/status', { separate: true }))
  const expected = side === 'before' ? '/status amux://agent/original after' : 'amux://agent/original /status after'
  expect(expandSemanticReferences(draft())).toBe(expected)
  expect(host.querySelectorAll('[data-tool-reference="agent"]')).toHaveLength(1)
  expect(submitted).not.toHaveBeenCalled(); expect(queued).not.toHaveBeenCalled(); expect(activated).not.toHaveBeenCalled()
  await act(async () => editor().commands.undo()); expect(draft()).toBe(initial)
  await act(async () => editor().commands.redo()); expect(expandSemanticReferences(draft())).toBe(expected)
})
