import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'

// Original Renderer control consumer and original preload/API; no equivalent relay.
let disposeControl = api.control.onRequest((request, signal) => useAppStore.getState().executeControl(request, signal))
Object.assign(window, { receiptProof: {
  setup(config: unknown, session: unknown) {
    useAppStore.setState({ config, sessions: [session], loading: false } as never)
    document.querySelector('#receipt-state')!.textContent = 'Original control consumer ready'
  },
  // An explicit hostile reply port isolates the actual registered Main guard.
  // The six original input cases above it always use the product consumer.
  rawFailure(error: unknown) {
    disposeControl()
    disposeControl = window.agentmux.control.onRequest(request => {
      window.agentmux.control.respond({ requestId: request.requestId, ok: false, error } as never)
    })
  }
} })
