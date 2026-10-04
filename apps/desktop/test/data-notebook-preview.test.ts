import { beforeAll, describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { createNotebookReader, notebookText, type NotebookReply } from '../src/renderer/src/lib/file-formats/data-notebook'

const cell = (source: unknown, extra = {}) => ({ cell_type: 'code', metadata: {}, source, execution_count: null, outputs: [], ...extra })
const notebook = (cells: unknown[], extra = {}) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } }, cells, ...extra })

describe('Notebook readonly page adapter', () => {
  it('joins nbformat multiline fields without injecting newlines and keeps typed MIME/unknown outputs', () => {
    expect(notebookText(['hello', ' world\n'])).toBe('hello world\n')
    const source = notebook([cell(['print(', '1)'], { id: 'first', outputs: [
      { output_type: 'stream', name: 'stdout', text: ['hello', ' world'] },
      { output_type: 'display_data', data: { 'application/json': { n: 42 }, 'text/html': '<script>evil()</script><b>hello</b>', 'application/javascript': 'evil()' } },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['one', 'two'] },
      { output_type: 'future_output', data: { raw: true } }
    ] })], { unknown_future: { kept: true } })
    const result = createNotebookReader(source).page(0)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.language).toBe('python')
    expect(result.cells[0]?.source).toBe('print(1)')
    expect(result.cells[0]?.outputs[0]).toMatchObject({ type: 'text', text: 'hello world' })
    const rich = result.cells[0]?.outputs[1]
    expect(rich?.type).toBe('mime')
    if (rich?.type === 'mime') {
      expect(rich.representations[0]?.node?.children?.[0]?.text).toBe('42')
      expect(rich.representations[1]?.kind).toBe('html')
      expect(rich.representations[2]?.notice).toContain('not executed')
    }
    expect(result.cells[0]?.outputs[2]).toMatchObject({ text: 'ValueError: bad\none\ntwo' })
    expect(result.cells[0]?.outputs[3]).toMatchObject({ label: 'Unsupported output: future_output' })
    expect(JSON.parse(source).unknown_future).toEqual({ kept: true })
  })
  it('paginates cells, validates malformed cells locally and preserves unknown/future notebook fields', () => {
    const source = notebook(Array.from({ length: 27 }, (_, index) => cell(`cell${index}`, { id: index < 2 ? 'duplicate' : `cell-${index}`, ...(index === 1 ? { source: 42 } : {}) })), { nbformat_minor: 9 })
    const reader = createNotebookReader(source), first = reader.page(0), second = reader.page(1)
    expect(first.status).toBe('ready'); expect(second.status).toBe('ready')
    if (first.status !== 'ready' || second.status !== 'ready') return
    expect(first.cells).toHaveLength(20); expect(second.cells).toHaveLength(7)
    expect(second.cells[0]?.index).toBe(20)
    expect(first.cells[0]?.diagnostics.join(' ')).toContain('unique id')
    expect(first.cells[1]?.diagnostics.join(' ')).toContain('source must be')
    expect(first.cells[2]?.source).toBe('cell2')
    expect(first.notice).toContain('unknown fields are preserved')
    expect(createNotebookReader('{broken').page(0)).toMatchObject({ status: 'invalid' })
    expect(createNotebookReader(notebook([], { nbformat: 3 })).page(0)).toMatchObject({ status: 'invalid' })
  })
  it('keeps Markdown attachments as bounded source MIME and exposes honest output limits', () => {
    const source = notebook([{ cell_type: 'markdown', id: 'md', metadata: {}, source: '![img](attachment:test.png)', attachments: { 'test.png': { 'image/png': ['YW', 'Jj'] } } }, cell('ok', { id: 'code', outputs: [{ output_type: 'display_data', data: { 'text/plain': 'x'.repeat(1024 * 1024) } }] })])
    const result = createNotebookReader(source).page(0)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.cells[0]?.attachments['test.png']?.[0]).toMatchObject({ kind: 'image', text: 'YWJj' })
    const output = result.cells[1]?.outputs[0]
    if (output?.type === 'mime') expect(output.representations[0]?.notice).toContain('exceeds the preview budget')
    expect(createNotebookReader('x'.repeat(16 * 1024 * 1024 + 1)).page(0)).toMatchObject({ status: 'too-large' })
  })
})

describe('production notebook Worker', () => {
  let code: string
  beforeAll(async () => {
    const output = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: fileURLToPath(new URL('../src/renderer/src/lib/file-formats/data-notebook.worker.ts', import.meta.url)), formats: ['es'] } } })
    const outputs = Array.isArray(output) ? output : [output]
    const chunk = outputs.flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('Production Worker bundle not found')
    code = chunk.code
  })
  it('executes the actual browser worker protocol on a separate thread, returning only requested cells', async () => {
    const worker = new Worker(`const {parentPort}=require('node:worker_threads'); globalThis.self={postMessage:value=>parentPort.postMessage(value)}; import(${JSON.stringify('data:text/javascript;base64,')}+Buffer.from(${JSON.stringify(code)}).toString('base64')).then(()=>parentPort.on('message',data=>self.onmessage({data})));`, { eval: true })
    try {
      const reply = () => new Promise<NotebookReply>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
      const firstReply = reply()
      worker.postMessage({ type: 'open', job: 'actual-worker', content: notebook(Array.from({ length: 23 }, (_, index) => cell(`cell${index}`, { id: `cell-${index}` }))) })
      const first = await firstReply
      expect(first.job).toBe('actual-worker'); expect(first.result.status).toBe('ready')
      if (first.result.status === 'ready') expect(first.result.cells).toHaveLength(20)
      const pageReply = reply(); worker.postMessage({ type: 'page', job: 'actual-worker', page: 1 })
      const page = await pageReply
      expect(page.result).toMatchObject({ status: 'ready', page: 1 })
      if (page.result.status === 'ready') expect(page.result.cells[0]?.source).toBe('cell20')
    } finally { await worker.terminate() }
  })
})
