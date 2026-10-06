import { act, useState, type Dispatch, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { InlineComposer, documentDraft, draftDocument } from '../src/components/InlineComposer.js'
import { insertComposerContent } from '../src/lib/composer-insertion.js'
import { encodeSemanticReference } from '../src/lib/composer-semantic-reference.js'
import { appendNamedFileReference } from '../src/lib/composer-file-reference.js'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const path = fixturePath('selected/reference [draft].txt')
const token = appendNamedFileReference('', path, 'reference [draft].txt').trim()
const initial = 'before ' + token + ' between ' + token + ' after'
const openReference = vi.fn()
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root
beforeEach(() => { openReference.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
async function mount(disabled = false, activate = true, original = initial) {
 const changed = vi.fn()
 let replace!: Dispatch<SetStateAction<string>>
 function Scene({ disabled }: { disabled: boolean }) {
  const [draft, setDraft] = useState(original); replace = setDraft
  return <ClientUiProvider platform={platform}><InlineComposer value={draft} onValueChange={value => { changed(value); setDraft(value) }} disabled={disabled}
   placeholder="Message" aria-label="Draft" onKeyDown={() => {}} {...(activate ? { onActivateReference: openReference } : {})} /></ClientUiProvider>
 }
 const render = async (disabled: boolean) => { await act(async () => root.render(<Scene disabled={disabled} />)) }
 await render(disabled)
 return { changed, render, replace: async (value: string) => { await act(async () => replace(value)) } }
}
const editor = () => (host.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
const controls = () => host.querySelectorAll<HTMLButtonElement>('[aria-label="Remove file from draft"]')
const draft = () => documentDraft(editor().getJSON())
async function remove(index: number) { await act(async () => { controls()[index]!.focus(); controls()[index]!.click() }) }
function retained(index: number) {
 const button = controls()[index]!, field = Object.keys(button).find(key => key.startsWith('__reactProps$'))!
 return (button as unknown as Record<string, { onClick(): void }>)[field]!.onClick
}
it('reads the exact selected reference deliberately without editing or inventing file IO', async () => {
 const { changed } = await mount()
 expect(host.querySelector('.composer-file__reference')).toBeNull()
 const name = host.querySelector<HTMLButtonElement>('.composer-file__name')!
 await act(async () => name.click())
 expect(host.querySelector('.composer-file__reference code')?.textContent).toBe('@' + path)
 expect(changed).not.toHaveBeenCalled(); expect(openReference).not.toHaveBeenCalled()
 await act(async () => host.querySelector<HTMLButtonElement>('.composer-file__reference button')!.click())
 expect(openReference).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file', reference: '@' + path }))
 await act(async () => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
 expect(host.querySelector('.composer-file__reference')).toBeNull()
 expect(document.activeElement).toBe(name); expect(draft()).toBe(initial)
})
it('removes exactly one duplicate through the original editor and keeps undo, redo and focus', async () => {
 const { changed } = await mount(); const second = controls()[1]
 await remove(0)
 expect(draft()).toBe('before  between ' + token + ' after')
 expect(controls()[0]).toBe(second); expect(changed).toHaveBeenLastCalledWith(draft())
 expect(document.activeElement).toBe(host.querySelector('.tiptap'))
 await act(async () => editor().commands.undo()); expect(draft()).toBe(initial)
 await act(async () => editor().commands.redo()); expect(draft()).toBe('before  between ' + token + ' after')
})
it('uses the current original node position after earlier text changes', async () => {
 await mount(); const old = retained(1)
 await act(async () => editor().commands.insertContentAt(1, 'prefix '))
 await act(async () => old())
 expect(draft()).toBe('prefix before ' + token + ' between  after')
})
it('expires removed handlers even when undo restores the same immutable node', async () => {
 await mount(); const old = retained(0)
 await remove(0); await act(async () => editor().commands.undo())
 await act(async () => old())
 expect(draft()).toBe(initial); expect(controls()).toHaveLength(2)
})
it('preserves reference reading but rejects old removal after disabling or destroying the editor', async () => {
 const { render, changed } = await mount(); const old = retained(0)
 await render(true); expect(controls()).toHaveLength(0)
 await act(async () => old()); expect(draft()).toBe(initial); expect(changed).not.toHaveBeenCalled()
 const name = host.querySelector<HTMLButtonElement>('.composer-file__name')!
 await act(async () => name.click()); expect(host.querySelector('.composer-file__reference code')?.textContent).toBe('@' + path)
 await act(async () => root.render(<p>Other surface</p>))
 await act(async () => old()); expect(host.textContent).toBe('Other surface')
})
it('does not promise an open-file capability when this client supplied no original action', async () => {
 await mount(false, false)
 await act(async () => host.querySelector<HTMLButtonElement>('.composer-file__name')!.click())
 expect(host.querySelector('.composer-file__reference code')?.textContent).toBe('@' + path)
 expect(host.querySelector('.composer-file__reference button')).toBeNull()
 expect(draft()).toBe(initial)
})

it('undoes a quick file removal independently of the just-completed chooser insertion', async () => {
 await mount(false, true, 'Read ')
 await act(async () => { editor().commands.setTextSelection(6); await insertComposerContent(editor(), async () => token + ' ' + token + ' ', draftDocument) })
 const selected = draft(); expect(controls()).toHaveLength(2)
 await remove(0); expect(controls()).toHaveLength(1)
 await act(async () => editor().commands.undo()); expect(draft()).toBe(selected)
 await act(async () => editor().commands.undo()); expect(draft()).toBe('Read ')
})

it.each(['skill', 'component', 'subcommand'] as const)('rebuilds file presentation as the original %s renderer and preserves its action through undo and redo', async kind => {
 await mount(false, true, token)
 const old = retained(0), reference = { token: '', kind, label: 'Chosen reference', reference: kind === 'subcommand' ? 'Original expanded prompt' : 'original-reference' }
 const selected = encodeSemanticReference(reference)
 await act(async () => editor().commands.setContent(draftDocument(selected)))
 expect(editor().state.doc.nodeAt(1)?.attrs.kind).toBe(kind)
 expect(host.querySelector('.composer-file')).toBeNull()
 expect(host.querySelector('[data-tool-reference="' + kind + '"]')).not.toBeNull()
 await act(async () => old()); expect(draft()).toBe(selected)
 await act(async () => editor().commands.undo()); expect(draft()).toBe(token); expect(controls()).toHaveLength(1)
 await act(async () => editor().commands.redo()); expect(draft()).toBe(selected); expect(controls()).toHaveLength(0)
 await act(async () => host.querySelector<HTMLButtonElement>('[data-tool-reference="' + kind + '"]')!.click())
 if (kind === 'subcommand') { expect(draft()).toBe(reference.reference); expect(openReference).not.toHaveBeenCalled() }
 else expect(openReference).toHaveBeenCalledWith(expect.objectContaining({ kind, reference: reference.reference }))
})
it('updates a file node and external draft kinds without retaining an old path disclosure or removal action', async () => {
 const { replace } = await mount(false, true, token)
 await act(async () => host.querySelector<HTMLButtonElement>('.composer-file__name')!.click())
 const old = retained(0), next = appendNamedFileReference('', 'next-original.txt', 'Next file').trim()
 await replace(next); expect(draft()).toBe(next)
 expect(host.querySelector('.composer-file__name')?.textContent).toBe('Next file')
 expect(host.querySelector('.composer-file__reference')).toBeNull()
 await act(async () => old()); expect(draft()).toBe(next)
 const skill = encodeSemanticReference({ token: '', kind: 'skill', label: 'Original skill', reference: 'original-skill' })
 await replace(skill); expect(draft()).toBe(skill); expect(host.querySelector('.composer-file')).toBeNull()
 expect(host.querySelector('[data-tool-reference="skill"]')).not.toBeNull()
 await replace(token); expect(controls()).toHaveLength(1); expect(draft()).toBe(token)
 await act(async () => host.querySelector<HTMLButtonElement>('.composer-file__name')!.click())
 expect(host.querySelector('.composer-file__reference code')?.textContent).toBe('@' + path)
})
