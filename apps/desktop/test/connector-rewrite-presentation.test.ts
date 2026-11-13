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

it('presents an in-place rewrite as automatic resumption, distinct from a different source', () => {
  const rewritten = connectorSourceExplanation({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_REWRITTEN', codeRecorded: true, checkpointKey: null })
  const changed = connectorSourceExplanation({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', codeRecorded: true, checkpointKey: null })
  expect(rewritten.title).toBe('Conversation rewritten after a resume')
  expect(rewritten.detail).toContain('nothing already sent is resent')
  expect(changed.title).toBe('Saved conversation source changed')
  expect(rewritten.title).not.toBe(changed.title)

  const model = connectorConnectionPresentation(report('AGENT_SESSION_HISTORY_REWRITTEN'))
  expect(model.state).toBe('online')
  expect(model.hint).toBe('History rewritten · catching up')
  // Automatic recovery is not a call to action: no primary button and no attention badge.
  expect(model.primary).toBe('check')
  expect(model.automatic).toBe(true)
  expect(model.attention).toBeNull()
  // A different source still asks for an explicit check.
  expect(connectorConnectionPresentation(report('AGENT_SESSION_HISTORY_SOURCE_CHANGED')).primary).toBe('source')
  // A receiving connection stays online; only the reply source shows its own progress.
  expect(connectorConnectionPresentation(report('AGENT_SESSION_HISTORY_SOURCE_CHANGED')).hint).toBe('Reply sync needs checking')
  expect(connectorConnectionPresentation(report(null)).hint).toBeNull()
})
