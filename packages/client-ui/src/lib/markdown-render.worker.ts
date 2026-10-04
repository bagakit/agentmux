import { renderMarkdown, type MarkdownRenderInput } from './markdown-render.js'

self.onmessage = (event: MessageEvent<{ id: string; input: MarkdownRenderInput }>) => {
  const { id, input } = event.data
  void renderMarkdown(input).then(result => self.postMessage({ id, result }), error => self.postMessage({ id, result: { error: error instanceof Error ? error.message : String(error) } }))
}
