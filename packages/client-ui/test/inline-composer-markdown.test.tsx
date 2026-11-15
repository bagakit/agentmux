import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, expect, it, vi } from 'vitest'
import { InlineComposer, documentDraft } from '../src/components/InlineComposer.js'
import { encodeSemanticReference } from '../src/lib/composer-semantic-reference.js'
import { getMarkdownSourceHighlights } from '../src/lib/markdown-source-highlight.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'

vi.mock('../src/lib/markdown-source-highlight.js', async importOriginal => {
  const parser = await importOriginal<typeof import('../src/lib/markdown-source-highlight.js')>()
  return { ...parser, getMarkdownSourceHighlights: vi.fn(parser.getMarkdownSourceHighlights) }
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const platform = { bindComposerFocus: () => () => {} } as ClientUiPlatform
let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  vi.clearAllMocks()
})

async function mount(original: string) {
  const changed = vi.fn(), selected = vi.fn(), keyDown = vi.fn()
  function Scene() {
    const [value, setValue] = useState(original)
    return <ClientUiProvider platform={platform}>
      <InlineComposer aria-label="Original draft" placeholder="Message" disabled={false} value={value}
        onValueChange={text => { changed(text); setValue(text) }}
        onSelectionChange={selected} onKeyDown={keyDown} />
    </ClientUiProvider>
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Scene />))
  const field = host.querySelector<HTMLElement & { editor: Editor }>('[role="textbox"]')!
  const tokens = () => [...field.querySelectorAll<HTMLElement>('[data-markdown-token]')]
    .map(element => [element.dataset.markdownToken, element.textContent])
  return { field, editor: field.editor, changed, selected, keyDown, tokens }
}

it('colors the original draft across paragraphs and encoded reference atoms', async () => {
  const reference = encodeSemanticReference({ token: '', kind: 'file', label: 'original file', reference: 'src/original.ts' })
  const heading = '# Heading', suffix = ' **原始🪶文字**'
  const original = heading + '\n\n' + reference + suffix + '\n- `literal`'
  const { field, editor, changed, tokens } = await mount(original)
  const expected = [['heading', heading], ['emphasis', suffix.trim()], ['list-marker', '-'], ['code', '`literal`']]
  expect(tokens()).toEqual(expected)
  const atom = field.querySelector('[data-tool-reference="file"]')!
  expect(atom.textContent).toContain('original file')
  expect(atom.closest('[data-markdown-token]')).toBeNull()
  expect(documentDraft(editor.getJSON())).toBe(original)
  expect(changed).not.toHaveBeenCalled()

  const parseCount = vi.mocked(getMarkdownSourceHighlights).mock.calls.length
  await act(async () => editor.commands.setTextSelection({ from: 1, to: heading.length + 1 }))
  const selection = editor.state.selection
  const copy = editor.view.someProp('clipboardTextSerializer')
  expect(copy?.(selection.content(), editor.view)).toBe(heading)
  expect(vi.mocked(getMarkdownSourceHighlights)).toHaveBeenCalledTimes(parseCount)
  expect(tokens()).toEqual(expected)

  await act(async () => editor.commands.insertContent('Plain title'))
  expect(tokens()).toEqual(expected.slice(1))
  expect(changed).toHaveBeenLastCalledWith(original.replace(heading, 'Plain title'))
  expect(field.querySelector('[data-tool-reference="file"]')).toBe(atom)
  await act(async () => editor.commands.undo())
  expect(tokens()).toEqual(expected)
  expect(documentDraft(editor.getJSON())).toBe(original)
})

it('preserves the input method event path and colors text past a soft line break', async () => {
  const { field, editor, selected, keyDown, changed, tokens } = await mount('plain')
  await act(async () => {
    field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
  })
  expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ composing: true }))
  expect(keyDown).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  await act(async () => { field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })) })

  await act(async () => {
    editor.commands.setTextSelection(6)
    editor.commands.setHardBreak()
    editor.commands.insertContent('> **组字**')
  })
  expect(tokens()).toEqual([['quote-marker', '>'], ['emphasis', '**组字**']])
  expect(documentDraft(editor.getJSON())).toBe('plain\n> **组字**')
})
