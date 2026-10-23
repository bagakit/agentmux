// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor } from '@tiptap/core'
import { afterEach, expect, it, vi } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '../../../packages/client-ui/src/platform'
import { ComposerCompletionEditor } from '../../../packages/client-ui/src/components/ComposerCompletionEditor'
import { documentDraft } from '../../../packages/client-ui/src/components/InlineComposer'
import * as Modal from '../../../packages/client-ui/src/components/Modal'
import { observeNativeOverlayRegions } from '../src/renderer/src/lib/native-overlay-regions'

let root: Root | undefined
let dispose: (() => void) | undefined
let sheet: HTMLStyleElement | undefined
const frames: FrameRequestCallback[] = []
afterEach(async () => {
  dispose?.(); dispose = undefined
  if (root) await act(async () => root!.unmount())
  root = undefined; sheet?.remove(); sheet = undefined; frames.length = 0
  document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it.each(['choices', 'feedback-only'] as const)('projects the complete painted %s completion root above its modal without duplicating its transparent listbox', async mode => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const host = document.createElement('div'); host.id = 'root'; document.body.append(host)
  const overlay = document.createElement('div'); overlay.setAttribute('data-overlay-host', ''); document.body.append(overlay)
  sheet = document.createElement('style')
  sheet.textContent = ':root { --surface-1: rgb(31, 36, 43); --radius: 8px; }' +
    ['composer.css', 'overlays.css'].map(file => readFileSync(resolve(import.meta.dirname, '../../../packages/client-ui/src/styles', file), 'utf8')).join('\n')
  document.head.append(sheet)
  const platform: ClientUiPlatform = { overlayContainer: () => overlay, copyText: async () => true,
    bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  const selected = vi.fn(), submitted = vi.fn()
  function Scene() {
    const [draft, change] = useState('/in')
    return <ClientUiProvider platform={platform}><Modal.Root defaultOpen><Modal.Portal container={overlay}>
      <Modal.Overlay style={{ backgroundColor: 'rgba(0, 0, 0, .45)' }} />
      <Modal.Content style={{ backgroundColor: 'rgb(31, 36, 43)' }}><Modal.Title>Original draft</Modal.Title><Modal.Description>Retained editor</Modal.Description>
        <ComposerCompletionEditor value={draft} onValueChange={change} disabled={false} placeholder="Draft" aria-label="Draft"
          commands={mode === 'choices' ? [{ text: '/inspect', description: 'Inspect original draft' }, { text: '/include', description: 'Include original work' }] : []}
          completionFeedback={mode === 'feedback-only' ? <span>Original discovery failure; the draft stays available</span> : null}
          onSelectSuggestion={selected} onKeyDown={submitted} />
      </Modal.Content>
    </Modal.Portal></Modal.Root></ClientUiProvider>
  }
  root = createRoot(host)
  await act(async () => root!.render(<Scene />))
  const editor = (document.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
  await act(async () => { editor.commands.setTextSelection(4); editor.commands.focus() })
  const popup = document.querySelector<HTMLElement>('.composer-completion-popover')!
  await vi.waitFor(() => expect(popup.style.visibility).toBe('visible'))
  const list = popup.querySelector<HTMLElement>('[role="listbox"]')
  expect(popup.closest('[data-overlay-modal-slot]')).not.toBeNull()
  expect(popup.closest('[data-overlay-modal-part="content"]')).toBeNull()
  expect(window.getComputedStyle(popup).backgroundColor).toBe('rgb(31, 36, 43)')
  if (list) expect(getComputedStyle(list).backgroundColor).toBe('')
  const scrim = document.querySelector<HTMLElement>('[data-overlay-modal-part="scrim"]')!
  const content = document.querySelector<HTMLElement>('[data-overlay-modal-part="content"]')!
  const boundary = content.closest<HTMLElement>('[data-overlay-modal-boundary]')!
  expect(document.querySelector('[role="dialog"]')).toBe(boundary)
  expect(boundary.contains(content)).toBe(true)
  // happy-dom omits Chromium's normalized transparent default for an unpainted box.
  boundary.style.backgroundColor = 'rgba(0, 0, 0, 0)'
  // The first row crosses the original modal top and the native Browser demand's x range.
  boundary.getBoundingClientRect = () => new DOMRect(0, 0, window.innerWidth, window.innerHeight)
  scrim.getBoundingClientRect = () => new DOMRect(0, 0, 1180, 740)
  content.getBoundingClientRect = () => new DOMRect(390, 264, 400, 213)
  popup.getBoundingClientRect = () => new DOMRect(410, 234, 360, 112)
  if (list) list.getBoundingClientRect = () => new DOMRect(411, 235, 358, 110)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  const publish = vi.fn()
  dispose = observeNativeOverlayRegions(document.body, () => 1, publish, undefined,
    { revision: 1, bounds: [{ x: 566, y: 56, width: 614, height: 684 }] }).dispose
  const regions = publish.mock.calls.at(-1)![0]
  expect(regions.map((region: any) => region.modal?.part ?? 'accessory')).toEqual(['scrim', 'content', 'accessory'])
  expect(regions[2]).toMatchObject({ bounds: { x: 410, y: 234, width: 360, height: 112 }, radius: 8 })
  expect(publish.mock.calls.at(-1)![1]).toBeUndefined()
  if (mode === 'choices') {
    const original = popup.querySelector<HTMLButtonElement>('[role="option"]')!
    await act(async () => original.focus())
    await act(async () => original.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(selected).toHaveBeenCalledWith('/inspect', 'command', expect.objectContaining({ text: '/inspect' }))
    expect(documentDraft(editor.getJSON())).toBe('/inspect ')
  } else {
    await act(async () => editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(selected).not.toHaveBeenCalled()
    expect(documentDraft(editor.getJSON())).toBe('/in')
  }
  expect(submitted).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBe(boundary)
  expect(boundary.contains(content)).toBe(true)
  expect(popup.isConnected).toBe(false)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); for (const callback of frames.splice(0)) callback(0) })
  expect(publish.mock.calls.at(-1)![0].map((region: any) => region.modal?.part)).toEqual(['scrim', 'content'])
  if (mode === 'choices') {
    await act(async () => editor.commands.undo())
    expect(documentDraft(editor.getJSON())).toBe('/in')
  }
})
