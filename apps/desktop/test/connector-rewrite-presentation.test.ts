import { expect, it } from 'vitest'
import { connectorSourceExplanation } from '../src/renderer/src/lib/connector-diagnosis-explanation'
import { connectorConnectionPresentation } from '../src/renderer/src/lib/connector-connection-presentation'
import type { GroupDiagnosis } from '../src/renderer/src/lib/group-diagnosis'

const observed = <T>(value: T) => ({ value, issue: null })
function report(code: string | null): GroupDiagnosis {
  return {
    service: observed({ enabled: true, revision: 1 }), adapterService: observed({ adapterId: 'feishu', enabled: true, revision: 0 }),
    connection: observed({ revision: 1, enabled: true, authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'ready' }, delivery: { state: 'ready' }, receiver: { ref: 'receiver', state: 'ready' } }),
    binding: observed({ state: 'active', currentRevision: 1, scope: { input: 'all-messages', publication: 'future-shared-conversation' }, activeInputGrants: 1, activeAnswerGrants: 1, activePermissionGrants: 1 }),
    incoming: observed({ rows: [] }),
    outgoing: observed({ after: null, afterContent: null, next: null, deliveries: [], sourceObservation: code === null ? { state: 'ready', code: null, codeRecorded: false, checkpointKey: null } : { state: 'unavailable', reason: 'source-gap', code, codeRecorded: true, checkpointKey: null } })
  } as unknown as GroupDiagnosis
}

it('presents a rewrite the owner could not resume as stopped sync with its recovery action, distinct from a different source', () => {
  const rewritten = connectorSourceExplanation({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_REWRITTEN', codeRecorded: true, checkpointKey: null })
  const changed = connectorSourceExplanation({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', codeRecorded: true, checkpointKey: null })
  expect(rewritten.title).toBe('Conversation rewritten after a resume')
  expect(rewritten.detail).toContain('Nothing already sent is resent')
  expect(rewritten.detail).toContain('review sharing to continue from now')
  expect(changed.title).toBe('Saved conversation source changed')
  expect(rewritten.title).not.toBe(changed.title)

  const model = connectorConnectionPresentation(report('AGENT_SESSION_HISTORY_REWRITTEN'))
  expect(model.state).toBe('online')
  // The Publication owner already tried the anchored resume in the same read, so an
  // observed rewrite needs the person: the recovery action and the attention badge stay.
  expect(model.hint).toBe('Reply sync stopped · history rewritten')
  expect(model.primary).toBe('source')
  expect(model.actionLabel).toBe('Try sync now')
  expect(model.attention).toBe('check')
  // A different source still asks for an explicit check.
  expect(connectorConnectionPresentation(report('AGENT_SESSION_HISTORY_SOURCE_CHANGED')).primary).toBe('source')
  // A receiving connection stays online; only the reply source shows its own progress.
  expect(connectorConnectionPresentation(report('AGENT_SESSION_HISTORY_SOURCE_CHANGED')).hint).toBe('Reply sync needs checking')
  expect(connectorConnectionPresentation(report(null)).hint).toBeNull()
})
