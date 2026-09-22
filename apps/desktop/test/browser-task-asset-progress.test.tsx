// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAsset, BrowserTaskAssetRun } from '../src/shared/browser-task-assets'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const content = { name: 'Review profile', url: 'https://example.test/form', parameters: [], steps: [
  { id: 'review', kind: 'checkpoint' as const, url: 'https://example.test/form', reviewed: true, label: 'Check the profile' }
] }
const asset: BrowserTaskAsset = { id: 'asset-1', browserId: 'browser-1', sourceRecordingId: 'recording-1', revision: 2,
  draft: content, versions: [{ ...content, version: 1, savedAt: 1 }], createdAt: 1, updatedAt: 2 }
const callbacks = { onImport: vi.fn(), onSaveDraft: vi.fn(async () => {}), onSaveVersion: vi.fn(async () => {}),
  onLocateStep: vi.fn(), onRun: vi.fn(async () => {}), onStop: vi.fn((_runId: string, _event: unknown) => {}) }
let root: Root, container: HTMLDivElement, style: HTMLStyleElement

beforeEach(() => {
  vi.clearAllMocks()
  style = document.createElement('style')
  const tokens = readFileSync(new NodeURL('../src/renderer/src/styles/tokens.css', import.meta.url), 'utf8')
  const progressStyles = readFileSync(new NodeURL('../src/renderer/src/styles/browser-task-assets.css', import.meta.url), 'utf8')
  expect(tokens.length).toBeGreaterThan(0)
  expect(progressStyles.length).toBeGreaterThan(0)
  style.textContent = `${tokens}\n${progressStyles}`
  document.head.append(style)
  // happy-dom does not compute color-mix(). Resolve semantic text tokens to their existing
  // source base hues in this fixture only; this tests mounted status/token routing, not the
  // browser's color mixing or visual contrast. The shipped tokens and stylesheet are unchanged.
  const sourceTokens = getComputedStyle(document.documentElement)
  const amber = sourceTokens.getPropertyValue('--amber').trim(), red = sourceTokens.getPropertyValue('--red').trim()
  expect(amber).not.toBe(''); expect(red).not.toBe(''); expect(amber).not.toBe(red)
  document.documentElement.style.setProperty('--amber-text', amber)
  document.documentElement.style.setProperty('--red-text', red)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); style.remove(); document.documentElement.removeAttribute('data-appearance')
  document.documentElement.style.removeProperty('--amber-text'); document.documentElement.style.removeProperty('--red-text')
})

function run(status: BrowserTaskAssetRun['status'], extra: Partial<BrowserTaskAssetRun> = {}): BrowserTaskAssetRun {
  return { id: 'run-1', assetId: asset.id, browserId: asset.browserId, version: 1, nextStep: status === 'completed' ? 1 : 0,
    status, operationIds: ['operation-1'], startedAt: 1, updatedAt: 2, ...extra }
}
async function render(value: BrowserTaskAssetRun) {
  await act(async () => root.render(createElement(BrowserTaskAssetEditor, { asset, recording: null, run: value, ...callbacks })))
  return container.querySelector<HTMLDivElement>('.browser-task-asset__progress')
}
function color(element: Element) {
  const result = getComputedStyle(element).color
  expect(result).not.toBe('')
  return result
}
function tokenColor(token: '--text-2' | '--amber-text' | '--red-text') {
  const reference = document.createElement('span')
  reference.style.color = `var(${token})`
  document.body.append(reference)
  const result = color(reference)
  reference.remove()
  return result
}

it.each(['completed', 'running', 'stopped'] as const)('%s uses restrained normal tone without changing the retained run facts', async status => {
  const progress = (await render(run(status)))!
  expect(progress).not.toBeNull()
  expect(progress.dataset).toMatchObject({ runId: 'run-1', runStatus: status, runVersion: '1' })
  const neutral = tokenColor('--text-2')
  expect(neutral).not.toBe(tokenColor('--amber-text'))
  expect(color(progress)).toBe(neutral)
  expect(color(progress.querySelector('strong')!)).toBe(neutral)
  expect(progress.textContent).toContain('Review profile · v1')
  expect(progress.textContent).toContain(status)
  expect(progress.querySelectorAll('p')).toHaveLength(0)
  expect(Array.from(progress.querySelectorAll('button'), button => button.textContent)).toEqual(status === 'running' ? ['Stop task'] : [])
})

it.each(['ready', 'waiting-human', 'interrupted'] as const)('%s retains the reminder tone and current next step', async status => {
  const progress = (await render(run(status)))!
  expect(progress).not.toBeNull()
  expect(color(progress)).toBe(tokenColor('--amber-text'))
  expect(color(progress.querySelector('strong')!)).toBe(tokenColor('--amber-text'))
  expect(progress.textContent).toContain('next step 1')
  expect(progress.textContent).toContain(status === 'ready' ? 'Ready to continue' : status === 'waiting-human' ? 'Waiting for human checkpoint' : 'interrupted')
  expect(Array.from(progress.querySelectorAll('button'), button => button.textContent)).toEqual(status === 'interrupted' ? [] : ['Stop task'])
})

it('failed uses the existing error tone for the status and actual failure notice', async () => {
  const progress = (await render(run('failed', { warning: 'Task execution failed. Inspect the page before retrying.' })))!
  expect(progress).not.toBeNull()
  const error = tokenColor('--red-text')
  expect(error).not.toBe(tokenColor('--amber-text'))
  expect(color(progress)).toBe(error)
  expect(progress.querySelectorAll('p')).toHaveLength(1)
  expect(color(progress.querySelector('p')!)).toBe(error)
  expect(progress.textContent).toContain('Task execution failed. Inspect the page before retrying.')
})

it('a completed run keeps its real warning visible without making the entire completed progress a warning', async () => {
  const progress = (await render(run('completed', { warning: 'Evidence could not be saved; the page action completed.' })))!
  expect(progress).not.toBeNull()
  expect(color(progress)).toBe(tokenColor('--text-2'))
  expect(color(progress.querySelector('strong')!)).toBe(tokenColor('--text-2'))
  expect(progress.querySelectorAll('p')).toHaveLength(1)
  expect(color(progress.querySelector('p')!)).toBe(tokenColor('--amber-text'))
  expect(progress.querySelector('p')!.textContent).toBe('Evidence could not be saved; the page action completed.')
})

it('an unavailable saved version retains the actual version and a distinct notice', async () => {
  const progress = (await render(run('completed', { version: 99 })))!
  expect(progress).not.toBeNull()
  expect(progress.dataset.runVersion).toBe('99')
  expect(progress.querySelector('strong')!.textContent).toBe('Retained task run · v99')
  expect(color(progress.querySelector('strong')!)).toBe(tokenColor('--text-2'))
  expect(progress.querySelectorAll('p')).toHaveLength(1)
  expect(progress.querySelector('p')!.textContent).toContain('The running version is unavailable.')
  expect(color(progress.querySelector('p')!)).toBe(tokenColor('--amber-text'))
})

it('a foreign Browser run does not take over this asset progress', async () => {
  expect(await render(run('waiting-human', { browserId: 'browser-other' }))).toBeNull()
  expect(container.querySelectorAll('[data-run-id]')).toHaveLength(0)
})

it('the same mounted progress follows waiting, running and completed facts; Stop keeps its actual run identity', async () => {
  const waiting = (await render(run('waiting-human')))!
  expect(waiting).not.toBeNull()
  expect(color(waiting)).toBe(tokenColor('--amber-text'))
  await act(async () => waiting.querySelector('button')!.click())
  expect(callbacks.onStop).toHaveBeenCalledTimes(1)
  expect(callbacks.onStop.mock.calls[0]![0]).toBe('run-1')
  const running = (await render(run('running')))!
  expect(running).toBe(waiting)
  expect(color(running)).toBe(tokenColor('--text-2'))
  const completed = (await render(run('completed')))!
  expect(completed).toBe(waiting)
  expect(color(completed)).toBe(tokenColor('--text-2'))
  expect(completed.textContent).toContain('completed')
  expect(completed.querySelectorAll('button')).toHaveLength(0)
})

it('the normal completed tone follows the existing light appearance token', async () => {
  document.documentElement.dataset.appearance = 'light'
  const progress = (await render(run('completed')))!
  expect(progress).not.toBeNull()
  expect(color(progress)).toBe(tokenColor('--text-2'))
  expect(color(progress)).not.toBe(tokenColor('--amber-text'))
})
