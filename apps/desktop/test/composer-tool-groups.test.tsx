// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { expect, it } from 'vitest'
import { ObservationSurfaceGallery } from '../src/renderer/src/components/ObservationSurfaceGallery'
import { composerDOM } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'

const dom = composerDOM()

it('the real Gallery places one Files in the original reference group before Capture and keeps its draft, editor and selection', async () => {
  await dom.render(<ObservationSurfaceGallery />)
  const composer = dom.container.querySelector<HTMLElement>('#composer-details .composer')!
  const original = composer.querySelector<HTMLElement & { editor: Editor }>('.tiptap')!
  await act(async () => { original.editor.commands.setTextSelection({ from: 2, to: 4 }) })
  const document = original.editor.state.doc, selection = original.editor.state.selection.toJSON()
  const draft = original.textContent, sessions = useAppStore.getState().sessions
  for (const phase of ['current', 'expanded', 'collapsed', 'current']) {
    await act(async () => composer.querySelector<HTMLButtonElement>('.composer-tool--mode')!.click())
    expect(composer.querySelector('.composer-tools')?.getAttribute('data-mode')).toBe(phase)
    if (phase !== 'collapsed') {
      const group = composer.querySelector<HTMLElement>('.composer-tool-group[aria-label="Skills, commands and references"]')!
      const files = group.querySelector<HTMLButtonElement>('[aria-label="Reference files for the Agent to read"]')
      expect(files, 'Gallery consumes the same referenceTools slot as the Session').not.toBeNull()
      expect(composer.querySelectorAll('[aria-label="Reference files for the Agent to read"]')).toHaveLength(1)
      expect(group.querySelectorAll('button')).toHaveLength(3)
      const capture = composer.querySelector('[aria-label="Capture a screen region"]')!
      expect(group.contains(capture)).toBe(false)
      expect(files!.compareDocumentPosition(capture) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      await act(async () => files!.click())
      expect(dom.container.textContent).toContain('Example file picker requested')
      expect(dom.container.textContent).not.toContain('Example screen capture requested')
    }
    expect(composer.querySelector('.tiptap')).toBe(original)
    expect(original.editor.state.doc).toBe(document)
    expect(original.editor.state.selection.toJSON()).toEqual(selection)
    expect(original.textContent).toBe(draft)
    expect(useAppStore.getState().sessions).toBe(sessions)
  }
})
