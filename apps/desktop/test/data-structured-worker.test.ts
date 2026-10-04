import { beforeAll, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import type { StructuredPreview } from '../src/renderer/src/lib/file-formats/data-model'

let code: string
beforeAll(async () => {
  const result = await build({ configFile: false, logLevel: 'error', build: { write: false, minify: false,
    lib: { entry: fileURLToPath(new URL('../src/renderer/src/lib/file-formats/data-structured.worker.ts',import.meta.url)), formats: ['es'] },
    rollupOptions: { output: { inlineDynamicImports: true } } } })
  const outputs = Array.isArray(result) ? result : [result]
  const chunk = outputs.flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
  if (!chunk || chunk.type !== 'chunk') throw Error('Production structured Worker missing')
  code = chunk.code
})
function thread() {
  return new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:value=>parentPort.postMessage(value)};import('data:text/javascript;base64,'+Buffer.from(${JSON.stringify(code)}).toString('base64')).then(()=>{parentPort.on('message',data=>{parentPort.postMessage({started:data.id});self.onmessage({data})});parentPort.postMessage({ready:true})});`,{eval:true})
}
async function ready(worker: Worker) { await new Promise<void>((yes,no)=>{worker.once('message',()=>yes());worker.once('error',no)}) }
it('executes production static dispatch for JSONL/YAML/TOML and keeps exact error and scalar models', async () => {
  const worker = thread(); await ready(worker)
  try {
    for (const [kind,content] of [['jsonl','{"id":9223372036854775807}\n{bad}\nfalse'],['yaml','a: 1\n---\nb: *missing'],['toml','value = 9223372036854775807']]) {
      const reply = new Promise<StructuredPreview>((yes,no)=>{const receive=(message: any)=>{if(message.parsed){worker.off('message',receive);yes(message.parsed)}};worker.on('message',receive);worker.once('error',no)})
      worker.postMessage({id:kind,kind,content})
      const parsed = await reply
      expect(parsed.status).toBe('ready')
      if(parsed.status!=='ready')continue
      if(kind==='jsonl'){expect(parsed.records).toHaveLength(3);expect(parsed.diagnostics[0]?.line).toBe(2);expect(JSON.stringify(parsed.records[0])).toContain('9223372036854775807')}
      if(kind==='yaml'){expect(parsed.records).toHaveLength(2);expect(parsed.diagnostics[0]?.message).toContain('Unresolved alias')}
      if(kind==='toml')expect(JSON.stringify(parsed.records)).toContain('9223372036854775807')
    }
  } finally {await worker.terminate()}
})
it('hard-stops a real near-1MiB YAML parse while the original source stays untouched', async () => {
  const worker = thread();await ready(worker)
  const content = Array.from({length:34000},(_,index)=>`key${index}: value for this entry\n`).join('')
  expect(content.length).toBeLessThan(1024*1024)
  let published = false
  worker.on('message',(message: any)=>{if(message.parsed)published=true})
  const started = new Promise<void>(yes=>worker.once('message',()=>yes()))
  worker.postMessage({id:'old-large-draft',kind:'yaml',content});await started
  // Let the production dispatch enter its synchronous parser, then use native termination.
  await new Promise(resolve=>setTimeout(resolve,20))
  const start = performance.now();await worker.terminate()
  expect(performance.now()-start).toBeLessThan(500)
  expect(published).toBe(false);expect(content).toContain('key33999: value for this entry')
})
