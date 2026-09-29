// @vitest-environment happy-dom
import { act, Profiler, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Monaco worker/canvas is a platform boundary; the File router, Editor owner and preview are real.
vi.mock('../src/renderer/src/monaco', () => ({}))
vi.mock('@monaco-editor/react', () => ({ default: ({ value, path }: { value: string; path: string }) => <textarea data-monaco-path={path} value={value} readOnly /> }))
import { FilePreviewPane } from '../src/renderer/src/components/FilePreviewPane'
import { FileSurfaceView } from '../src/renderer/src/components/FileSurfaceView'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, documentKey, fileTabId, initialWorkbenchRegionId, type FileWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig } from './helpers/composer-dom-fixture'

const initial = useAppStore.getState()
let root: Root, container: HTMLDivElement
let createUrl: ReturnType<typeof vi.fn>, revokeUrl: ReturnType<typeof vi.fn>
const blobs: Blob[] = []
function surface(path = 'diagram.png', workspaceId = 'workspace'): FileWorkbenchSurface {
  return { regionId: initialWorkbenchRegionId(fileTabId(workspaceId, path)), kind: 'file', path, workspaceId }
}
function seed(path: string, content?: string) {
  const file = surface(path), id = fileTabId(file.workspaceId, path), tab = createWorkbenchTab(id, file)
  useAppStore.setState({ config: composerConfig, activeWorkspaceId: file.workspaceId, mainSurface: 'workbench',
    tabs: { [id]: tab }, layouts: { workspace: createWorkspaceLayout('group', [id]) },
    documents: content === undefined ? {} : { [documentKey(file.workspaceId, path)]: { path, content, revision: 'original' } },
    dirtyDocuments: {}, documentIssues: {}, documentGenerations: {}, savingDocuments: {} })
  return { file, id, key: documentKey(file.workspaceId, path) }
}
function ready(revision = 'image-original', kind: 'image' | 'audio' | 'video' | 'pdf' = 'image') {
  return { status: 'ready' as const, kind, mimeType: kind === 'pdf' ? 'application/pdf' : `${kind}/fixture`, bytes: new Uint8Array([1, 2, 3]), revision, byteLength: 3, readCost: { payloadBytes: 3 } }
}
async function render(node: ReactNode) { await act(async () => root.render(node)); await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function click(title: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === title || item.getAttribute('aria-label') === title)
  expect(button).toBeDefined(); await act(async () => button!.click())
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  blobs.length = 0
  createUrl = vi.fn((blob: Blob) => { blobs.push(blob); return `blob:fixture-${blobs.length}` })
  revokeUrl = vi.fn()
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(api.files, 'readPreview').mockResolvedValue(ready())
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('real format preview pane', () => {
  it('reads only when visible, confirms native dimensions on decode, keeps small Fit at 100%, and releases the Blob on hide', async () => {
    const { file } = seed('diagram.png')
    await render(<FilePreviewPane surface={file} visible={false} />); expect(api.files.readPreview).not.toHaveBeenCalled()
    await render(<FilePreviewPane surface={file} />)
    expect(api.files.readPreview).toHaveBeenCalledExactlyOnceWith('workspace', 'diagram.png')
    const image = container.querySelector('img')!
    expect(image).not.toBeNull(); expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('loading')
    const viewport = container.querySelector('.image-preview__viewport')!
    Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } })
    Object.defineProperties(image, { naturalWidth: { value: 80 }, naturalHeight: { value: 60 } })
    await act(async () => { window.dispatchEvent(new Event('resize')); image.dispatchEvent(new Event('load')) })
    // Happy DOM does not deliver ResizeObserver layout; native geometry is covered by the actual App driver.
    expect(container.querySelector('output')?.textContent).toBe('100%')
    await click('1:1'); expect(container.querySelector('output')?.textContent).toBe('100%')
    expect(container.textContent).toContain('80 × 60 · 3 B'); expect(image.style.width).toBe('80px')
    await click('Zoom in'); expect(container.querySelector('output')?.textContent).toBe('125%'); expect(image.style.width).toBe('100px')
    expect(useAppStore.getState().documents).toEqual({})
    await render(<FilePreviewPane surface={file} visible={false} />); expect(revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:fixture-1'); expect(container.querySelector('img')).toBeNull()
  })
  it('discards late bytes across A → B → A and does not re-read for unrelated Session output', async () => {
    const pending: Array<(value: ReturnType<typeof ready>) => void> = []
    vi.mocked(api.files.readPreview).mockImplementation(() => new Promise(resolve => pending.push(resolve)))
    let commits = 0
    const node = (path: string) => <Profiler id="preview" onRender={() => commits++}><FilePreviewPane surface={surface(path)} /></Profiler>
    seed('a.png'); await render(node('a.png')); await render(node('b.png')); await render(node('a.png'))
    expect(pending).toHaveLength(3)
    await act(async () => { pending[0]!(ready('old-a')); pending[1]!(ready('old-b')) }); expect(createUrl).not.toHaveBeenCalled()
    await act(async () => pending[2]!(ready('current-a'))); expect(createUrl).toHaveBeenCalledTimes(1)
    const before = commits
    await act(async () => useAppStore.setState({ timelines: { unrelated: { agentSessionId: 'unrelated', revision: 2, items: [] } } }))
    expect(commits).toBe(before); expect(api.files.readPreview).toHaveBeenCalledTimes(3)
  })
  it('never renders the previous image under the next file header, even before passive effects run', async () => {
    const seen: Array<{ path: string; src: string | null }> = []
    function CommitWitness({ path }: { path: string }) {
      useLayoutEffect(() => { seen.push({ path, src: container.querySelector('img')?.getAttribute('src') ?? null }) })
      return <FilePreviewPane surface={surface(path)} />
    }
    seed('a.png'); await render(<CommitWitness path="a.png" />); expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:fixture-1')
    await render(<CommitWitness path="b.png" />)
    expect(seen.find(item => item.path === 'b.png')).toEqual({ path: 'b.png', src: null })
  })
  it('states real read and decoder failures and routes external actions through the existing exact workspace API', async () => {
    const { file } = seed('broken.png')
    const open = vi.spyOn(api.files, 'openSystem').mockResolvedValue(undefined), reveal = vi.spyOn(api.files, 'reveal').mockResolvedValue(undefined)
    await render(<FilePreviewPane surface={file} />)
    await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(container.textContent).toContain('Image could not be decoded'); expect(container.querySelector('[data-decode-state]')?.getAttribute('data-decode-state')).toBe('error')
    await click('Open file in system application'); expect(open).toHaveBeenCalledExactlyOnceWith('workspace', 'broken.png')
    const revealButton = container.querySelector<HTMLButtonElement>('button[title^="Reveal"]')!; expect(revealButton).not.toBeNull(); await act(async () => revealButton.click()); expect(reveal).toHaveBeenCalledExactlyOnceWith('workspace', 'broken.png')
    vi.mocked(api.files.readPreview).mockResolvedValue({ status: 'too-large', maxBytes: 16777216, message: 'Preview is limited to 16 MB.' })
    await click('Reload file preview'); expect(container.textContent).toContain('File exceeds the preview budget'); expect(container.textContent).toContain('16 MB'); expect(container.querySelector('img')).toBeNull()
  })
  it.each(['audio', 'video'] as const)('%s uses native controls, no autoplay, and pauses/releases when hidden', async kind => {
    vi.mocked(api.files.readPreview).mockResolvedValue(ready('media', kind))
    const { file } = seed(`clip.${kind === 'audio' ? 'mp3' : 'mp4'}`)
    await render(<FilePreviewPane surface={file} />)
    const player = container.querySelector(kind)!
    expect(player).not.toBeNull(); expect(player.hasAttribute('controls')).toBe(true); expect(player.hasAttribute('autoplay')).toBe(false)
    await act(async () => player.dispatchEvent(new Event('error'))); expect(container.textContent).toContain('Media could not be decoded')
    await render(<FilePreviewPane surface={file} visible={false} />); expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1); expect(player.hasAttribute('src')).toBe(false); expect(revokeUrl).toHaveBeenCalledTimes(1)
  })
  it('unknown binary has metadata and external actions but no media read or editable model', async () => {
    const { file, id, key } = seed('opaque.bin')
    useAppStore.setState({ documentIssues: { [key]: { kind: 'binary', revision: 'opaque-original', byteLength: 4096 } } })
    await render(<FileSurfaceView tabId={id} surface={file} />)
    expect(container.textContent).toContain('Binary file'); expect(container.textContent).toContain('4 KB')
    expect(container.querySelector('textarea')).toBeNull(); expect(api.files.readPreview).not.toHaveBeenCalled(); expect(useAppStore.getState().documents).toEqual({})
    const tab = useAppStore.getState().tabs[id]
    vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path: file.path, content: 'Now actual UTF-8 text', revision: 'text-now' } })
    await click('Reload file preview'); await render(<FileSurfaceView tabId={id} surface={file} />)
    expect(container.querySelector('textarea')?.value).toBe('Now actual UTF-8 text'); expect(useAppStore.getState().tabs[id]).toBe(tab); expect(useAppStore.getState().documentIssues[key]).toBeUndefined()
  })
  it('Markdown preview reflects the same unsaved document without executing HTML; source remains the same model', async () => {
    const { file, id, key } = seed('README.md', '# Original')
    await render(<FileSurfaceView tabId={id} surface={file} />)
    await act(async () => useAppStore.getState().updateDocument(id, '# Unsaved heading\n\n<script>window.injected = true</script>', file.regionId))
    await click('Preview'); expect(container.querySelector('.file-markdown-preview')?.textContent).toContain('Unsaved heading'); expect(container.querySelector('script')).toBeNull()
    expect(useAppStore.getState().documents[key]?.revision).toBe('original'); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true)
    await click('Source'); expect(container.querySelector('textarea')?.value).toContain('Unsaved heading'); expect(container.querySelector('textarea')?.dataset.monacoPath).toBe('workspace:README.md'); expect(api.files.readPreview).not.toHaveBeenCalled()
  })
  it('SVG preview consumes current dirty XML, revokes old bytes, and leaves the original revision/save owner intact', async () => {
    const { file, id, key } = seed('drawing.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"></svg>')
    await render(<FileSurfaceView tabId={id} surface={file} />); expect(container.querySelector('img')).not.toBeNull()
    const draft = '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="60"><text>unsaved</text></svg>'
    await act(async () => useAppStore.getState().updateDocument(id, draft, file.regionId))
    expect(await blobs.at(-1)!.text()).toBe(draft); expect(revokeUrl).toHaveBeenCalledWith('blob:fixture-1'); expect(useAppStore.getState().documents[key]?.revision).toBe('original')
    await click('Source'); expect(container.querySelector('textarea')?.value).toBe(draft); expect(useAppStore.getState().dirtyDocuments[key]).toBe(true); expect(api.files.readPreview).not.toHaveBeenCalled()
  })
  it('SVG owner changes never commit the previous Blob under a new file or current draft', async () => {
    const a = seed('a.svg', '<svg><text>A</text></svg>'), b = surface('b.svg')
    useAppStore.setState(state => ({ documents: { ...state.documents, [documentKey('workspace','b.svg')]: { path:'b.svg',content:'<svg><text>B</text></svg>',revision:'b-original' } } }))
    const seen: Array<{ path: string; src: string | null }> = []
    function Witness({ file }: { file: FileWorkbenchSurface }) {
      useLayoutEffect(() => { seen.push({ path:file.path,src:container.querySelector('img')?.getAttribute('src')??null }) })
      return <FileSurfaceView tabId={a.id} surface={file} />
    }
    await render(<Witness file={a.file} />); expect(container.querySelector('img')).not.toBeNull()
    await render(<Witness file={b} />); expect(seen.find(item => item.path === 'b.svg')).toEqual({ path:'b.svg',src:null })
    expect(await blobs.at(-1)!.text()).toBe('<svg><text>B</text></svg>')
    let latestCommit: string | null = 'unset'
    function DraftWitness({ token }: { token: string }) {
      useLayoutEffect(() => { latestCommit = container.querySelector('img')?.getAttribute('src') ?? null }, [token])
      return <FileSurfaceView tabId={a.id} surface={a.file} />
    }
    await render(<DraftWitness token="original" />); expect(container.querySelector('img')).not.toBeNull()
    await act(async () => { useAppStore.getState().updateDocument(a.id, '<svg><text>Current unsaved A</text></svg>', a.file.regionId); root.render(<DraftWitness token="new draft" />) })
    expect(latestCommit).toBeNull(); expect(await blobs.at(-1)!.text()).toBe('<svg><text>Current unsaved A</text></svg>')
  })
  it.each(['svg','md'] as const)('%s current source preview is bounded while Source and hidden panes do no preview encoding', async extension => {
    const content = '中'.repeat(6 * 1024 * 1024), owner = seed(`large.${extension}`, content)
    const encode = vi.spyOn(TextEncoder.prototype, 'encodeInto')
    await render(<FileSurfaceView tabId={owner.id} surface={owner.file} visible={false} />)
    expect(encode).not.toHaveBeenCalled(); expect(createUrl).not.toHaveBeenCalled()
    await render(<FileSurfaceView tabId={owner.id} surface={owner.file} />)
    if (extension === 'md') { expect(encode).not.toHaveBeenCalled(); await click('Preview') }
    expect(container.querySelector('.file-preview-state strong')?.textContent).toBe('Source exceeds the preview budget'); expect(createUrl).not.toHaveBeenCalled(); expect(container.querySelector('.file-markdown-preview')).toBeNull()
    expect(encode).toHaveBeenCalledTimes(1); expect(encode.mock.calls[0]![1].byteLength).toBe(16 * 1024 * 1024 + 1)
    await click('Source'); expect(container.querySelector('textarea')?.value).toBe(content); expect(encode).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().documents[owner.key]?.revision).toBe('original')
  })

})
