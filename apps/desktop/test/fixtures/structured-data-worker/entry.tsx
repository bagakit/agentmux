import { createRoot } from 'react-dom/client'
import { StructuredDataPreview } from '../../../src/renderer/src/components/file-preview/StructuredDataPreview'
const root = createRoot(document.getElementById('root')!), NativeWorker = window.Worker
const workers: Array<{ terminated: boolean }> = []
window.Worker = class extends NativeWorker {
  fact = { terminated: false }
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.push(this.fact) }
  override terminate() { this.fact.terminated = true; super.terminate() }
}
const delay = (ms: number) => new Promise(resolve=>setTimeout(resolve,ms))
async function wait(predicate: () => boolean) { const until=performance.now()+20000;while(!predicate()){if(performance.now()>until)throw Error('Structured production consumer did not settle');await delay(5)} }
;(window as any).structuredProbe = {
  async sample(kind: 'yaml'|'toml'|'jsonl', content: string) {
    root.render(null);await delay(20)
    let previous=performance.now();const start=previous,gaps:number[]=[],before=workers.length
    const timer=setInterval(()=>{const now=performance.now();gaps.push(now-previous);previous=now},4)
    try {
      root.render(<StructuredDataPreview kind={kind} content={content} />)
      await wait(()=>Boolean(document.querySelector('[aria-label="Structured content"]')));await delay(40)
      return {kind,bytes:content.length,elapsed:performance.now()-start,maxTimerGap:Math.max(...gaps),elements:document.getElementById('root')!.querySelectorAll('*').length,text:document.body.textContent?.slice(0,2000),workers:workers.slice(before)}
    } finally {clearInterval(timer)}
  },
  async hidden(content: string) {
    root.render(null);await delay(20);const before=workers.length
    root.render(<StructuredDataPreview kind="yaml" content={content} visible={false} />);await delay(30)
    const hiddenStarts=workers.length-before
    root.render(<StructuredDataPreview kind="yaml" content={content} />);await wait(()=>workers.length>before);await delay(30)
    const start=performance.now();root.render(<StructuredDataPreview kind="yaml" content={content} visible={false} />)
    await wait(()=>workers.slice(before).every(worker=>worker.terminated));await delay(40)
    return {hiddenStarts,hideElapsed:performance.now()-start,workers:workers.slice(before),empty:document.getElementById('root')!.childNodes.length===0}
  }
}
