import type { AgentMuxControlRequest } from '@agentmux/core/control'

/** Desktop presents Browser workfaces; object-only lifecycle belongs to an owning headless host. */
export function isStandaloneBrowserObjectMethod(operation: string): operation is 'browser.create' | 'browser.close' {
  return operation === 'browser.create' || operation === 'browser.close'
}
export function isStandaloneBrowserObjectRequest(request: AgentMuxControlRequest): request is Extract<AgentMuxControlRequest, { operation: 'browser.create' | 'browser.close' }> {
  return isStandaloneBrowserObjectMethod(request.operation)
}
export function unsupportedDesktopBrowserObject(): Error & { code: string } {
  return Object.assign(new Error('This Desktop endpoint opens Browser workfaces with browser.open and an explicit destination. Object-only create/close requires its exact owning standalone Browser host. Existing Browser workfaces and Agent operations remain available.'), { code: 'BROWSER_OBJECT_HOST_UNSUPPORTED' })
}
