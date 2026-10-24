import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import browser from 'puppeteer-core'
import { readSessionHistoryImageBytes } from '@agentmux/core'
import { renderMermaidDiagram } from '../src/mermaid-renderer.js'
import { markdownDiagrams } from '../src/markdown-diagrams.js'

it('Mermaid parser keeps exact fenced source and ignores syntax inside ordinary code', () => {
  const text = 'Before\n\n````text\n```mermaid\nflowchart LR; A-->B\n```\n````\n\n```mermaid\nsequenceDiagram\nA->>B: Hello\n```\n\nAfter'
  const nodes = markdownDiagrams(text)
  expect(nodes).toHaveLength(1)
  expect(nodes[0]!.source).toBe('sequenceDiagram\nA->>B: Hello')
  expect(text.slice(nodes[0]!.start, nodes[0]!.end)).toBe('```mermaid\nsequenceDiagram\nA->>B: Hello\n```')
})

it('Mermaid uses the real private Node browser and releases it when the original render is cancelled', async () => {
  const abort = new AbortController(), launch = browser.launch
  let process: ReturnType<Awaited<ReturnType<typeof launch>>['process']>, exited: Promise<unknown> | undefined
  const spy = vi.spyOn(browser, 'launch').mockImplementation(async options => {
    const instance = await launch(options)
    process = instance.process()
    exited = process && process.exitCode === null ? once(process, 'exit') : Promise.resolve()
    abort.abort(new DOMException('Original diagram cancelled', 'AbortError'))
    return instance
  })
  try {
    await expect(renderMermaidDiagram('flowchart LR; A-->B', { signal: abort.signal, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ name: 'AbortError' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(process!.pid).toBeGreaterThan(0)
    await exited
    expect(process!.exitCode !== null || process!.signalCode !== null).toBe(true)
  } finally { spy.mockRestore() }
})

it('Mermaid blocks diagram network and file directives without contacting their target', async () => {
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.end('outside') })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  try {
    const source = 'flowchart LR\nA@{ img: "http://127.0.0.1:' + port + '/diagram.png", label: "External image", h: 80 }'
    await expect(renderMermaidDiagram(source, { signal: new AbortController().signal, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: 'MERMAID_RESOURCE_UNAVAILABLE' })
    expect(requests).toBe(0)
    await expect(renderMermaidDiagram('flowchart LR\nA@{ img: "file:///private-resource.png", label: "Private image", h: 80 }',
      { signal: new AbortController().signal, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: 'MERMAID_RENDER_FAILED' })
    const original = 'flowchart LR; A[Original text]-->B[Delivered]', options = { signal: new AbortController().signal, maxBytes: 1024 * 1024 }
    const image = await renderMermaidDiagram(original, options)
    expect(readSessionHistoryImageBytes(Buffer.from(image.dataBase64, 'base64'), 1024 * 1024)).toMatchObject({ status: 'read', width: image.width, height: image.height })
    expect(image.width).toBeGreaterThan(200); expect(image.height).toBeGreaterThan(50)
    const longSource = await renderMermaidDiagram('%% ' + 'original source comment '.repeat(3000) + '\n' + original, options)
    expect(longSource.dataBase64).toBe(image.dataBase64)
    const directive = await renderMermaidDiagram('%%{init: {"securityLevel":"loose","theme":"dark","themeCSS":"svg { opacity: 0 }"}}%%\n' + original, options)
    expect(directive.dataBase64).toBe(image.dataBase64)
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
})
