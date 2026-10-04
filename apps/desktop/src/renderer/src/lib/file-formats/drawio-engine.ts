import type { FileDiagramRequest, FileDiagramResult } from '../../../../shared/file-diagram'
import { WORKSPACE_FILE_MAX_BYTES } from '../../../../shared/workspace-file-bytes'
import { loadDiagramScript } from './diagram-script'

type Viewer = {
  diagrams?: HTMLCollectionOf<Element>
  selectPage?(page: number): void
  graph: { getSvg(...args: unknown[]): SVGElement; destroy(): void }
  editor: { convertImages(svg: SVGElement, done: (svg: SVGElement) => void): void; destroy?(): void }
}
type DrawioWindow = Window & Record<string, unknown> & {
  GraphViewer: { createViewerForElement(element: HTMLElement, callback: (viewer: Viewer) => void): void }
  Editor: { enableServiceWorker: boolean }
}

/** Uses the unmodified official viewer; this module never executes in the App Renderer. */
export async function render(request: FileDiagramRequest): Promise<FileDiagramResult> {
  const doc = new DOMParser().parseFromString(request.content, 'application/xml')
  if (doc.querySelector('parsererror') || !['mxfile', 'mxGraphModel'].includes(doc.documentElement?.nodeName)) {
    throw new Error('Invalid draw.io model. Expected mxfile or mxGraphModel XML.')
  }
  const pages = doc.documentElement.nodeName === 'mxfile' ? doc.documentElement.getElementsByTagName('diagram').length : 1
  const page = request.page ?? 0
  if (!pages || !Number.isInteger(page) || page < 0 || page >= pages) throw new Error('The requested draw.io page does not exist.')

  const base = new URL('../diagram-assets/drawio/', window.location.href)
  const w = window as unknown as DrawioWindow
  // The official bundle otherwise defaults to viewer.diagrams.net. All bases are explicit.
  for (const [key, path] of Object.entries({
    PROXY_URL: 'disabled-proxy', STYLE_PATH: 'styles', SHAPES_PATH: 'shapes', STENCIL_PATH: 'stencils',
    GRAPH_IMAGE_PATH: 'img', mxImageBasePath: 'mxgraph/images', mxBasePath: 'mxgraph/',
    DRAW_MATH_URL: 'math4/es5', DRAWIO_BASE_URL: '.'
  })) w[key] = new URL(path, base).href.replace(/\/$/, '')
  w.mxLoadResources = false
  w.mxLoadStylesheets = false
  w.mxLanguage = 'en'
  w.onDrawioViewerLoad = () => {}
  await loadDiagramScript(new URL('js/viewer-static.min.js', base))
  w.Editor.enableServiceWorker = false

  const container = document.createElement('div')
  container.style.cssText = 'width:1024px;min-height:768px;position:relative'
  document.body.append(container)
  container.setAttribute('data-mxgraph', JSON.stringify({
    xml: request.content, page, toolbar: '', lightbox: false, nav: false,
    'check-visible-state': false, 'dark-mode': request.theme === 'dark', 'auto-fit': false
  }))
  let viewer: Viewer | undefined
  try {
    viewer = await new Promise<Viewer>((resolve, reject) => {
      try { w.GraphViewer.createViewerForElement(container, resolve) } catch (error) { reject(error) }
    })
    if (!viewer.graph) throw new Error('The draw.io viewer could not decode this model.')
    if (pages > 1) viewer.selectPage?.(page)
    // Both the vector export and image embedding are official viewer APIs.
    const svg = await new Promise<SVGElement>((resolve, reject) => {
      try { viewer!.editor.convertImages(viewer!.graph.getSvg(null, null, 8), resolve) } catch (error) { reject(error) }
    })
    const text = new XMLSerializer().serializeToString(svg)
    if (new TextEncoder().encode(text).byteLength > WORKSPACE_FILE_MAX_BYTES) throw new Error('The rendered draw.io diagram exceeds the preview transfer budget.')
    return { id: request.id, svg: text, pageCount: pages }
  } finally {
    if (viewer?.editor.destroy) viewer.editor.destroy()
    else viewer?.graph?.destroy()
    container.remove()
  }
}
