import { arrangeForceGraph, type CanvasLayoutInput } from './force-layout-engine'
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<{ id: string; input: CanvasLayoutInput }>) => void) | null; postMessage(value: unknown): void }
scope.onmessage = event => {
  const { id, input } = event.data
  void arrangeForceGraph(input).then(positions => scope.postMessage({ id, positions })).catch(error => scope.postMessage({ id, error: error instanceof Error ? error.message : 'Arrangement failed. Your positions are kept.' }))
}
