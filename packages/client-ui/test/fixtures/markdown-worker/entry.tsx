import { createRoot } from 'react-dom/client'
import { MarkdownMath } from '../../../src/components/MarkdownMath.js'
import { MarkdownCodeBlock } from '../../../src/components/MarkdownCodeBlock.js'

const root = createRoot(document.getElementById('root')!)
const OriginalWorker = window.Worker
const jobs: Array<{ terminated: boolean; messages: number }> = []
let peak = 0
window.Worker = class extends OriginalWorker {
  fact = { terminated: false, messages: 0 }
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options); jobs.push(this.fact); peak = Math.max(peak, jobs.filter(job => !job.terminated).length)
    this.addEventListener('message', () => this.fact.messages++)
  }
  override terminate() { this.fact.terminated = true; super.terminate() }
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function wait(predicate: () => boolean) {
  const until = performance.now() + 10_000
  while (!predicate()) { if (performance.now() > until) throw Error('Production Markdown did not settle'); await delay(5) }
}
function show(kind: string, source: string, visible = true) {
  root.render(kind === 'math' ? <MarkdownMath expression={source} source={`$${source}$`} visible={visible} /> : <MarkdownCodeBlock code={source} language="js" visible={visible} />)
}
;(window as any).mdWorkerProbe = {
  async hidden() {
    show('math', 'x^2', false); await delay(40)
    return { workers: jobs.length, katexCss: Array.from(document.styleSheets).some(sheet => sheet.href?.includes('katex')) }
  },
  async sample(kind: string, source: string) {
    root.render(null); await delay(20)
    const start = performance.now(), before = jobs.length, gaps: number[] = []
    let previous = start
    const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now }, 4)
    try {
      show(kind, source)
      await wait(() => Boolean(document.querySelector('.katex, .hljs-keyword, [role=status], [role=alert]')))
      await delay(40)
      const host = document.getElementById('root')!
      return { kind, sourceBytes: new TextEncoder().encode(source).byteLength, elapsed: performance.now() - start, maxTimerGap: Math.max(...gaps), ticks: gaps.length,
        elements: host.querySelectorAll('*').length, htmlBytes: new TextEncoder().encode(host.innerHTML).byteLength,
        rendered: Boolean(host.querySelector('.katex, .hljs-keyword')), message: host.querySelector('[role=status], [role=alert]')?.textContent,
        sourcePreserved: host.querySelector('code')?.textContent === (kind === 'math' ? `$${source}$` : source),
        activeMarkup: host.querySelectorAll('script,img,a[href^="javascript:"]').length,
        workers: jobs.slice(before), stylesheets: Array.from(document.styleSheets).map(sheet => sheet.href) }
    } finally { clearInterval(timer) }
  },
  async cancel() {
    root.render(null); await delay(20)
    const before = jobs.length
    show('math', 'x+'.repeat(2000) + 'x')
    await wait(() => jobs.length > before)
    show('math', 'x+'.repeat(2000) + 'x', false)
    await wait(() => jobs.slice(before).every(job => job.terminated))
    await delay(40)
    return { jobs: jobs.slice(before), rendered: Boolean(document.querySelector('.katex')) }
  },
  async dense(hide = false) {
    root.render(null); await delay(20)
    const before = jobs.length, start = performance.now(), gaps: number[] = []
    peak = 0
    let previous = start, first = 0
    const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; if (!first && document.querySelector('.katex')) first = now - start }, 4)
    const render = (visible: boolean) => root.render(<div>{Array.from({ length: 100 }, (_, index) => <MarkdownMath key={index} expression="x^2" source="$x^2$" visible={visible} />)}</div>)
    try {
      render(true)
      if (hide) { await wait(() => jobs.length > before); render(false); await wait(() => jobs.slice(before).every(job => job.terminated)); await delay(40) }
      else { await wait(() => document.querySelectorAll('.katex').length === 100); await delay(40) }
      return { blocks: 100, peak, first, elapsed: performance.now() - start, maxTimerGap: Math.max(...gaps), rendered: document.querySelectorAll('.katex').length, workersCreated: jobs.length - before, activeWorkers: jobs.slice(before).filter(job => !job.terminated).length, messages: jobs.slice(before).reduce((count,job)=>count+job.messages,0) }
    } finally { clearInterval(timer) }
  }
}
