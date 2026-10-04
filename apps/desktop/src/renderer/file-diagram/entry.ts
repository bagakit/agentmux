import type { FileDiagramRequest, FileDiagramResult } from '../../shared/file-diagram'

declare global { interface Window { __agentmuxRenderDiagram(request: FileDiagramRequest): Promise<FileDiagramResult> } }

// A private one-job entry. No App preload, persisted workspace state or Agent API exists here.
window.__agentmuxRenderDiagram = async request => {
  try {
    switch (request.kind) {
      case 'mermaid': return await (await import('../src/lib/file-formats/mermaid-engine')).render(request)
      case 'drawio': return await (await import('../src/lib/file-formats/drawio-engine')).render(request)
      case 'plantuml': return await (await import('../src/lib/file-formats/plantuml-engine')).render(request)
    }
  } catch (error) {
    return { id: request.id, svg: '', error: error instanceof Error ? error.message : 'Diagram preview could not render.' }
  }
}
