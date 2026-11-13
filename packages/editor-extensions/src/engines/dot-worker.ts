import { renderDot } from './dot-engine'

type Request = { id: string; content: string }
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage(value: { id: string; svg: string; error?: string }): void }
scope.onmessage = event => {
  const { id, content } = event.data
  void renderDot(content).then(result => scope.postMessage({ id, ...result })).catch(error => scope.postMessage({ id, svg: '', error: error instanceof Error ? error.message : 'DOT could not render.' }))
}
