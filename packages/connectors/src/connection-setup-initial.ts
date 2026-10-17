import { connectionSetupDecisionForAction, CONNECTION_SETUP_READ_ACTIONS, type ConnectionEnrollmentCallContext, type ConnectionSetupAction, type ConnectionSetupAdvance, type ConnectionSetupConfigurationReceipt, type ConnectionSetupInitialProgress, type ConnectionSetupInspect, type ConnectionSetupPort, type ConnectionSetupPublicationDraft, type ConnectionSetupReadSubject, type ConnectionSetupView } from '@agentmux/core/connections'

type Selector = NonNullable<ConnectionSetupInspect['applicationConfiguration']>
type Stage = ConnectionSetupInitialProgress['stage']
type Port = Pick<ConnectionSetupPort, 'inspect' | 'advance'>
type Configuration = NonNullable<ConnectionSetupView['applicationConfiguration']>
const selectedState = (configuration: Configuration): ConnectionSetupInitialProgress['state'] | null => {
  const receipt = configuration.selected
  if (receipt?.request === 'dispatching') return 'running'
  if (configuration.unresolved || receipt && (receipt.request !== 'confirmed' || receipt.secureStorage !== 'stored')) return 'attention'
  return null
}
const stages: Array<{ stage: Stage; selector: Selector; reads: ConnectionSetupReadSubject[] }> = [
  { stage: 'messaging', selector: { effect: 'enable-messaging' }, reads: ['bot-settings'] },
  { stage: 'event-transport', selector: { effect: 'use-persistent-connection' }, reads: ['event-settings'] },
  { stage: 'permissions', selector: { effect: 'add-application-permissions', purpose: 'agent-conversation' }, reads: ['permission-catalog', 'application-permissions'] },
  { stage: 'message-reception', selector: { effect: 'add-message-reception' }, reads: ['event-catalog', 'event-settings'] },
  { stage: 'callback-transport', selector: { effect: 'use-persistent-callback' }, reads: ['callback-settings'] },
  { stage: 'card-actions', selector: { effect: 'add-card-actions' }, reads: ['callback-settings'] }
]

/** One finite creation flow over the existing Setup owner. All facts remain in its original child journals. */
export class InitialConnectionSetup {
  constructor(private readonly port: Port, private readonly draft: (view: ConnectionSetupView) => Promise<Extract<ConnectionSetupPublicationDraft, { kind: 'create-version' }> | null>, private readonly originalEffect: (operationId: string) => ConnectionSetupConfigurationReceipt | null) {}
  private async advance(operationId: string, action: ConnectionSetupAction, context: ConnectionEnrollmentCallContext, extra: Partial<ConnectionSetupAdvance> = {}): Promise<ConnectionSetupView> {
    return this.port.advance({ operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: connectionSetupDecisionForAction(action) }, ...extra }, context)
  }
  private async read(operationId: string, subject: ConnectionSetupReadSubject, context: ConnectionEnrollmentCallContext, versionId?: string): Promise<boolean> {
    const view = await this.port.inspect({ operationId, applicationInspection: { ...(versionId ? { versionId } : {}) } }, context)
    const kind = subject === 'publication-version' ? 'read-publication-version' : CONNECTION_SETUP_READ_ACTIONS[subject]
    const action = view.applicationInspection?.actions.find(action => action.kind === kind && (action.kind !== 'read-publication-version' || action.versionId === versionId))
    if (!action) return false
    const result = await this.advance(operationId, action, context, versionId ? { versionId } : {})
    return result.applicationInspection?.selected?.request === 'confirmed' && result.applicationInspection.selected.secureStorage === 'stored'
  }
  private config(operationId: string, selector: Selector, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    return this.port.inspect({ operationId, applicationConfiguration: selector }, context)
  }
  private async readState(operationId: string, subjects: ConnectionSetupReadSubject[], context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupInitialProgress['state'] | null> {
    const view = await this.port.inspect({ operationId, applicationInspection: { limit: 100 } }, context)
    for (const subject of subjects) {
      const receipt = view.applicationInspection?.observations.find(receipt => receipt.subject === subject)
      if (receipt?.request === 'dispatching') return 'running'
      if (receipt && (receipt.request !== 'confirmed' || receipt.secureStorage !== 'stored')) return 'attention'
    }
    return null
  }
  private async configure(operationId: string, selector: Selector, reads: ConnectionSetupReadSubject[], context: ConnectionEnrollmentCallContext, run: boolean): Promise<ConnectionSetupInitialProgress['state'] | null> {
    let view = await this.config(operationId, selector, context), configuration = view.applicationConfiguration
    if (!configuration) return 'attention'
    let stopped = selectedState(configuration)
    if (stopped) return stopped
    if (configuration.capability === 'enabled') return null
    if (!run) return await this.readState(operationId, reads, context) ?? (configuration.reason === 'adapter-unavailable' || configuration.capability === 'unknown' && this.hasSources(configuration) ? 'attention' : 'pending')
    // Reads obtain new observations, never repair or replay an unconfirmed effect.
    for (const subject of reads) if (!await this.read(operationId, subject, context)) return 'attention'
    view = await this.config(operationId, selector, context); configuration = view.applicationConfiguration
    if (!configuration) return 'attention'
    stopped = selectedState(configuration)
    if (stopped) return stopped
    if (configuration.capability === 'enabled') return null
    const action = configuration.actions.find(action => action.kind === selector.effect)
    if (!action) return 'attention'
    const result = await this.advance(operationId, action, context)
    const receipt = result.applicationConfiguration?.selected
    if (!receipt || receipt.request !== 'confirmed' || receipt.secureStorage !== 'stored') return receipt?.request === 'dispatching' ? 'running' : 'attention'
    // A successful request is distinct from its current setting. Re-observe only its relevant subjects.
    for (const subject of reads) if (!await this.read(operationId, subject, context)) return 'attention'
    const current = (await this.config(operationId, selector, context)).applicationConfiguration
    return current?.capability === 'enabled' && !selectedState(current) ? null : 'attention'
  }
  private hasSources(configuration: Configuration): boolean {
    if ('source' in configuration) return configuration.source !== null
    return Object.values(configuration.sources).every(source => source !== null) && Object.keys(configuration.sources).length > 0
  }
  async view(operationId: string, context: ConnectionEnrollmentCallContext, run = false): Promise<ConnectionSetupView> {
    let base = await this.port.inspect({ operationId }, context)
    const input = base.operation?.initialPublication
    if (!input) return base
    const finish = async (stage: Stage, state: ConnectionSetupInitialProgress['state'], versionId?: string): Promise<ConnectionSetupView> => ({ ...await this.port.inspect({ operationId }, context), initialSetup: { stage, state, ...(versionId ? { versionId } : {}) } })
    if (run && base.continuation?.stage === 'account') {
      const confirm = base.continuation.actions.find(action => action.kind === 'confirm-account')
      if (confirm) base = await this.advance(operationId, confirm, context)
    }
    if (base.reason || base.continuation?.stage !== 'confirmed' || base.operation?.authentication?.request !== 'confirmed' || base.operation.authentication.secureStorage !== 'stored') return finish('authentication', base.operation?.authentication?.request === 'dispatching' ? 'running' : 'attention')
    if (!run) {
      // An admitted later writer can invalidate an earlier mode read while its own request or readback is pending.
      // Keep that exact original phase visible; an observation gap cannot move the request back to an earlier phase.
      const original = this.originalEffect(operationId), current = stages.find(item => item.selector.effect === original?.effect)
      if (current) {
        const state = await this.configure(operationId, current.selector, current.reads, context, false)
        if (state) return finish(current.stage, state)
      }
    }
    for (const item of stages) {
      if (base.operation.goal.kind !== 'agent-conversation' || base.operation.goal.interaction !== 'cards' && (item.stage === 'callback-transport' || item.stage === 'card-actions')) continue
      const state = await this.configure(operationId, item.selector, item.reads, context, run)
      if (state) return finish(item.stage, state)
    }
    const draft = await this.draft(base)
    if (!draft || draft.visibility !== 'creator-only' || draft.version !== input.version || draft.notes !== input.notes) return finish('publication-create', 'attention')
    let create = (await this.config(operationId, { effect: 'create-application-version', draft }, context)).applicationConfiguration
    if (!create || create.effect !== 'create-application-version') return finish('publication-create', 'attention')
    const createStopped = selectedState(create)
    if (createStopped) return finish('publication-create', createStopped)
    if (!create.selected) {
      if (!run) return finish('publication-create', await this.readState(operationId, ['publication-versions'], context) ?? (create.review?.versions.length ? 'attention' : 'pending'))
      if (!await this.read(operationId, 'publication-versions', context)) return finish('publication-create', 'attention')
      create = (await this.config(operationId, { effect: 'create-application-version', draft }, context)).applicationConfiguration
      // This intent permits the first version only; it cannot publish an independently existing version.
      if (!create || create.effect !== 'create-application-version' || !create.review || create.review.versions.length || create.requiredSubjects.some(subject => subject !== 'publication-versions')) return finish('publication-create', 'attention')
      const action = create.actions.find(action => action.kind === 'create-application-version')
      if (!action) return finish('publication-create', 'attention')
      create = (await this.advance(operationId, action, context, { publicationDraft: draft })).applicationConfiguration
    }
    if (!create || create.effect !== 'create-application-version' || !create.selected || create.selected.effect !== 'create-application-version' || selectedState(create) || !create.selected.versionId) return finish('publication-create', create ? selectedState(create) ?? 'attention' : 'attention')
    const versionId = create.selected.versionId, submitDraft = { kind: 'submit-version' as const, versionId, fullRelease: false }
    let submit = (await this.config(operationId, { effect: 'submit-application-version', draft: submitDraft }, context)).applicationConfiguration
    if (!submit || submit.effect !== 'submit-application-version') return finish('publication-submit', 'attention', versionId)
    // Once the request is confirmed, an optional business summary may still be unknown. An exact version read remains independent.
    const submitReceipt = submit.selected
    if (submitReceipt && (submitReceipt.request !== 'confirmed' || submitReceipt.secureStorage !== 'stored')) return finish('publication-submit', submitReceipt.request === 'dispatching' ? 'running' : 'attention', versionId)
    if (!submitReceipt) {
      if (submit.unresolved) return finish('publication-submit', 'attention', versionId)
      if (!run) return finish('publication-submit', await this.readState(operationId, ['publication-version'], context) ?? 'pending', versionId)
      if (!await this.read(operationId, 'publication-version', context, versionId)) return finish('publication-submit', 'attention', versionId)
      submit = (await this.config(operationId, { effect: 'submit-application-version', draft: submitDraft }, context)).applicationConfiguration
      const action = submit?.actions.find(action => action.kind === 'submit-application-version')
      if (!action) return finish('publication-submit', 'attention', versionId)
      const result = await this.advance(operationId, action, context, { publicationDraft: submitDraft })
      const receipt = result.applicationConfiguration?.selected
      if (!receipt || receipt.request !== 'confirmed' || receipt.secureStorage !== 'stored') return finish('publication-submit', receipt?.request === 'dispatching' ? 'running' : 'attention', versionId)
    }
    if (run && !await this.read(operationId, 'publication-version', context, versionId)) return finish('publication-status', 'attention', versionId)
    const inspected = await this.port.inspect({ operationId, applicationInspection: { versionId, limit: 100 } }, context)
    const observation = inspected.applicationInspection?.observations.find(receipt => receipt.subject === 'publication-version' && receipt.versionId === versionId)
    if (!observation) return finish('publication-status', 'pending', versionId)
    const statusView = await this.port.inspect({ operationId, applicationInspection: { selectedStepId: observation.stepId, versionId } }, context)
    const status = statusView.applicationInspection?.readResult
    if (observation.request !== 'confirmed' || observation.secureStorage !== 'stored' || status?.subject !== 'publication-version' || status.versionId !== versionId) return finish('publication-status', 'attention', versionId)
    return finish('publication-status', status.status === 'approved' ? 'complete' : status.status === 'reviewing' || status.status === 'awaiting-release' ? 'approval-required' : 'attention', versionId)
  }
}
