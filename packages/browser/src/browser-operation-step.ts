import type { BrowserOperation, BrowserOperationStep, BrowserReplayStep, BrowserReplayTarget } from './model/browser-operation.js'

export function summarizeBrowserValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return 'object'
  return typeof value
}

export function safeBrowserUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return 'about:blank'
  }
}

/**
 * Page calls whose arguments are never kept: text a person or page may consider private (typed
 * values, prompt answers) and opaque page code or protocol input. One list, read by the step and by
 * the journal, so a new private argument is redacted in both or in neither.
 */
export function isSensitiveBrowserPageCall(method: string): boolean {
  return method === 'uploadFiles' || method === 'fillInput' || method === 'typeText' || method === 'acceptDialog' || method === 'js' || method === 'cdp' ||
    method === 'startHarCapture' || method === 'finishHarCapture' ||
    method === 'watchRequests' || method === 'readRequests' || method === 'waitForResponse' || method === 'stopWatchingRequests' ||
    method === 'routeRequests' || method === 'unrouteRequests' || method === 'setNetworkConditions' || method === 'clearNetworkConditions'
}

export function startBrowserOperationStep(operation: BrowserOperation, method: string, args: unknown[]): BrowserOperationStep {
  const sensitive = isSensitiveBrowserPageCall(method)
  const replay: BrowserReplayStep = {
    method,
    url: safeBrowserUrl(operation.url),
    args: method === 'drag' || method === 'swipe' ? [] : sensitive
      ? []
      : (typeof args[0] === 'string' && args[0].startsWith('@') ? args.slice(1) : args)
          .map((arg) => typeof arg === 'string' && arg.length > 120 ? '[redacted]' : arg),
    ...(method === 'fillInput' || method === 'typeText' ? { inputKey: 'value', blockedReason: 'Sensitive input is requested again at replay time.' } : {}),
    ...(method === 'uploadFiles' ? { blockedReason: 'File selections need fresh Workspace parameters; old upload paths are not replayed.' } : {}),
    ...(method === 'js' || method === 'cdp' ? { blockedReason: 'Opaque page code or protocol input requires explicit review.' } : {}),
    ...(['routeRequests','unrouteRequests','setNetworkConditions','clearNetworkConditions'].includes(method) ? { blockedReason: 'Network rules belong to their original program and document; apply a new explicit rule set instead of replaying old filters or mock content.' } : {}),
    ...(['startHarCapture', 'finishHarCapture'].includes(method) ? { blockedReason: 'HAR capture belongs to its original program. Review and start a new recording explicitly.' } : {}),
    ...(method === 'watchRequests' || method === 'readRequests' || method === 'waitForResponse' || method === 'stopWatchingRequests'
      ? { blockedReason: 'Network readers belong to their original program and document. Start a new explicit observation; old reader handles and URL filters are not retained.' } : {})
  }
  const step: BrowserOperationStep = {
    sequence: operation.steps.length + 1,
    method,
    label: method,
    startedAt: Date.now(),
    status: 'running',
    ...(typeof args[0] === 'string' && args[0].startsWith('@') ? { ref: args[0] } : {}),
    replay
  }
  operation.steps.push(step)
  operation.summary = `Running ${method}`
  return step
}

/** A page call records onto its original step even while another observation is in flight. */
export function recordBrowserOperationTarget(step: BrowserOperationStep, target: BrowserReplayTarget, endpoint?: 'destination'): void {
  if (endpoint === 'destination') {
    if (step.replay) step.replay.destination = target
  } else {
    step.target = target
    if (step.replay) step.replay.target = target
  }
}
