import type { FileDiagramRequest, FileDiagramResult } from '../../../../shared/file-diagram'
import { WORKSPACE_FILE_MAX_BYTES } from '../../../../shared/workspace-file-bytes'
import { loadDiagramScript } from './diagram-script'

type PlantUmlEngine = {
  renderToString(lines: string[], success: (svg: string) => void, error: (message: string) => void, options?: { dark: boolean }): void
}

/** Official MIT TeaVM browser build, owned by one disposable diagram WebContents. */
export async function render(request: FileDiagramRequest): Promise<FileDiagramResult> {
  const base = new URL('../diagram-assets/plantuml/', window.location.href)
  const globals = window as unknown as Record<string, unknown>
  globals.PLANTUML_STDLIB_BASE = base.href
  await loadDiagramScript(new URL('viz-global.js', base))
  // Loading these small, packaged registries first avoids a theme silently rendering unthemed.
  await Promise.all(['themes.js', 'emoji.js', 'openiconic.js'].map(name => loadDiagramScript(new URL(name, base))))
  const moduleUrl = new URL('plantuml.js', base).href
  const engine = await import(/* @vite-ignore */ moduleUrl) as PlantUmlEngine
  const svg = await new Promise<string>((resolve, reject) => {
    try { engine.renderToString(request.content.split(/\r\n|\r|\n/), resolve, message => reject(new Error(message)), { dark: request.theme === 'dark' }) }
    catch (error) { reject(error) }
  })
  if (!svg.trim().startsWith('<svg')) throw new Error('PlantUML did not produce an SVG diagram.')
  if (new TextEncoder().encode(svg).byteLength > WORKSPACE_FILE_MAX_BYTES) throw new Error('The rendered PlantUML diagram exceeds the preview transfer budget.')
  return { id: request.id, svg }
}
