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

export function startBrowserOperationStep(operation: BrowserOperation, method: string, args: unknown[]): BrowserOperationStep {
  const sensitive = method === 'fillInput' || method === 'typeText' || method === 'js' || method === 'cdp'
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
