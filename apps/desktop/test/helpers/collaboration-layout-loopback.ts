import { vi } from 'vitest'
import { act } from 'react'
import { handleCollaborationLayoutRequest, type CollaborationLayoutRequest, type CollaborationLayoutResponse } from '../../src/renderer/src/lib/collaboration-layout-engine'

/** Test only the Worker transport in process; the production dispatcher, WASM engine and response contract still execute. */
export function installCollaborationLayoutLoopback() {
  const requests: CollaborationLayoutRequest[] = []
  vi.stubGlobal('Worker', class {
    onmessage: ((event: MessageEvent<CollaborationLayoutResponse>) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    private controller = new AbortController()
    constructor(url: string | URL) {
      if (!String(url).includes('collaboration-layout.worker.ts')) throw Error('Only the original collaboration layout Worker is expected')
    }
    postMessage(input: CollaborationLayoutRequest) {
      const request = structuredClone(input); requests.push(request)
      queueMicrotask(() => {
        void handleCollaborationLayoutRequest(request, response => {
          const data = structuredClone(response)
          queueMicrotask(() => { if (!this.controller.signal.aborted) this.onmessage?.({ data } as MessageEvent<CollaborationLayoutResponse>) })
        }, this.controller.signal).catch(error => {
          if (!this.controller.signal.aborted) this.onerror?.(new ErrorEvent('error', { error, message: String(error) }))
        })
      })
    }
    terminate() { this.controller.abort() }
  })
  return requests
}

/** Worker replies and camera callbacks cross browser turns; each finite act lets React commit before asserting real DOM. */
export async function settleCollaborationCanvas(assertion: () => void, timeout = 5000) {
  const deadline = Date.now() + timeout
  let failure: unknown
  do {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    try { assertion(); return } catch (error) { failure = error }
  } while (Date.now() < deadline)
  throw failure
}
