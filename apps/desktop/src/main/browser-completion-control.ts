import { BROWSER_COMPLETION_UNAVAILABLE_WARNING, parseBrowserCompletionFacts,
  type AgentMuxControlBrowserOperation, type AgentMuxControlResult } from '@agentmux/core'
import type { BrowserOutcomeEvaluation } from '../shared/browser-outcome-criteria.js'
import type { BrowserOperationEvent } from './browser-operation-journal.js'

type Operation = AgentMuxControlBrowserOperation & { outcome?: { evaluation?: BrowserOutcomeEvaluation } }

/** Project the existing Main facts at the Control boundary; producer declarations remain local. */
export function projectBrowserControlOperation(value: Operation): AgentMuxControlBrowserOperation
export function projectBrowserControlOperation(value: Operation | null): AgentMuxControlBrowserOperation | null
export function projectBrowserControlOperation(value: Operation | null): AgentMuxControlBrowserOperation | null {
  if (!value) return null
  const { outcome, completion: _completion, ...operation } = value
  if (!outcome?.evaluation) return operation
  try {
    return { ...operation, completion: parseBrowserCompletionFacts(outcome.evaluation,
      { operationId: operation.id, browserId: operation.browserId }) }
  } catch {
    return { ...operation, warning: [operation.warning, BROWSER_COMPLETION_UNAVAILABLE_WARNING].filter(Boolean).join(' ') }
  }
}

export function projectBrowserControlResult(result: AgentMuxControlResult): AgentMuxControlResult {
  if (result.operation === 'browser.history') return { ...result, operations: result.operations.map(operation => projectBrowserControlOperation(operation)) }
  if (result.operation === 'browser.run' || (result.operation === 'browser.replay' && result.mode !== 'preview')) {
    return { ...result, runOperation: projectBrowserControlOperation(result.runOperation) }
  }
  if (result.operation === 'browser.operation' || result.operation === 'browser.stop') {
    return { ...result, runOperation: projectBrowserControlOperation(result.runOperation) }
  }
  return result
}

export function projectBrowserControlEvent(event: BrowserOperationEvent): unknown {
  return 'operation' in event ? { ...event, operation: projectBrowserControlOperation(event.operation) } : event
}
