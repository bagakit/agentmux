// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { ConversationImage, type ReadPastedImage } from '@agentmux/client-ui/components/ConversationImage'
import { readPastedImage } from '../src/main/pasted-image-read'
import { pastedDirectory } from '../src/main/pasted-directory'
import type { PastedImage } from '@agentmux/client-ui/pasted-images'

// Read real confined bytes. DOM error events prove the loaded Renderer handlers; Chromium decode
// and full workface pixels are separately captured by the owning Native scene.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
let home: string, goodPath: string, badPath: string
let container: HTMLDivElement, root: Root
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'conversation-decode-'))
  await mkdir(pastedDirectory(home), { recursive: true })
  goodPath = join(pastedDirectory(home), 'good.png')
  badPath = join(pastedDirectory(home), 'bad.png')
  await writeFile(goodPath, Buffer.from(PNG, 'base64'))
  await writeFile(badPath, 'hello')
})
afterAll(async () => { await rm(home, { recursive: true, force: true }) })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const thumb = () => container.querySelector<HTMLImageElement>('.md-conversation-image__thumb')
const full = () => document.querySelector<HTMLImageElement>('.md-conversation-image__full')
function expectDecodeFailure(reference: string, content: string = reference) {
  expect(container.querySelector('.md-conversation-image__reference')?.textContent).toBe(reference)
  const failure = container.querySelector('.md-conversation-image__failure[role="status"]')
  expect(failure?.textContent).toBe('Recorded image could not be decoded.')
  expect(failure?.querySelector('button[aria-label="Retry image"]')).not.toBeNull()
  const prose = container.cloneNode(true) as HTMLElement
  prose.querySelectorAll('.md-conversation-image__failure').forEach(node => node.remove())
  expect(prose.textContent).toBe(content)
}
async function renderActual(path: string) {
  const reader = vi.fn((target: string) => readPastedImage(home, target))
  const content = `before @${path} after`
  await act(async () => root.render(createElement(AgentMarkdown, { content, readPastedImage: reader })))
  expect(reader).toHaveBeenCalledWith(path)
  await act(async () => { await Promise.all(reader.mock.results.map(result => result.value)) })
  return { reader, content }
}

describe('the original pasted-image owner after browser decode', () => {
  it('returns the verbatim message reference when readable bytes fail thumbnail decode', async () => {
    const { reader, content } = await renderActual(badPath)
    const image = thumb()
    expect(image).not.toBeNull()
    expect(await reader.mock.results[0]!.value).toEqual({ dataUrl: 'data:image/png;base64,aGVsbG8=' })
    await act(async () => image!.dispatchEvent(new Event('error')))
    expectDecodeFailure(`@${badPath}`, content)
    expect(container.querySelector('.md-conversation-image')).toBeNull()
    expect(thumb()).toBeNull(); expect(full()).toBeNull()
  })

  it('removes an invalid open lightbox and retains the original reference', async () => {
    const { content } = await renderActual(goodPath)
    const trigger = container.querySelector<HTMLButtonElement>('.md-conversation-image')
    expect(trigger).not.toBeNull()
    await act(async () => { trigger!.focus(); trigger!.click() })
    const image = full()
    expect(image).not.toBeNull()
    expect(image!.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    await act(async () => image!.dispatchEvent(new Event('error')))
    expect(full()).toBeNull(); expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('.md-conversation-image')).toBeNull()
    expectDecodeFailure(`@${goodPath}`, content)
  })

  it('keeps valid bytes available for thumbnail, enlargement and Escape', async () => {
    await renderActual(goodPath)
    expect(thumb()!.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    await act(async () => thumb()!.dispatchEvent(new Event('load')))
    const trigger = container.querySelector<HTMLButtonElement>('.md-conversation-image')!
    await act(async () => { trigger.focus(); trigger.click() })
    expect(full()!.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(full()).toBeNull(); expect(thumb()).not.toBeNull()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(document.activeElement).toBe(trigger)
  })

  it.each(['path', 'reader'] as const)('does not label old bytes as a new %s before passive effects', async change => {
    const image = (await readPastedImage(home, goodPath))!
    expect(image.dataUrl).toBe(`data:image/png;base64,${PNG}`)
    const reader: ReadPastedImage = vi.fn(async () => image)
    const commits: Array<{ path: string; src: string | null }> = []
    function Observe({ path, read }: { path: string; read: ReadPastedImage }) {
      useLayoutEffect(() => { commits.push({ path, src: thumb()?.getAttribute('src') ?? null }) }, [path, read])
      return createElement(ConversationImage, { path, text: `@${path}`, readImage: read })
    }
    await act(async () => root.render(createElement(Observe, { path: goodPath, read: reader })))
    expect(thumb()).not.toBeNull()
    let resolveNew!: (value: PastedImage | null) => void
    const pending = new Promise<PastedImage | null>(resolve => { resolveNew = resolve })
    const nextReader: ReadPastedImage = change === 'reader' ? vi.fn(() => pending) : reader
    if (change === 'path') vi.mocked(reader).mockImplementation(() => pending)
    const nextPath = change === 'path' ? badPath : goodPath
    await act(async () => root.render(createElement(Observe, { path: nextPath, read: nextReader })))
    expect(commits).toHaveLength(2)
    expect(commits[1]).toEqual({ path: nextPath, src: null })
    expect(container.textContent).toBe(`@${nextPath}`)
    await act(async () => resolveNew(image))
    expect(thumb()!.getAttribute('alt')).toBe(nextPath)
  })

  it('isolates retained decode and dialog callbacks from a previous loaded image', async () => {
    const image = (await readPastedImage(home, goodPath))!
    const reader: ReadPastedImage = vi.fn(async () => image)
    await act(async () => root.render(createElement(ConversationImage, { path: goodPath, text: `@${goodPath}`, readImage: reader })))
    const trigger = container.querySelector<HTMLButtonElement>('.md-conversation-image')!
    expect(trigger).not.toBeNull()
    // Deliberately retain the actual loaded React callbacks. Dispatching on a disconnected DOM
    // image cannot exercise them: React removes that event route. This is a controlled late-callback
    // seam, not a claim that Chromium dispatched an event after detachment.
    type Fiber = { type?: unknown; memoizedProps?: { onOpenChange?: (next: boolean) => void }; return?: Fiber | null }
    function retainError(node: HTMLImageElement): () => void {
      const key = Object.keys(node).find(key => key.startsWith('__reactProps$'))
      expect(key).toBeDefined()
      const props = (node as unknown as Record<string, { onError?: () => void }>)[key!]!
      expect(props.onError).toBeTypeOf('function')
      return props.onError!
    }
    const oldThumbError = retainError(thumb()!)
    const fiberKey = Object.keys(trigger).find(key => key.startsWith('__reactFiber$'))
    expect(fiberKey).toBeDefined()
    let fiber = (trigger as unknown as Record<string, Fiber>)[fiberKey!]!
    while (fiber && fiber.type !== Dialog.Root) fiber = fiber.return!
    expect(fiber?.memoizedProps?.onOpenChange).toBeTypeOf('function')
    const oldOpen = fiber.memoizedProps!.onOpenChange!
    await act(async () => trigger.click())
    expect(full()).not.toBeNull()
    const oldFullError = retainError(full()!)

    await act(async () => root.render(createElement(ConversationImage, { path: badPath, text: `@${badPath}`, readImage: reader })))
    expect(full()).toBeNull()
    const newTrigger = container.querySelector<HTMLButtonElement>('.md-conversation-image')!
    expect(newTrigger).not.toBeNull()
    await act(async () => newTrigger.click())
    expect(full()!.getAttribute('alt')).toBe(badPath)
    await act(async () => oldOpen(false))
    expect(full()).not.toBeNull()
    expect(full()!.getAttribute('alt')).toBe(badPath)
    await act(async () => full()!.dispatchEvent(new Event('error')))
    expectDecodeFailure(`@${badPath}`)
    await act(async () => { oldThumbError(); oldFullError(); oldOpen(true) })
    expectDecodeFailure(`@${badPath}`)
    expect(thumb()).toBeNull(); expect(full()).toBeNull()
  })

  it('ignores a late prior read and does not reopen the prior image on the new source', async () => {
    const image = (await readPastedImage(home, goodPath))!
    let resolveOld!: (value: PastedImage | null) => void
    const old = new Promise<PastedImage | null>(resolve => { resolveOld = resolve })
    const reader: ReadPastedImage = vi.fn(path => path === badPath ? old : Promise.resolve(image))
    await act(async () => root.render(createElement(ConversationImage, { path: badPath, text: `@${badPath}`, readImage: reader })))
    expect(container.textContent).toBe(`@${badPath}`)
    await act(async () => root.render(createElement(ConversationImage, { path: goodPath, text: `@${goodPath}`, readImage: reader })))
    expect(thumb()!.getAttribute('alt')).toBe(goodPath)
    await act(async () => resolveOld({ dataUrl: 'data:image/png;base64,aGVsbG8=' }))
    expect(thumb()).not.toBeNull()
    expect(thumb()!.getAttribute('src')).toBe(image.dataUrl)
    expect(thumb()!.getAttribute('alt')).toBe(goodPath)
    expect(full()).toBeNull()
  })
})
