import type { AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import type { BrowserInputContext } from '@agentmux/core/browser-input-context'
import type { AgentTimelineItem } from '@agentmux/core'
import { composeAgentPrompt } from '@agentmux/core/agent-outbound-message'
import { fixtureEpoch } from '../../../../test/fixture-values.mjs'

export const context: BrowserInputContext = {
  kind: 'browser', version: 1, capturedAt: fixtureEpoch(1, 100),
  browser: { hostId: 'local', browserId: 'review-browser', navigationId: 'page-navigation' },
  page: { url: 'https://sample.invalid/checkout?mode=review', title: 'Review shipping details' },
  activity: { operationId: 'browser-operation', stepSequence: 4, phase: 'running', observedAt: fixtureEpoch(1, 99) },
  selection: { kind: 'region', capturedAt: fixtureEpoch(1, 96),
    source: { hostId: 'local', browserId: 'review-browser', navigationId: 'selection-navigation', operationId: 'selection-operation', stepSequence: 2, association: 'observed-during' },
    observationEnd: { hostId: 'local', browserId: 'review-browser', navigationId: 'page-navigation', association: 'unknown', observedAt: fixtureEpoch(1, 98) },
    region: { x: 80, y: 120, width: 320, height: 160, space: 'capture-pixels' },
    attachment: { hostId: 'local', path: 'capture/selection.png', mimeType: 'image/png', width: 960, height: 640 } }
}
export const body = 'Please review the selected shipping address before continuing.\n\nThe page may have changed since this capture.'
export const wire = composeAgentPrompt(body, undefined, context).text
export const authoredExample = composeAgentPrompt('An example in the original user body.', undefined,
  { ...context, page: { url: 'https://example.invalid/literal', title: 'Authored example only' } }).text

export function capturedItem(content = body): AgentTimelineItem {
  return { id: 'captured-opinion', agentSessionId: 'recipient', kind: 'user_message', status: 'complete', source: 'user',
    title: 'Original opinion', content, publicContent: 'confirmed', inputContext: context, inputContextSource: 'host-capture',
    createdAt: fixtureEpoch(1, 101), updatedAt: fixtureEpoch(1, 101) }
}
export function mailboxItem(): AgentInputMailboxItem {
  return { kind: 'controlled', sequence: 1, recordedAt: fixtureEpoch(1, 101), receipt: null,
    intent: { key: { kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'original-run' }, submissionId: 'original-input' },
      admissionIntent: { kind: 'manual-actor', expectedRun: { runId: 'original-run' } }, execution: 'immediate',
      source: { kind: 'prompt', prompt: body, inputContext: context, inputContextSource: 'host-capture', promptWire: wire } } }
}
