/** DOM-free Graphviz computation shared by the worker and the engine oracle. */
export async function renderDot(content: string): Promise<{ svg: string; error?: string }> {
  const { instance } = await import('@viz-js/viz')
  const viz = await instance()
  const result = viz.render(content, { format: 'svg', engine: 'dot' })
  if (result.status !== 'success') return { svg: '', error: result.errors.map(error => error.message).join('\n') || 'DOT could not render.' }
  return { svg: result.output }
}
