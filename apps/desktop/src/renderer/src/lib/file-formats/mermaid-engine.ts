import type { FileDiagramRequest, FileDiagramResult } from '../../../../shared/file-diagram'

/** Called only in a disposable private WebContents, never in the App Renderer. */
export async function render(request: FileDiagramRequest): Promise<FileDiagramResult> {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: request.theme === 'dark' ? 'dark' : 'default',
    htmlLabels: false, flowchart: { htmlLabels: false },
    // Diagram frontmatter cannot relax the host's execution/resource policy.
    secure: ['securityLevel', 'startOnLoad', 'htmlLabels', 'secure', 'maxTextSize', 'maxEdges'] })
  try {
    const result = await mermaid.render('diagram-preview', request.content)
    return { id: request.id, svg: result.svg }
  } catch (error) {
    return { id: request.id, svg: '', error: error instanceof Error ? error.message : String(error) }
  }
}
