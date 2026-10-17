import { handleCollaborationLayoutRequest, type CollaborationLayoutRequest, type CollaborationLayoutResponse } from './collaboration-layout-engine'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<CollaborationLayoutRequest>) => Promise<void>) | null
  postMessage(value: CollaborationLayoutResponse): void
}
let active: AbortController | undefined
scope.onmessage = event => {
  active?.abort()
  const controller = new AbortController()
  active = controller
  return handleCollaborationLayoutRequest(event.data, response => scope.postMessage(response), controller.signal)
    .finally(() => { if (active === controller) active = undefined })
}
