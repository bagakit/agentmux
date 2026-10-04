import { formatFileContent } from './format-engine'
type Request = { id: string; path: string; content: string }
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage(value: { id: string; content?: string; error?: string }): void }
scope.onmessage = event => {
  const { id, path, content } = event.data
  void formatFileContent(path, content).then(value => scope.postMessage({ id, content: value })).catch(error => scope.postMessage({ id, error: error instanceof Error ? error.message : 'Formatting failed. The draft is unchanged.' }))
}
