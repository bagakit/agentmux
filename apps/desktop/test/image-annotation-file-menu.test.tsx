// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ScreenshotEditor } from '../src/renderer/src/components/browser-screenshot/ScreenshotEditor'
import { api } from '../src/renderer/src/lib/api'
import type { BrowserScreenshotCapture } from '../src/shared/contracts'

vi.mock('../src/renderer/src/components/image-annotation/canvas-render', () => ({ renderCommittedLayer() {}, renderScreenshotScene() {} }))
const capture: BrowserScreenshotCapture = { browserId: 'original-browser', navigationId: 'original-navigation',
  image: { mimeType: 'image/png', width: 1, height: 1, byteLength: 68,
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' },
  source: { url: 'https://example.invalid/original', title: 'Original capture', viewport: null, viewportWarning: null } }
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, toJSON() {} }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'written', revision: 'saved-original-revision' })
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals() })
function button(scope: ParentNode, name: string) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === name || button.textContent?.trim() === name)
  expect(found, name).toBeDefined(); return found!
}

it.each(['Save original', 'Cancel'] as const)('releases pointer input after Original menu hands to the file dialog and %s finishes it', async finish => {
  const closed = vi.fn()
  function Host() { const [opened, setOpened] = useState(true)
    return <><button aria-label="Other workface action">Other action</button>{opened ? <ScreenshotEditor capture={capture} workspaceId="original-workspace" busy={false}
      onCancel={() => { closed(); setOpened(false) }} onComplete={() => {}} /> : null}</> }
  await act(async () => root.render(<Host />))
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load')))
  await act(async () => { const trigger = button(editor, 'Original file actions'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Save original…')
  expect(action).toBeDefined(); await act(async () => action!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  const dialog = document.querySelector<HTMLElement>('.confirmation-dialog[role="dialog"]')!
  expect(dialog).not.toBeNull()
  await act(async () => button(dialog, finish).click())
  await act(async () => new Promise(resolve => setTimeout(resolve, 1)))
  expect(document.querySelector('.confirmation-dialog[role="dialog"]')).toBeNull()
  expect(closed).not.toHaveBeenCalled()
  await act(async () => button(editor, 'Cancel').click())
  await act(async () => new Promise(resolve => setTimeout(resolve, 1)))
  expect(closed).toHaveBeenCalledOnce(); expect(node.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
  expect(document.body.style.pointerEvents, 'actual file menu and dialog must release the body pointer lock').not.toBe('none')
})
