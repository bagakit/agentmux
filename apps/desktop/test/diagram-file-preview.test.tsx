// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const jobs = vi.hoisted(() => ({ render: vi.fn(), cancel: vi.fn(async () => {}) }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { files: { renderDiagram: jobs.render, cancelDiagram: jobs.cancel } } }))
import { DiagramFilePreview } from '../src/renderer/src/components/file-preview/DiagramFilePreview'
import { DotFilePreview } from '../src/renderer/src/components/file-preview/DotFilePreview'
let observers: { target?: Element; callback: (entries: any[]) => void; disconnect: ReturnType<typeof vi.fn> }[]
let container: HTMLDivElement, root: Root
const workers: any[] = []
function viewport(visible: boolean) { for (const observer of observers) if (observer.target) observer.callback([{ target: observer.target, isIntersecting: visible }]) }
beforeEach(() => {
  observers = []; workers.length = 0; jobs.render.mockReset(); jobs.cancel.mockClear()
  document.documentElement.dataset.appearance = 'light'
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class { target?: Element; disconnect = vi.fn(); constructor(public callback: (entries: any[]) => void) { observers.push(this) }; observe(target: Element) { this.target = target } })
  vi.stubGlobal('Worker', class { onmessage: any; onerror: any; terminate = vi.fn(); postMessage = vi.fn(); constructor() { workers.push(this) } })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:diagram')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); delete document.documentElement.dataset.appearance; vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('current visible diagram consumers', () => {
  it('starts only in the viewport; cancels old source and rejects its late result', async () => {
    const pending: ((value: any) => void)[] = []
    jobs.render.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
    await act(async () => root.render(<DiagramFilePreview kind="mermaid" content="A" />))
    expect(jobs.render).not.toHaveBeenCalled()
    await act(async () => viewport(true))
    expect(jobs.render).toHaveBeenCalledTimes(1)
    const first = jobs.render.mock.calls[0][0]
    await act(async () => root.render(<DiagramFilePreview kind="mermaid" content="B" />))
    expect(jobs.cancel).toHaveBeenCalledWith(first.id)
    await act(async () => pending[0]!({ id: first.id, svg: '<svg>A</svg>' }))
    expect(container.querySelector('img')).toBeNull()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(container.textContent).toContain('B')
    const next = jobs.render.mock.calls[1][0]
    await act(async () => pending[1]!({ id: next.id, svg: '<svg>B</svg>' }))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:diagram')
    await act(async () => viewport(false))
    expect(jobs.cancel).toHaveBeenCalledWith(next.id)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diagram')
    expect(container.querySelector('img')).toBeNull()
    await act(async () => viewport(true))
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Rendering diagram')
  })
  it('keeps source and readable error then retries a new job; inactive host starts no work', async () => {
    jobs.render.mockImplementation(async request => ({ id: request.id, svg: '', error: 'Parse error on line 2' }))
    await act(async () => root.render(<DiagramFilePreview kind="mermaid" content="invalid source" visible={false} />))
    expect(jobs.render).not.toHaveBeenCalled()
    await act(async () => root.render(<DiagramFilePreview kind="mermaid" content="invalid source" />))
    await act(async () => viewport(true))
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Parse error on line 2')
    expect(container.querySelector('code')?.textContent).toBe('invalid source')
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
    expect(jobs.render).toHaveBeenCalledTimes(2)
    expect(jobs.render.mock.calls[1][0].id).not.toBe(jobs.render.mock.calls[0][0].id)
  })
  it('uses authoritative appearance and rerenders a visible diagram on light/dark changes without accepting old results', async () => {
    const pending: ((value: any) => void)[] = []
    jobs.render.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
    await act(async () => root.render(<DiagramFilePreview kind="plantuml" content="Alice -> Bob" />))
    await act(async () => viewport(true))
    const light = jobs.render.mock.calls[0][0]
    expect(light.theme).toBe('light')
    await act(async () => { document.documentElement.dataset.appearance = 'dark'; await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(jobs.render).toHaveBeenCalledTimes(2)
    const dark = jobs.render.mock.calls[1][0]
    expect(dark.theme).toBe('dark')
    expect(jobs.cancel).toHaveBeenCalledWith(light.id)
    await act(async () => pending[0]({ id: light.id, svg: '<svg>old light</svg>' }))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    await act(async () => pending[1]({ id: dark.id, svg: '<svg>current dark</svg>' }))
    expect(container.querySelector('img')).not.toBeNull()
    await act(async () => viewport(false))
    await act(async () => { document.documentElement.dataset.appearance = 'light'; await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(jobs.render).toHaveBeenCalledTimes(2)
    await act(async () => viewport(true))
    expect(jobs.render.mock.calls[2][0].theme).toBe('light')
    expect(container.querySelector('img')).toBeNull()
  })
  it('terminates the DOT Worker on source change, hidden viewport and completion', async () => {
    await act(async () => root.render(<DotFilePreview content="digraph { A->B }" />))
    expect(workers).toHaveLength(0)
    await act(async () => viewport(true))
    const first = workers[0], request = first.postMessage.mock.calls[0][0]
    await act(async () => root.render(<DotFilePreview content="digraph { B->C }" />))
    expect(first.terminate).toHaveBeenCalled()
    await act(async () => first.onmessage({ data: { id: request.id, svg: '<svg>A</svg>' } }))
    expect(container.querySelector('img')).toBeNull()
    const second = workers[1], next = second.postMessage.mock.calls[0][0]
    await act(async () => second.onmessage({ data: { id: next.id, svg: '<svg>B</svg>' } }))
    expect(second.terminate).toHaveBeenCalled()
    expect(container.querySelector('img')).not.toBeNull()
    await act(async () => viewport(false))
    expect(container.querySelector('img')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
    await act(async () => viewport(true))
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Rendering DOT')
  })
  it('retains DOT source and a recovery action when the Worker cannot start', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('Worker denied') } })
    await act(async () => root.render(<DotFilePreview content="digraph { CurrentDraft }" />))
    await act(async () => viewport(true))
    expect(container.querySelector('[role=alert]')?.textContent).toContain('could not start')
    expect(container.querySelector('code')?.textContent).toBe('digraph { CurrentDraft }')
    expect(container.querySelector('button')?.textContent).toBe('Retry preview')
  })
})
