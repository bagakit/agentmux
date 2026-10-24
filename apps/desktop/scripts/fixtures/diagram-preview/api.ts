// Narrow test transport only: the request still reaches the production Main owner and engines.
export const api = { files: {
  renderDiagram: (request: unknown) => (window as any).diagramHost.render(request),
  cancelDiagram: (id: string) => (window as any).diagramHost.cancel(id)
} }
