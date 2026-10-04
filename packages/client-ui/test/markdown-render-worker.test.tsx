import { tmpdir } from 'node:os'
// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { MARKDOWN_ELEMENT_LIMIT, MARKDOWN_HTML_LIMIT, renderMarkdown } from '../src/lib/markdown-render.js'

let directory: string, workerFile: string
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href)
  directory = await mkdtemp(join(tmpdir(), 'amx-markdown-worker-'))
  await writeFile(join(directory, 'package.json'), '{"type":"module"}')
  await build({ configFile: false, root: resolve('packages/client-ui'), logLevel: 'error', worker: { format: 'es' },
    build: { outDir: directory, emptyOutDir: false, lib: { entry: resolve('packages/client-ui/src/lib/markdown-render-job.ts'), formats: ['es'], fileName: 'markdown-job' } } })
  const files = await readdir(join(directory, 'assets'))
  workerFile = join(directory, 'assets', files.find(file => /^markdown-render\.worker-.*\.js$/.test(file))!)
  expect(workerFile).not.toContain('undefined')
  const caller = await readFile(join(directory, 'markdown-job.js'), 'utf8')
  expect(caller).toContain('markdown-render.worker-')
}, 20_000)
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

function thread() {
  return new Worker(`const {parentPort}=require('node:worker_threads'); globalThis.self=globalThis; self.postMessage=value=>parentPort.postMessage(value); import(${JSON.stringify(pathToFileURL(workerFile).href)}).then(()=>{ parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({ready:true}); });`, { eval: true })
}
async function ready(worker: Worker) { await new Promise<void>((yes, no) => { worker.once('error', no); worker.once('message', () => yes()) }) }
async function render(worker: Worker, input: unknown) {
  const result = new Promise<any>((yes, no) => { worker.once('error', no); worker.once('message', yes) })
  worker.postMessage({ id: 'current', input }); return await result
}
it('executes the actual Vite worker asset, keeps markup inert, and caps generated DOM', async () => {
  const worker = thread()
  try {
    await ready(worker)
    const math = await render(worker, { kind: 'math', source: '\\frac{1}{2}', display: true })
    expect(math.id).toBe('current'); expect(math.result.html).toContain('katex'); expect(math.result.html).toContain('<math')
    const code = await render(worker, { kind: 'code', source: 'const html = "<img src=x onerror=alert(1)>"', language: 'javascript' })
    expect(code.result.html).toContain('hljs-keyword'); expect(code.result.html).toContain('&lt;img'); expect(code.result.html).not.toContain('<img')
    const invalid = await render(worker, { kind: 'math', source: '\\unknownMacro{x}', display: false })
    expect(invalid.result.error).toContain('Undefined control sequence')
    const unsafe = await render(worker, { kind: 'math', source: '\\href{javascript:alert(1)}{x}', display: false })
    expect(unsafe.result.html ?? '').not.toMatch(/<a(?:\s|>)/)
    const expansive = await render(worker, { kind: 'math', source: 'x+'.repeat(1000) + 'x', display: false })
    expect(expansive.result.html).toBeUndefined(); expect(expansive.result.message).toContain('output exceeds')
    expect(math.result.html.length).toBeLessThanOrEqual(MARKDOWN_HTML_LIMIT)
    expect((math.result.html.match(/<[a-zA-Z][^>]*>/g) ?? []).length).toBeLessThanOrEqual(MARKDOWN_ELEMENT_LIMIT)
  } finally { await worker.terminate() }
}, 15_000)
it('terminates the real worker before its outstanding computation can publish', async () => {
  const worker = thread(); await ready(worker)
  let published = false
  worker.on('message', () => { published = true })
  worker.postMessage({ id: 'old', input: { kind: 'math', source: 'x+'.repeat(2000) + 'x', display: true } })
  await worker.terminate()
  expect(published).toBe(false)
})
it('admits exact source byte budgets before expensive parsing', async () => {
  expect((await renderMarkdown({ kind: 'math', source: 'x'.repeat(4097), display: false })).message).toContain('4 KiB')
  expect((await renderMarkdown({ kind: 'code', source: '字'.repeat(22000), language: 'js' })).message).toContain('64 KiB')
})
