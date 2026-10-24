import { AgentMuxError } from '@agentmux/core'
import { sameMotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { moteChatDiagnosisCode, moteChatDiagnosisKey, moteChatDiagnosisWindowLimit, moteChatInputFailureCode, moteChatPreparationReason,
  type MoteChatDiagnosis, type MoteChatTarget } from '@agentmux/core/mote-chat'
import { isDeepStrictEqual } from 'node:util'
import type { ConnectionHost } from './connection-host.js'
import type { DurableIngressHost } from './durable-ingress.js'
import type { MoteChatStore } from './mote-chat-store.js'

export type MoteChatDiagnosisOwner = {
  store: MoteChatStore
  connections: ConnectionHost
  assertTarget(target: MoteChatTarget): Promise<void>
  assertReady?(target: MoteChatTarget): Promise<void>
  ingress?(): Pick<DurableIngressHost, 'listDirect' | 'inspect'> | undefined
}
const safeCode = (error: unknown) => moteChatDiagnosisCode(error instanceof AgentMuxError ? error.code : undefined)

/** Read original local owners. Private DTOs and exception text never cross this diagnostic edge. */
export async function readMoteChatDiagnosis(target: MoteChatTarget, owner: MoteChatDiagnosisOwner): Promise<MoteChatDiagnosis> {
  const report: MoteChatDiagnosis = {
    targetKey: moteChatDiagnosisKey(target), limit: moteChatDiagnosisWindowLimit,
    configuration: null, readiness: { state: 'unavailable', code: null },
    service: null, adapterService: null, connection: null, incoming: null, issues: []
  }
  let configuration: ReturnType<MoteChatStore['configuration']> = null
  try {
    configuration = owner.store.configuration(target.spaceId)
    if (configuration && !sameMotePreferencesTarget(configuration.target, target)) {
      report.issues.push('target-changed'); configuration = null
    } else if (configuration) {
      report.configuration = { revision: configuration.revision, enabled: configuration.values.enabled, connection: configuration.values.connection }
    }
  } catch { report.issues.push('configuration-unavailable') }
  try {
    await owner.assertTarget(target)
    if (!configuration) {
      if (!report.issues.length) report.readiness = { state: 'not-configured', code: null }
    } else if (owner.assertReady) {
      await owner.assertReady(target)
      report.readiness = { state: 'ready', code: null }
    }
  } catch (error) { report.readiness = { state: 'unavailable', code: safeCode(error) } }
  try {
    const value = await owner.connections.service.get()
    report.service = { enabled: value.enabled, revision: value.revision }
  } catch { report.issues.push('service-unavailable') }
  const ref = configuration?.values.connection
  if (!ref) return report
  try {
    const value = (await owner.connections.inspect({ connectionId: ref.connectionId })).connection
    if (!value || !isDeepStrictEqual(value.config.application, ref.application)) report.issues.push('connection-unavailable')
    else {
      report.connection = { enabled: value.config.enabled, revision: value.revision,
        authentication: value.observation.authentication, transport: value.observation.transport,
        intake: value.observation.intake, delivery: value.observation.delivery }
      try {
        const policy = await owner.connections.service.get({ adapterId: value.config.adapterId })
        report.adapterService = { enabled: policy.enabled, revision: policy.revision }
      } catch { if (!report.issues.includes('service-unavailable')) report.issues.push('service-unavailable') }
    }
  } catch { report.issues.push('connection-unavailable') }
  const ingress = owner.ingress?.()
  if (!ingress) { report.issues.push('intake-unavailable'); return report }
  try {
    const page = ingress.listDirect(ref.application, moteChatDiagnosisWindowLimit)
    const rows: NonNullable<MoteChatDiagnosis['incoming']>['rows'] = []
    for (const record of page.ingresses) {
      let preparation: NonNullable<MoteChatDiagnosis['incoming']>['rows'][number]['preparation'] = 'not-admitted'
      const admission = owner.store.admissionByIngress(record.ingressId)
      if (admission) {
        const generation = owner.store.generation(admission.generationId)
        if (!generation) throw new AgentMuxError('The original private-chat preparation cannot be observed.', 'MOTE_CHAT_STORAGE_UNCONFIRMED')
        if (!sameMotePreferencesTarget(generation.generation.target, target)) preparation = 'other-route'
        else preparation = generation.binding ? 'ready' : generation.dispatched ? 'creation-dispatched' : generation.prepared ? 'prepared' : 'reserved'
      }
      let input: NonNullable<MoteChatDiagnosis['incoming']>['rows'][number]['input'] = {
        status: null, observation: record.input ? 'unavailable' : 'not-started',
        controlState: null, receiptObservation: null, waiting: null, preparationReason: null, failureCode: null
      }
      if (record.input && preparation !== 'other-route') {
        try {
          const observed = await ingress.inspect({ ingressId: record.ingressId })
          if (observed.ingress?.ingressId === record.ingressId && isDeepStrictEqual(observed.ingress.input, record.input)) {
            const receipt = observed.inputReceipt, waiting = receipt?.control.waiting
            input = { status: receipt?.status ?? null, observation: observed.observation,
              controlState: receipt?.control.state ?? null, receiptObservation: receipt?.observation ?? null,
              waiting: waiting ? { phase: waiting.phase, reason: waiting.reason, wake: waiting.wake } : null,
              preparationReason: receipt ? moteChatPreparationReason(receipt) : null,
              failureCode: receipt ? moteChatInputFailureCode(receipt) : null }
          }
        } catch { /* The original saved input remains visible without claiming its Core outcome. */ }
      }
      rows.push({ key: moteChatDiagnosisKey(target, record.ingressId), state: record.state,
        code: moteChatDiagnosisCode(record.code), codeRecorded: record.code !== undefined, preparation, input })
    }
    report.incoming = { rows, more: page.more }
  } catch { report.issues.push('intake-unavailable') }
  return report
}
