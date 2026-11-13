import type { BrowserOperation, BrowserOperationStep, BrowserReplayStep } from '../shared/browser-operation.js'

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
  return method === 'fillInput' || method === 'typeText' || method === 'acceptDialog' || method === 'js' || method === 'cdp'
}

export function startBrowserOperationStep(operation: BrowserOperation, method: string, args: unknown[]): BrowserOperationStep {
  const sensitive = isSensitiveBrowserPageCall(method)
  const replay: BrowserReplayStep = {
    method,
    url: safeBrowserUrl(operation.url),
    args: sensitive
      ? []
      : (typeof args[0] === 'string' && args[0].startsWith('@') ? args.slice(1) : args)
          .map((arg) => typeof arg === 'string' && arg.length > 120 ? '[redacted]' : arg),
    ...(method === 'fillInput' || method === 'typeText' ? { inputKey: 'value', blockedReason: 'Sensitive input is requested again at replay time.' } : {}),
    ...(method === 'js' || method === 'cdp' ? { blockedReason: 'Opaque page code or protocol input requires explicit review.' } : {})
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
