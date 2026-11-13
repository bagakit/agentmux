import { resolveWithinSelector, type BrowserCdpSender } from './browser-page-snapshot.js'

const WORLD = 'agentmux-structured-observation'

/** Same authorized CDP sender/backend node, with native DOM wrappers in the node's actual frame. */
export async function resolveBrowserStructuredTarget(send: BrowserCdpSender, input: {
  within?: string; backendNodeId?: number
}) {
  const objects = new Set<string>()
  const release = async () => {
    for (const objectId of objects) await send('Runtime.releaseObject', { objectId }).catch(() => {})
    objects.clear()
  }
  const isolated = async (frameId: string): Promise<number> => {
    const response = await send('Page.createIsolatedWorld', { frameId, worldName: WORLD,
      grantUniveralAccess: false }) as { executionContextId?: number }
    if (!Number.isSafeInteger(response.executionContextId) || response.executionContextId! < 1) {
      throw new Error('The isolated document could not be resolved for structured observation.')
    }
    return response.executionContextId!
  }
  const resolveNode = async (backendNodeId: number, executionContextId: number): Promise<string> => {
    const response = await send('DOM.resolveNode', { backendNodeId, executionContextId }) as { object?: { objectId?: string } }
    if (!response.object?.objectId) throw new Error('The issued element could not be resolved in its isolated document.')
    objects.add(response.object.objectId)
    return response.object.objectId
  }
  try {
    const tree = await send('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } }
    let frameId = tree.frameTree?.frame?.id
    if (!frameId) throw new Error('The actual document frame could not be identified for structured observation.')
    let executionContextId = await isolated(frameId)
    if (input.backendNodeId !== undefined) {
      const bootstrap = await resolveNode(input.backendNodeId, executionContextId)
      // Main's sender can also serve same-process child frames. Use native getters in
      // the bootstrap isolate to find the actual document root, never a URL match.
      const root = await send('Runtime.callFunctionOn', { objectId: bootstrap, returnByValue: false,
        functionDeclaration: 'function() { const doc = Object.getOwnPropertyDescriptor(Node.prototype, "ownerDocument").get.call(this); return Object.getOwnPropertyDescriptor(Document.prototype, "documentElement").get.call(doc); }' }) as {
        result?: { objectId?: string }; exceptionDetails?: unknown
      }
      if (root.exceptionDetails || !root.result?.objectId) throw new Error('The issued element document could not be verified.')
      objects.add(root.result.objectId)
      const described = await send('DOM.describeNode', { objectId: root.result.objectId, depth: 0 }) as { node?: { frameId?: string } }
      if (!described.node?.frameId) throw new Error('The issued element document frame could not be verified.')
      frameId = described.node.frameId
      executionContextId = await isolated(frameId)
    }
    let objectId: string
    if (input.backendNodeId !== undefined) objectId = await resolveNode(input.backendNodeId, executionContextId)
    else if (input.within) {
      objectId = await resolveWithinSelector(send, input.within, executionContextId)
      objects.add(objectId)
    } else {
      const response = await send('Runtime.evaluate', { expression: 'document', contextId: executionContextId,
        returnByValue: false }) as { result?: { objectId?: string }; exceptionDetails?: unknown }
      if (response.exceptionDetails || !response.result?.objectId) throw new Error('The current isolated document could not be resolved.')
      objectId = response.result.objectId
      objects.add(objectId)
    }
    const url = await send('Runtime.evaluate', { expression: 'document.URL', contextId: executionContextId,
      returnByValue: true }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (url.exceptionDetails || typeof url.result?.value !== 'string') throw new Error('The current isolated document URL could not be verified.')
    const documentUrl = url.result.value
    return { objectId, document: `${frameId}:${executionContextId}`, release,
      isCurrent: async (): Promise<boolean> => {
        const response = await send('Runtime.callFunctionOn', { objectId, returnByValue: true,
          functionDeclaration: 'function(url) { const doc = this.nodeType === 9 ? this : this.ownerDocument; return this.isConnected && doc.defaultView?.document === doc && doc.URL === url; }',
          arguments: [{ value: documentUrl }] }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
        if (response.exceptionDetails || typeof response.result?.value !== 'boolean') {
          throw new Error('Current isolated document could not be verified. The Browser remains usable; inspect it before retrying extraction.')
        }
        return response.result.value
      }
    }
  } catch (error) { await release(); throw error }
}
