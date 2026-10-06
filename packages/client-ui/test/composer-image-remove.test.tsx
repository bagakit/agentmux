import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { InlineComposer, documentDraft } from '../src/components/InlineComposer.js'
import { ConversationImage, type ReadPastedImage } from '../src/components/ConversationImage.js'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const path = fixturePath('.agentmux/pasted/draft.png')
const initial = `before @${path} between @${path} after`
const reader = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,draft-fixture' }))
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root
beforeEach(() => { reader.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
async function mount({ value = initial, disabled = false, read = reader as ReadPastedImage } = {}) {
  const changed = vi.fn()
  function Scene({ disabled }: { disabled: boolean }) {
    const [draft, setDraft] = useState(value)
    return <ClientUiProvider platform={platform}><InlineComposer value={draft} onValueChange={value => { changed(value); setDraft(value) }} disabled={disabled}
      placeholder="Message" aria-label="Draft" onKeyDown={() => {}} readPastedImage={read} /></ClientUiProvider>
  }
  const render = async (disabled: boolean) => { await act(async () => root.render(<Scene disabled={disabled} />)) }
  await render(disabled)
  return { changed, render }
}
const editor = () => (host.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
const controls = () => host.querySelectorAll<HTMLButtonElement>('[aria-label="Remove image from draft"]')
const draft = () => documentDraft(editor().getJSON())
async function remove(index: number) { await act(async () => { controls()[index]!.focus(); controls()[index]!.click() }) }
function retained(index: number) {
  const button = controls()[index]!, field = Object.keys(button).find(key => key.startsWith('__reactProps$'))!
  return (button as unknown as Record<string, { onClick(): void }>)[field]!.onClick
}

it('removes only the clicked duplicate node through the actual editor, preserves source and undo/redo', async () => {
  const { changed } = await mount()
  expect(controls()).toHaveLength(2); expect(reader).toHaveBeenCalledTimes(2)
  const second = controls()[1]!, source = reader.mock.results.map(result => result.value)
  await remove(0)
  expect(draft()).toBe(`before  between @${path} after`)
  expect(changed).toHaveBeenLastCalledWith(draft()); expect(controls()).toHaveLength(1); expect(controls()[0]).toBe(second)
  expect(document.activeElement).toBe(host.querySelector('.tiptap')); expect(editor().state.selection.from).toBe(8)
  await act(async () => editor().commands.undo())
  expect(draft()).toBe(initial); expect(controls()).toHaveLength(2)
  await act(async () => editor().commands.redo())
  expect(draft()).toBe(`before  between @${path} after`)
  expect(await Promise.all(source)).toEqual([{ dataUrl: 'data:image/png;base64,draft-fixture' }, { dataUrl: 'data:image/png;base64,draft-fixture' }])
})

it('resolves the current position after an earlier edit instead of deleting by stale offset or path', async () => {
  await mount(); const removeSecond = retained(1)
  await act(async () => editor().commands.insertContentAt(1, 'prefix '))
  await act(async () => removeSecond())
  expect(draft()).toBe(`prefix before @${path} between  after`)
  expect(controls()).toHaveLength(1)
})

it('rejects a removed NodeView handler even after undo restores the same immutable node', async () => {
  await mount(); const old = retained(0)
  await remove(0); await act(async () => editor().commands.undo())
  expect(draft()).toBe(initial)
  await act(async () => old())
  expect(draft()).toBe(initial); expect(controls()).toHaveLength(2)
})

it('hides removal for a disabled draft and rejects the old handler without losing references', async () => {
  const { render, changed } = await mount(); const old = retained(0)
  await render(true)
  expect(controls()).toHaveLength(0); expect(draft()).toBe(initial)
  await act(async () => old())
  expect(draft()).toBe(initial); expect(changed).not.toHaveBeenCalled()
  await render(false); expect(controls()).toHaveLength(2)
  await remove(1); expect(draft()).toBe(`before @${path} between  after`)
})

it('keeps the failed image reference removable without invoking a new read', async () => {
  const failed = vi.fn(async () => null)
  await mount({ value: `before @${path} after`, read: failed })
  expect(host.querySelector('.md-conversation-image__reference')?.textContent).toBe(`@${path}`)
  expect(controls()).toHaveLength(1)
  await remove(0)
  expect(draft()).toBe('before  after'); expect(failed).toHaveBeenCalledExactlyOnceWith(path)
})

it('does not put a removal action in a historical image or execute a retained handler after editor destruction', async () => {
  await mount(); const old = retained(0)
  const originalEditor = editor()
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationImage path={path} text={`@${path}`} readImage={reader} /></ClientUiProvider>))
  expect(controls()).toHaveLength(0)
  await vi.waitFor(() => expect(originalEditor.isDestroyed).toBe(true))
  await act(async () => old())
  expect(host.querySelector('.md-conversation-image')).not.toBeNull()
})
