import type { AgentMuxRpcResult } from '@agentmux/core'
import type { MountedAgentOpenInput } from '../lib/space-mount-launch'
type Report = NonNullable<NonNullable<AgentMuxRpcResult<'space.inspect'>['request']>['report']>
/** Positive metadata projection for a local copy. Error prose and original
 * request bodies deliberately remain outside this snapshot. No fact is read. */
export function sourceLaunchDiagnostics(input: MountedAgentOpenInput, original: Report | undefined, current: Report | undefined, readFailed: boolean) {
  const report = current ?? original
  const reference = (value: { bindingId: string; agentSessionId: string; createOperationId: string }) => ({ bindingId: value.bindingId, agentSessionId: value.agentSessionId, createOperationId: value.createOperationId })
  const failure = (issue: Report['issues'][number]) => ({ step: issue.step, category: issue.executionFailure ? 'execution-unconfirmed' : issue.step === 'creation' ? 'source-operation-unconfirmed' : 'source-observation-unconfirmed',
    ...(issue.executionFailure ? { failure: { reference: reference(issue.executionFailure.reference), hostId: issue.executionFailure.hostId, role: issue.executionFailure.role, stage: issue.executionFailure.stage } } : {}) })
  const metadata = report?.execution?.diagnostics
  const helper = (role: 'executor' | 'frontend') => { const h = metadata!.helpers[role]; return { start: { outcome: h.start.outcome, runId: h.start.runId }, cursor: h.cursor, ownerInstanceId: h.ownerInstanceId } }
  return { schema: 'agentmux.source-launch-diagnosis.v1', source: { hostId: input.target.hostId, reference: { runtimeId: input.target.reference.runtimeId, spaceId: input.target.reference.spaceId } }, operationId: input.request.operationId,
    original: { outcome: original?.outcome ?? 'unobserved', issues: original?.issues.map(failure) ?? [] },
    current: { observation: readFailed ? 'read-failed' : current ? 'observed' : 'not-read', ...(current ? { outcome: current.outcome, issues: current.issues.map(failure) } : {}) },
    ...(report?.agent ? { agent: { hostId: report.agent.hostId, agentSessionId: report.agent.agentSessionId, createOperationId: report.agent.createOperationId, runId: report.agent.runId } } : {}),
    ...(report?.execution ? { execution: { coordinatorRuntimeId: report.execution.coordinatorRuntimeId, reference: reference(report.execution.reference),
      ...(metadata ? { diagnostics: { sourceRuntimeId: metadata.sourceRuntimeId, reference: reference(metadata.reference), state: metadata.state,
        helpers: { executor: helper('executor'), frontend: helper('frontend') }, ...(metadata.failure ? { failure: { hostId: metadata.failure.hostId, role: metadata.failure.role,
          stage: metadata.failure.stage, code: metadata.failure.code, ...(metadata.failure.frame ? { frame: { startByte: metadata.failure.frame.startByte, endByte: metadata.failure.frame.endByte,
            bytes: metadata.failure.frame.bytes, sha256: metadata.failure.frame.sha256, syntax: metadata.failure.frame.syntax } } : {}) } } : {}) } } : {}),
      ...(report.execution.inspection ? { state: report.execution.inspection.state, ...(report.execution.inspection.helperStarts ? { helperStarts: { executor: { outcome: report.execution.inspection.helperStarts.executor.outcome, runId: report.execution.inspection.helperStarts.executor.runId }, frontend: { outcome: report.execution.inspection.helperStarts.frontend.outcome, runId: report.execution.inspection.helperStarts.frontend.runId } } } : {}) } : {}) } } : {}),
    cli: { command: 'space inspect', sourceHostId: input.target.hostId, sourceRuntimeId: input.target.reference.runtimeId, operationId: input.request.operationId } }
}
