// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotebookFilePreview } from '../src/renderer/src/components/file-preview/NotebookFilePreview'
import { createNotebookReader, type NotebookPreview, type NotebookReply, type NotebookRequest } from '../src/renderer/src/lib/file-formats/data-notebook'

const source = (cells: unknown[]) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } }, cells })
const codeCell = (text: string, outputs: unknown[] = []) => ({ cell_type: 'code', id: 'code', metadata: {}, source: text, execution_count: 2, outputs })
let root: Root, container: HTMLDivElement, automatic = true
const workers: TestWorker[] = []
const intersections: TestIntersectionObserver[] = []
class TestIntersectionObserver {
  target: Element | null = null
  disconnect = vi.fn()
  constructor(readonly callback: IntersectionObserverCallback) { intersections.push(this) }
  observe(target: Element) { this.target = target; this.emit(true) }
  emit(visible: boolean) {
    this.callback([{ target: this.target!, isIntersecting: visible && this.target?.classList.contains('notebook-preview__static') } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}
class TestWorker {
  onmessage: ((event: MessageEvent<NotebookReply>) => void) | null = null
  onerror: (() => void) | null = null
  terminate = vi.fn()
  requests: NotebookRequest[] = []
  reader: ReturnType<typeof createNotebookReader> | null = null
  constructor(readonly url: URL, readonly options: WorkerOptions) { workers.push(this) }
  postMessage(request: NotebookRequest) {
    this.requests.push(request)
    if (!automatic) return
    if (request.type === 'open') this.reader = createNotebookReader(request.content)
    queueMicrotask(() => this.deliver(this.reader!.page(request.type === 'page' ? request.page : 0)))
  }
  deliver(result: NotebookPreview) { this.onmessage?.({ data: { job: this.requests[0]!.job, page: result.status === 'ready' ? result.page : this.requests.at(-1)?.type === 'page' ? (this.requests.at(-1) as { page: number }).page : 0, result } } as MessageEvent<NotebookReply>) }
}
async function render(node: ReactNode) { await act(async () => root.render(node)); await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); await vi.dynamicImportSettled() }) }
async function click(label: string) { const button = [...container.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!; expect(button).toBeDefined(); await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 5)); await vi.dynamicImportSettled() }) }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('Worker', TestWorker); vi.stubGlobal('IntersectionObserver', TestIntersectionObserver); workers.length = 0; intersections.length = 0; automatic = true; container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Notebook current-buffer reader', () => {
  it('renders readonly cells, bounded pages, MIME selection and static isolated HTML', async () => {
    const cells = [codeCell('print(1)', [{ output_type: 'display_data', data: { 'text/html': '<script>window.bad=1</script><b>Draft result</b>', 'text/plain': '<script>plain text</script>', 'application/json': { result: 1 } } }]), ...Array.from({ length: 23 }, (_, index) => ({ cell_type: 'raw', metadata: {}, id: `raw-${index}`, source: `raw cell ${index}` }))]
    await render(<NotebookFilePreview content={source(cells)} ownerKey="file:1" />)
    expect(workers).toHaveLength(1); expect(workers[0]?.url.pathname).toContain('data-notebook.worker.ts'); expect(workers[0]?.options.type).toBe('module')
    expect(container.querySelectorAll('.notebook-preview__cell')).toHaveLength(20)
    expect(container.textContent).toContain('In [2]'); expect(container.textContent).toContain('print')
    for (let attempt = 0; attempt < 10 && !container.querySelector('iframe'); attempt++) await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 10)) })
    const iframe = container.querySelector('iframe')!
    expect(iframe).not.toBeNull(); expect(iframe.getAttribute('sandbox')).toBe('')
    expect(iframe.srcdoc).toContain('Draft result'); expect(iframe.srcdoc).not.toContain('<script>'); expect(iframe.srcdoc).toContain("default-src 'none'")
    const select = container.querySelector('select')!
    await act(async () => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('<script>plain text</script>'); expect(container.querySelector('script')).toBeNull()
    await click('Next notebook page'); expect(container.querySelectorAll('.notebook-preview__cell')).toHaveLength(4)
    expect(workers[0]?.requests.at(-1)).toMatchObject({ type: 'page', page: 1 })
  })
  it('keeps a dense HTML output in Source instead of committing an unbounded DOM', async () => {
    await render(<NotebookFilePreview content={source([codeCell('dense output', [{ output_type: 'display_data', data: { 'text/html': '<b>x</b>'.repeat(4000) } }])])} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('static preview budget')
    expect(container.textContent).toContain('Use Source')
    expect(workers[0]?.requests[0]).toMatchObject({ type: 'open', content: expect.stringContaining('<b>x</b>') })
  })
  it('rejects dense unclosed opening markers before sanitization', async () => {
    await render(<NotebookFilePreview content={source([codeCell('malformed output', [{ output_type: 'display_data', data: { 'text/html': '<a'.repeat(32768) } }])])} />)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('static preview budget')
    expect(workers[0]?.requests[0]).toMatchObject({ type: 'open', content: expect.stringContaining('<a<a<a') })
  })
  it('releases static output frames outside the viewport and recreates only current output on reentry', async () => {
    const node = (text: string) => <NotebookFilePreview content={source([codeCell('output', [{ output_type: 'display_data', data: { 'text/html': `<b>${text}</b>` } }])])} />
    await render(node('original draft'))
    expect(container.querySelector('iframe')?.srcdoc).toContain('original draft')
    const observer = intersections.find(item => item.target?.classList.contains('notebook-preview__static'))!
    await act(async () => observer.emit(false))
    expect(container.querySelector('iframe')).toBeNull()
    await act(async () => { observer.emit(true); await vi.dynamicImportSettled() })
    expect(container.querySelector('iframe')?.srcdoc).toContain('original draft')
    await render(node('current draft'))
    expect(observer.disconnect).toHaveBeenCalledOnce()
    expect(container.querySelector('iframe')?.srcdoc).toContain('current draft')
    expect(container.querySelector('iframe')?.srcdoc).not.toContain('original draft')
  })
  it('resolves only same-cell attachments, blocks external images and keeps decode failure local', async () => {
    await render(<NotebookFilePreview content={source([{ cell_type: 'markdown', id: 'md', metadata: {}, source: '![local](attachment:pic.png)\n\n![external](https://example.invalid/private.png)', attachments: { 'pic.png': { 'image/png': 'YWJj' } } }])} />)
    const image = container.querySelector('img')!
    expect(image.src).toBe('data:image/png;base64,YWJj'); expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(container.textContent).toContain('Image reference unavailable')
    await act(async () => image.dispatchEvent(new Event('error')))
    expect(container.textContent).toContain('could not be decoded'); expect(container.textContent).toContain('external')
  })
  it('does no hidden work, terminates owner jobs and rejects late A→B→A replies', async () => {
    automatic = false
    const a = source([codeCell('current A')]), b = source([codeCell('other B')])
    const node = (content: string, visible = true) => <NotebookFilePreview content={content} visible={visible} ownerKey="original-file" />
    await render(node(a, false)); expect(workers).toHaveLength(0)
    await render(node(a)); await render(node(b)); await render(node(a)); expect(workers).toHaveLength(3)
    expect(workers[0]?.terminate).toHaveBeenCalledOnce(); expect(workers[1]?.terminate).toHaveBeenCalledOnce()
    await act(async () => workers[2]!.deliver(createNotebookReader(a).page(0))); expect(container.textContent).toContain('current A')
    await act(async () => { workers[0]!.deliver(createNotebookReader(source([codeCell('stale A')])).page(0)); workers[1]!.deliver(createNotebookReader(b).page(0)) })
    expect(container.textContent).toContain('current A'); expect(container.textContent).not.toContain('stale A'); expect(container.textContent).not.toContain('other B')
    await render(node(a, false)); expect(workers[2]?.terminate).toHaveBeenCalledOnce(); expect(container.textContent).toBe('')
    await act(async () => workers[2]!.deliver(createNotebookReader(b).page(0))); expect(container.textContent).toBe('')
  })
  it('shows honest errors and Retry creates a new worker without changing the draft', async () => {
    await render(<NotebookFilePreview content="{broken" />)
    expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(container.textContent).toContain('source is unchanged')
    await click('Retry preview'); expect(workers).toHaveLength(2); expect(workers[0]?.terminate).toHaveBeenCalledOnce()
    await render(<NotebookFilePreview content={source([codeCell('preserved draft')])} />)
    await act(async () => workers.at(-1)!.onerror?.()); expect(container.textContent).toContain('reader stopped')
    await click('Retry preview'); expect(container.textContent).toContain('preserved draft')
    expect(workers.at(-1)?.requests[0]).toMatchObject({ type: 'open', content: source([codeCell('preserved draft')]) })
  })
})
