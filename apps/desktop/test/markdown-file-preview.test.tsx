// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
import { createClientUiRoot } from './helpers/client-ui-render'
import { SourceFilePreview } from '../src/renderer/src/components/file-preview/SourceFilePreview'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AppConfig } from '../src/shared/contracts'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import * as agentMarkdown from '@agentmux/client-ui/agent-markdown'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root, initialConfig: AppConfig | null
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
  initialConfig = useAppStore.getState().config
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  useAppStore.setState({ config: initialConfig })
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
/** A complete production default configuration, so setConfig sees what the App would hold. */
const config = (markdown?: AppConfig['markdown']): AppConfig => ({ ...structuredClone(DEFAULT_CONFIG), ...(markdown ? { markdown } : {}) })
const preview = (content: string) => <SourceFilePreview kind="markdown" regionId="markdown-file-region" workspaceId="markdown-workspace" workspaceRoot={fixturePath('workspace')}
  path="docs/README.md" content={content} visible openReference={vi.fn()} openHttpLink={vi.fn()} />
const render = async (content: string) => { await act(async () => root.render(preview(content))); await tick() }

it('passes the real remote image port: HTTPS README badges load lazily without a referrer, other schemes stay text', async () => {
  useAppStore.setState({ config: config() })
  await render('![Badge](https://img.shields.io/badge/a-b-green) ![Plain](http://insecure.example/a.png) <img src="https://img.shields.io/badge/c" alt="Html badge">')
  const images = [...host.querySelectorAll<HTMLImageElement>('.file-markdown-preview img.md-remote-image')]
  expect(images.map(image => image.getAttribute('src'))).toEqual(['https://img.shields.io/badge/a-b-green', 'https://img.shields.io/badge/c'])
  for (const image of images) { expect(image.getAttribute('loading')).toBe('lazy'); expect(image.getAttribute('referrerpolicy')).toBe('no-referrer') }
  expect(host.querySelector('.md-image-attachment--unavailable')?.textContent).toContain('Plain')
})

it('retains authored width and height at the real remote image port', async () => {
  useAppStore.setState({ config: config() })
  await render('<img src="https://example.invalid/image.png" width="120" height="30" alt="Sized image">')
  const image = host.querySelector<HTMLImageElement>('img.md-remote-image')
  expect(image).not.toBeNull()
  const frame = image!.closest<HTMLElement>('.md-image-frame')!
  expect([frame.style.width, frame.style.height, frame.style.getPropertyValue('--md-image-height')]).toEqual(['120px', '30px', '30px'])
  expect(image!.getAttribute('src')).toBe('https://example.invalid/image.png')
})

it('projects the saved reading layout and saves each Aa choice through the ConfigOwner path without reparsing', async () => {
  useAppStore.setState({ config: config({ readingWidth: 'wide', readingTypeface: 'serif', readingFontSize: 15 }) })
  const save = vi.spyOn(api.config, 'save').mockImplementation(async next => next)
  await render('# Title\n\nBody text')
  const document = host.querySelector<HTMLElement>('.file-markdown-preview')!
  expect(document.getAttribute('data-reading-width')).toBe('wide')
  expect(document.getAttribute('data-reading-typeface')).toBe('serif')
  expect(document.style.getPropertyValue('--md-reading-size')).toBe('15px')
  const parse = vi.spyOn(agentMarkdown, 'parseAgentMarkdownDocument')
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Reading layout"]')!.click()); await tick()
  await act(async () => document.ownerDocument.querySelector<HTMLButtonElement>('[role="radio"][data-option="full"]')!.click()); await tick()
  expect(save).toHaveBeenCalledTimes(1)
  const [next, expected] = save.mock.calls[0]!
  expect(next.markdown).toEqual({ readingWidth: 'full', readingTypeface: 'serif', readingFontSize: 15 })
  expect(expected.markdown).toEqual({ readingWidth: 'wide', readingTypeface: 'serif', readingFontSize: 15 })
  expect(host.querySelector('.file-markdown-preview')!.getAttribute('data-reading-width')).toBe('full')
  expect(parse).not.toHaveBeenCalled()
})

it('composes quick successive choices: each save applies only its own change to the latest saved layout', async () => {
  useAppStore.setState({ config: config({ readingWidth: 'wide', readingTypeface: 'sans', readingFontSize: 13 }) })
  const saved: AppConfig[] = []
  vi.spyOn(api.config, 'save').mockImplementation(async next => { await new Promise(resolve => setTimeout(resolve, 5)); saved.push(next); return next })
  await render('# Title')
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Reading layout"]')!.click()); await tick()
  const larger = host.ownerDocument.querySelector<HTMLButtonElement>('button[aria-label="Larger text"]')!
  // Two clicks before any save lands, then a typeface choice made from the same stale render.
  await act(async () => { larger.click(); larger.click(); host.ownerDocument.querySelector<HTMLButtonElement>('[role="radio"][data-option="serif"]')!.click() })
  await vi.waitFor(() => expect(saved).toHaveLength(3))
  expect(saved.map(next => next.markdown)).toEqual([
    { readingWidth: 'wide', readingTypeface: 'sans', readingFontSize: 14 },
    { readingWidth: 'wide', readingTypeface: 'sans', readingFontSize: 15 },
    { readingWidth: 'wide', readingTypeface: 'serif', readingFontSize: 15 }])
  expect(useAppStore.getState().config?.markdown).toEqual({ readingWidth: 'wide', readingTypeface: 'serif', readingFontSize: 15 })
})

it('keeps the current layout and reports a failed save instead of claiming it', async () => {
  useAppStore.setState({ config: config() })
  vi.spyOn(api.config, 'save').mockRejectedValue(new Error('Disk is read-only'))
  const report = vi.spyOn(useAppStore.getState(), 'reportError')
  await render('# Title')
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Reading layout"]')!.click()); await tick()
  await act(async () => host.ownerDocument.querySelector<HTMLButtonElement>('button[aria-label="Larger text"]')!.click()); await tick()
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith('Disk is read-only'))
  expect(host.querySelector('.file-markdown-preview')!.style.getPropertyValue('--md-reading-size')).toBe('13px')
})
