// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { render } from '../src/renderer/src/lib/file-formats/drawio-engine'

const port = vi.hoisted(() => ({ load: vi.fn(async (_url: URL) => {}) }))
vi.mock('../src/renderer/src/lib/file-formats/diagram-script', () => ({ loadDiagramScript: port.load }))
afterEach(() => { vi.unstubAllGlobals(); port.load.mockClear(); document.body.replaceChildren() })

it('drawio passes the current model and requested page to the official viewer, exports and releases it', async () => {
  const draft = '<mxfile><diagram name="A"><mxGraphModel /></diagram><diagram name="B"><mxGraphModel /></diagram></mxfile>'
  const selectPage = vi.fn(), destroy = vi.fn(), getSvg = vi.fn(() => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.textContent = 'draft page B'; return svg
  })
  let config: Record<string, unknown> | undefined
  Object.assign(window, { Editor: {}, GraphViewer: { createViewerForElement(element: HTMLElement, done: (value: unknown) => void) {
    config = JSON.parse(element.getAttribute('data-mxgraph')!)
    done({ graph: { getSvg, destroy }, editor: { convertImages(svg: SVGElement, callback: (svg: SVGElement) => void) { callback(svg) } }, selectPage })
  } } })
  const result = await render({ id: 'draft', kind: 'drawio', content: draft, theme: 'light', page: 1 })
  expect(config?.xml).toBe(draft)
  expect(config?.page).toBe(1)
  expect(selectPage).toHaveBeenCalledWith(1)
  expect(result.pageCount).toBe(2)
  expect(result.svg).toContain('draft page B')
  expect(destroy).toHaveBeenCalledOnce()
  expect(document.body.children).toHaveLength(0)
  expect(port.load.mock.calls[0]?.[0].href).not.toContain('diagrams.net')
})

it('drawio rejects ordinary XML, invalid models and invalid page requests before loading an engine', async () => {
  for (const content of ['<config />', '<mxfile>', '<mxfile />']) {
    await expect(render({ id: 'bad', kind: 'drawio', content, theme: 'light' })).rejects.toThrow()
  }
  await expect(render({ id: 'page', kind: 'drawio', content: '<mxGraphModel />', theme: 'light', page: 2 })).rejects.toThrow('page')
  expect(port.load).not.toHaveBeenCalled()
})
