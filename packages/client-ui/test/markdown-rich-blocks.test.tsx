import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'
import { MarkdownCodeBlock } from '../src/components/MarkdownCodeBlock.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { parseAgentMarkdown } from '../src/lib/agent-markdown.js'
import { renderMarkdown } from '../src/lib/markdown-render.js'

let container: HTMLDivElement, root: Root
let observers: { target: Element | undefined; callback: (entries: any[]) => void }[]
const workers: Array<{ terminate: ReturnType<typeof vi.fn>; onmessage: ((event: any) => void) | null; postMessage: ReturnType<typeof vi.fn> }> = []
function viewport(visible: boolean, target?: Element) {
  for (const observer of observers) if (observer.target && (!target || observer.target === target)) observer.callback([{ target: observer.target, isIntersecting: visible }])
}
async function committed(assertion: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); assertion() })
}
beforeEach(() => {
  observers = []
  workers.length = 0
  // Browser boundary only; the independent worker test executes the built production entry.
  vi.stubGlobal('Worker', class {
    onmessage: ((event: any) => void) | null = null
    onerror = null; onmessageerror = null
    terminate = vi.fn()
    postMessage = vi.fn(({ id, input }) => {
      void renderMarkdown(input).then(result => this.onmessage?.({ data: { id, result } }), error => this.onmessage?.({ data: { id, result: { error: error.message } } }))
    })
    constructor() { workers.push(this) }
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    target: Element | undefined
    constructor(public callback: (entries: any[]) => void) { observers.push(this) }
    observe(target: Element) { this.target = target }
    disconnect() { this.target = undefined }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('shared Markdown math and code blocks', () => {
  it('projects exact math source while code, escaped dollar and incomplete currency stay literal', () => {
    const nodes = parseAgentMarkdown('Energy $E=mc^2$.\n\n$$\n\\frac{1}{2}\n$$\n\n`$literal$` and \\$escaped and cost $5\n\n```js\nconst value = "$notMath$"\n```')
    expect(nodes[0]).toEqual({ kind: 'paragraph', children: [{ kind: 'text', text: 'Energy ' }, { kind: 'math', text: 'E=mc^2', source: '$E=mc^2$' }, { kind: 'text', text: '.' }] })
    expect(nodes[1]).toEqual({ kind: 'math', text: '\\frac{1}{2}', source: '$$\n\\frac{1}{2}\n$$' })
    expect(nodes[2]?.kind === 'paragraph' && nodes[2].children[0]).toEqual({ kind: 'code', text: '$literal$' })
    expect(nodes[3]).toEqual({ kind: 'code', language: 'js', text: 'const value = "$notMath$"' })
  })
  it('renders real KaTeX only when visible and preserves malformed source before recovery', async () => {
    await act(async () => root.render(<AgentMarkdown content={'Formula $\\frac{1}{2}$'} />))
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$\\frac{1}{2}$')
    await act(async () => viewport(true))
    await committed(() => expect(container.querySelector('.katex')).not.toBeNull())
    expect(container.querySelector('math')).not.toBeNull()
    await act(async () => root.render(<AgentMarkdown content={'Bad $\\unknownMacro{x}$'} />))
    await committed(() => expect(container.querySelector('[role=alert]')).not.toBeNull())
    expect(container.querySelector('code')?.textContent).toBe('$\\unknownMacro{x}$')
    expect(container.querySelector('[role=alert]')?.textContent).toMatch(/Undefined control sequence/)
    await act(async () => root.render(<AgentMarkdown content={'Fixed $x^2$'} />))
    await committed(() => expect(container.querySelector('.katex')).not.toBeNull())
    expect(container.querySelector('[role=alert]')).toBeNull()
    expect(container.textContent).not.toContain('unknownMacro')
    await act(async () => viewport(false))
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.textContent).toContain('$x^2$')
  })
  it('uses the real requested grammar, keeps exact source and treats source HTML as inert text', async () => {
    const code = 'const html = "<img src=x onerror=alert(1)>"; // source'
    await act(async () => root.render(<MarkdownCodeBlock code={code} language="js" />))
    expect(container.querySelector('.hljs-keyword')).toBeNull()
    await act(async () => viewport(true))
    await committed(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull())
    expect(container.querySelector('code')?.textContent).toBe(code)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    await act(async () => root.render(<MarkdownCodeBlock code="plain <tag>" language="unknown-language" />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(container.querySelector('code')?.textContent).toBe('plain <tag>')
    expect(container.querySelector('[class^=hljs]')).toBeNull()
  })
  it('mounts only a visible diagram callback and leaves readOnly/host-inactive blocks inert', async () => {
    const renderMarkdownDiagram = vi.fn(({ code }: { code: string }) => <div data-host-diagram="">{code}</div>)
    const platform = { renderMarkdownDiagram } as unknown as ClientUiPlatform
    const content = Array.from({ length: 40 }, (_, index) => `\`\`\`mermaid\ngraph LR\n A${index}-->B\n\`\`\``).join('\n\n')
    const render = (visible: boolean, readOnly = false) => <ClientUiProvider platform={platform}><AgentMarkdown content={content} visible={visible} readOnly={readOnly} /></ClientUiProvider>
    await act(async () => root.render(render(false)))
    expect(observers).toHaveLength(0)
    expect(renderMarkdownDiagram).not.toHaveBeenCalled()
    await act(async () => root.render(render(true)))
    expect(renderMarkdownDiagram).not.toHaveBeenCalled()
    const first = container.querySelector('.md-code-container')!
    await act(async () => viewport(true, first))
    expect(renderMarkdownDiagram).toHaveBeenCalled()
    expect(new Set(renderMarkdownDiagram.mock.calls.map(([input]) => input.code))).toEqual(new Set(['graph LR\n A0-->B']))
    expect(renderMarkdownDiagram).toHaveBeenLastCalledWith({ code: 'graph LR\n A0-->B', language: 'mermaid', visible: true })
    expect(container.querySelectorAll('[data-host-diagram]')).toHaveLength(1)
    const calls = renderMarkdownDiagram.mock.calls.length
    await act(async () => viewport(false, first))
    expect(container.querySelector('[data-host-diagram]')).toBeNull()
    await act(async () => root.render(render(true, true)))
    await act(async () => viewport(true))
    expect(renderMarkdownDiagram).toHaveBeenCalledTimes(calls)
    expect(container.textContent).toContain('A39-->B')
  })
  it('lets the host own attachment images and preserves the inert readOnly contract', async () => {
    const renderImage = vi.fn((href: string, alt: string) => <span data-attachment="">{href}:{alt}</span>)
    await act(async () => root.render(<AgentMarkdown documentMode content="![plot](attachment:plot.png)" renderImage={renderImage} />))
    expect(renderImage).toHaveBeenCalledWith('attachment:plot.png', 'plot', undefined)
    expect(container.querySelector('[data-attachment]')?.textContent).toBe('attachment:plot.png:plot')
    expect(container.querySelector('img')).toBeNull()
    renderImage.mockClear()
    await act(async () => root.render(<AgentMarkdown documentMode readOnly content="![plot](attachment:plot.png)" renderImage={renderImage} />))
    expect(renderImage).not.toHaveBeenCalled()
    expect(container.querySelector('[data-attachment]')).toBeNull()
  })
  it('terminates work on viewport exit and source changes; A-B-A never publishes an old job', async () => {
    const pending: Array<{ id: string; deliver: (event: any) => void }> = []
    vi.stubGlobal('Worker', class {
      onmessage: any; onerror: any; onmessageerror: any
      terminate = vi.fn()
      postMessage = vi.fn(({ id }) => pending.push({ id, deliver: this.onmessage }))
      constructor() { workers.push(this) }
    })
    await act(async () => root.render(<MarkdownCodeBlock code="A" language="js" />))
    expect(workers).toHaveLength(0)
    await act(async () => viewport(true))
    await act(async () => root.render(<MarkdownCodeBlock code="B" language="js" />))
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
    await act(async () => root.render(<MarkdownCodeBlock code="A" language="js" />))
    const current = pending[2]!, old = pending[0]!
    await act(async () => current.deliver({ data: { id: current.id, result: { html: '<span class="hljs-keyword">Current A</span>' } } }))
    await act(async () => old.deliver({ data: { id: old.id, result: { html: '<span>Old A</span>' } } }))
    expect(container.querySelector('code')?.textContent).toBe('Current A')
    await act(async () => viewport(false))
    expect(container.querySelector('code')?.textContent).toBe('A')
    await act(async () => viewport(true))
    expect(container.querySelector('.hljs-keyword')).toBeNull()
    await act(async () => viewport(false))
    expect(workers.at(-1)!.terminate).toHaveBeenCalledOnce()
  })
  it('keeps oversized and expansive source readable without generating an unbounded DOM', async () => {
    const code = 'x'.repeat(64 * 1024 + 1)
    await act(async () => root.render(<MarkdownCodeBlock code={code} language="js" />))
    await act(async () => viewport(true))
    await committed(() => expect(container.querySelector('[role=status]')?.textContent).toContain('64 KiB'))
    expect(container.querySelector('code')?.textContent).toBe(code)
    expect(workers).toHaveLength(0)
    await act(async () => root.render(<AgentMarkdown content={`$${'x+'.repeat(1000)}x$`} />))
    await act(async () => viewport(true))
    await committed(() => expect(container.querySelector('[role=status]')?.textContent).toContain('output exceeds'))
    expect(container.querySelector('.katex')).toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('x+x+')
  })
})
