import {
  BrowserProgramOwner,
  type BrowserProgramTarget,
  type BrowserProgramSession,
  type BrowserProgramPort
} from '@agentmux/browser/operations'
import { ExternalBrowserRequestFailure, type ExternalBrowserBridge, type ExternalBrowserBinding } from './browser-external-bridge.js'
import { attachExternalBrowserTarget } from './browser-external-target.js'
import { uploadBrowserFiles, type BrowserUploads } from './browser-uploads.js'
import { showBrowserOperationFeedback, BROWSER_OPERATION_FEEDBACK_WORLD_NAME, buildBrowserOperationFeedbackRevisionScript } from './browser-operation-feedback.js'

type Stores = ConstructorParameters<typeof BrowserProgramOwner>[1]
/** Extension grants and visible page feedback remain Desktop host adapters. */
export class ExternalBrowserOwner extends BrowserProgramOwner {
  constructor(bridge: ExternalBrowserBridge, stores: Omit<Stores, 'uploads'> & { uploads: BrowserUploads }) {
    const original = (target: BrowserProgramTarget): ExternalBrowserBinding => {
      const binding = bridge.require(target.id)
      if (binding !== target) throw new ExternalBrowserRequestFailure('The original shared target changed. No substitute is selected.', false)
      return binding
    }
    const port: BrowserProgramPort = {
      has: id => bridge.has(id), require: id => bridge.require(id), stopOperation: id => { bridge.stopSharing(id); return { message: 'The shared-tab operation was stopped. Sharing must be granted explicitly before another action.' } },
      attach: (target, owner) => attachExternalBrowserTarget(bridge, original(target), owner),
      observe: (id, listener) => bridge.observe(id, listener),
      observeAvailability: (id, listener) => bridge.observeAvailability(id, listener),
      recordLedger: (id, navigationId) => bridge.recordLedger(id, navigationId), dispose: () => bridge.dispose(),
      feedback: (binding, attached, operation, requireCurrent) => {
      let revision = 0
      let world: { navigationId: string; contextId: number } | null = null
      const contents: Parameters<typeof showBrowserOperationFeedback>[0]['contents'] = { isDestroyed: () => attached.endedReason !== null,
          executeJavaScriptInIsolatedWorld: async (_worldId, scripts) => {
            requireCurrent()
            if (!world || world.navigationId !== binding.navigationId) {
              const tree = await attached.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
              const created = await attached.sendCommand('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id,
                worldName: BROWSER_OPERATION_FEEDBACK_WORLD_NAME }) as { executionContextId: number }
              requireCurrent(); world = { navigationId: binding.navigationId, contextId: created.executionContextId }
            }
            const result = await attached.sendCommand('Runtime.evaluate', { contextId: world.contextId,
              expression: `(()=>{let value;${scripts.map(script => `value=(${script.code});`).join('\n')}return {value,revision:(${buildBrowserOperationFeedbackRevisionScript()})}})()`, returnByValue: true }) as { result?: { value?: { value?: unknown; revision?: unknown } }; exceptionDetails?: unknown }
            if (result.exceptionDetails) throw new Error('Shared-tab action feedback could not be displayed.')
            const observed = result.result?.value?.revision
            if (typeof observed === 'number' && Number.isSafeInteger(observed) && observed >= 0) revision = Math.max(revision, observed)
            return result.result?.value?.value
          } }
      return showBrowserOperationFeedback({ operationId: operation.id, operatorName: operation.operator.name,
        navigationId: () => binding.navigationId, nextRevision: () => ++revision,
        isCurrent: () => { try { requireCurrent(); return true } catch { return false } }, contents,
        warn: () => { operation.warning ??= 'Action feedback is unavailable. The shared page and Agent remain usable; inspect the operation history.' } })
      }
    }
    super(port, { ...stores, uploads: (binding, operation, requireCurrent) => ({
      upload: (target, paths) => { requireCurrent(); return uploadBrowserFiles(stores.uploads, {
        workspaceId: binding.workspaceId, browserId: binding.id, operationId: operation.id, navigationId: binding.navigationId,
        documentSurvivesClient: true, currentNavigationId: () => { requireCurrent(); return binding.navigationId }, target
      }, paths) }
    }) })
  }
}
