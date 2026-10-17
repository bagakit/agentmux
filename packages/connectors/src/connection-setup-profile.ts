import { createHash } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import {
  CONNECTION_SETUP_READ_ACTIONS,
  connectionSetupDecisionForAction,
  connectionSetupGoalSummary,
  connectionSetupPublicationSubjects,
  parseConnectionSetupParams,
  type ConnectionEnrollmentCallContext,
  type ConnectionSetupAdvance,
  type ConnectionSetupBegin,
  type ConnectionSetupConfigurationAction,
  type ConnectionSetupInspect,
  type ConnectionSetupOperation,
  type ConnectionSetupPort,
  type ConnectionSetupProfileDesired,
  type ConnectionSetupProfileProgress,
  type ConnectionSetupPublicationDraft,
  type ConnectionSetupReadSubject,
  type ConnectionSetupView
} from '@agentmux/core/connections'
import type { EnrollmentSecrets } from './connection-enrollment-adapter.js'
type Row = {
  operation: ConnectionSetupOperation
  actor: ConnectionEnrollmentCallContext['actor']
  privateRef: string | null
}
type Port = Pick<ConnectionSetupPort, 'inspect' | 'advance'>
type Stage = ConnectionSetupProfileProgress['stage']
type State = ConnectionSetupProfileProgress['state']
type ProgressAction = 'continue-profile-update' | 'refresh-publication-checks'
type Draft = Extract<
  ConnectionSetupPublicationDraft,
  {
    kind: 'create-version'
  }
>
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const stopped = (view: ConnectionSetupView) => {
  const c = view.applicationConfiguration,
    r = c?.selected
  return r?.request === 'dispatching'
    ? ('running' as const)
    : c?.reason === 'original-effect-unconfirmed' ||
        c?.unresolved ||
        (r && (r.request !== 'confirmed' || r.secureStorage !== 'stored'))
      ? ('attention' as const)
      : null
}
/** A finite existing-application goal over the original Setup owner and its child journals. */
export class ProfileConnectionSetup {
  private readonly running = new Map<string, Promise<ConnectionSetupView>>()
  constructor(
    private readonly port: Port,
    private readonly secrets: EnrollmentSecrets | undefined,
    private readonly row: (id: string) => Row | null,
    private readonly draft: (id: string) => Promise<Draft | null>,
    private readonly readback: (id: string) => Promise<string | null>
  ) {}
  private inputKey(id: string) {
    return 'connection-setup-profile-input:' + id
  }
  async freeze(input: ConnectionSetupBegin, row: Row): Promise<boolean> {
    if (input.goal.kind !== 'profile-update' || !this.secrets) return false
    try {
      await this.secrets.assertAvailable()
      const key = this.inputKey(input.operationId)
      let saved = await this.secrets.inspect(key)
      if (!saved)
        saved = await this.secrets.store({
          operationId: key,
          secret: JSON.stringify({
            actor: row.actor,
            application: row.operation.application,
            input
          })
        })
      return Boolean(saved && (await this.input(row)))
    } catch {
      return false
    }
  }
  async input(row: Row): Promise<ConnectionSetupProfileDesired | null> {
    if (!this.secrets || row.operation.goal.kind !== 'profile-update')
      return null
    try {
      const saved = await this.secrets.inspect(
        this.inputKey(row.operation.operationId)
      )
      if (!saved) return null
      const data = JSON.parse(
        (await this.secrets.resolve(saved.credentialRef)) ?? 'null'
      )
      const input = parseConnectionSetupParams(
        'connection.setup.begin',
        data?.input
      )
      if (
        input.goal.kind !== 'profile-update' ||
        !same(data.actor, row.actor) ||
        !same(data.application, row.operation.application) ||
        input.operationId !== row.operation.operationId ||
        input.connectionId !== row.operation.connectionId ||
        input.expectedConnectionRevision !==
          row.operation.expectedConnectionRevision ||
        !same(connectionSetupGoalSummary(input.goal), row.operation.goal)
      )
        return null
      return input.goal.desired
    } catch {
      return null
    }
  }
  private action(row: Row, revision = row.operation.revision, kind: ProgressAction = 'continue-profile-update') {
    return {
      kind,
      expectedRevision: revision,
      actionId:
        (kind === 'refresh-publication-checks' ? 'setup-profile-refresh:' : 'setup-profile-continue:') +
        hash({
          operationId: row.operation.operationId,
          goal: row.operation.goal,
          actor: row.actor,
          revision
        })
    }
  }
  async advance(
    input: ConnectionSetupAdvance,
    context: ConnectionEnrollmentCallContext
  ): Promise<ConnectionSetupView | null> {
    const kind: ProgressAction | null = input.decision.actionId.startsWith('setup-profile-refresh:') ? 'refresh-publication-checks' : input.decision.actionId.startsWith('setup-profile-continue:') ? 'continue-profile-update' : null
    if (!kind) return null
    const row = this.row(input.operationId)
    if (
      !row ||
      row.operation.goal.kind !== 'profile-update' ||
      input.decision.value !== 'continue' ||
      input.publicationDraft !== undefined ||
      input.versionId !== undefined ||
      this.action(row, input.expectedRevision, kind).actionId !==
        input.decision.actionId ||
      input.expectedRevision > row.operation.revision
    )
      throw new AgentMuxError(
        'This continuation does not name the original profile goal.',
        'CONNECTION_SETUP_ACTION_STALE'
      )
    const pending = this.running.get(input.decision.actionId)
    if (pending) {
      await pending
      return this.view(input.operationId, context)
    }
    if (input.expectedRevision < row.operation.revision)
      return this.view(input.operationId, context)
    const current = await this.view(input.operationId, context)
    if (
      !current.profileUpdate?.actions.some(
        (a) =>
          a.kind === kind &&
          a.actionId === input.decision.actionId
      )
    )
      throw new AgentMuxError(
        'This original profile step has no offered continuation.',
        'CONNECTION_SETUP_ACTION_STALE'
      )
    const work = kind === 'refresh-publication-checks' ? this.refresh(input.operationId, context) : this.view(input.operationId, context, true)
    this.running.set(input.decision.actionId, work)
    try {
      return await work
    } finally {
      this.running.delete(input.decision.actionId)
    }
  }
  private async refresh(id: string, context: ConnectionEnrollmentCallContext): Promise<ConnectionSetupView> {
    let failed = false
    for (const subject of connectionSetupPublicationSubjects('create-application-version')) {
      if (!(await this.read(id, subject, context))) { failed = true; break }
    }
    const view = await this.view(id, context)
    return failed && view.profileUpdate?.stage === 'publication-create'
      ? { ...view, profileUpdate: { ...view.profileUpdate, state: 'attention' } }
      : view
  }
  private config(
    id: string,
    selector: NonNullable<ConnectionSetupInspect['applicationConfiguration']>,
    context: ConnectionEnrollmentCallContext
  ) {
    return this.port.inspect(
      { operationId: id, applicationConfiguration: selector },
      context
    )
  }
  private async perform(
    id: string,
    action: ConnectionSetupConfigurationAction,
    context: ConnectionEnrollmentCallContext,
    draft?: ConnectionSetupPublicationDraft
  ) {
    return this.port.advance(
      {
        operationId: id,
        expectedRevision: action.expectedRevision,
        decision: {
          actionId: action.actionId,
          value: connectionSetupDecisionForAction(action)
        },
        ...(draft ? { publicationDraft: draft } : {})
      },
      context
    )
  }
  private async read(
    id: string,
    subject: ConnectionSetupReadSubject,
    context: ConnectionEnrollmentCallContext,
    versionId?: string
  ) {
    const view = await this.port.inspect(
      {
        operationId: id,
        applicationInspection: { ...(versionId ? { versionId } : {}) }
      },
      context
    )
    const kind =
      subject === 'publication-version'
        ? 'read-publication-version'
        : CONNECTION_SETUP_READ_ACTIONS[subject]
    const action = view.applicationInspection?.actions.find(
      (a) =>
        a.kind === kind &&
        (a.kind !== 'read-publication-version' || a.versionId === versionId)
    )
    if (!action) return false
    const result = await this.port.advance(
      {
        operationId: id,
        expectedRevision: action.expectedRevision,
        decision: { actionId: action.actionId, value: 'continue' },
        ...(versionId ? { versionId } : {})
      },
      context
    )
    return (
      result.applicationInspection?.selected?.request === 'confirmed' &&
      result.applicationInspection.selected.secureStorage === 'stored'
    )
  }
  private async readState(
    id: string,
    subject: ConnectionSetupReadSubject,
    context: ConnectionEnrollmentCallContext
  ): Promise<State> {
    const view = await this.port.inspect(
      { operationId: id, applicationInspection: { limit: 100 } },
      context
    )
    const receipt = view.applicationInspection?.observations.find(
      (r) => r.subject === subject
    )
    return receipt?.request === 'dispatching'
      ? 'running'
      : receipt &&
          (receipt.request !== 'confirmed' ||
            receipt.secureStorage !== 'stored')
        ? 'attention'
        : 'pending'
  }
  async view(
    id: string,
    context: ConnectionEnrollmentCallContext,
    run = false,
    includePublication = false
  ): Promise<ConnectionSetupView> {
    const base = await this.port.inspect({ operationId: id }, context),
      row = this.row(id)
    if (!row || row.operation.goal.kind !== 'profile-update') return base
    const finish = async (
      stage: Stage,
      state: State,
      versionId?: string,
      child?: ConnectionSetupView,
      draft?: Draft,
      action: ProgressAction = 'continue-profile-update'
    ): Promise<ConnectionSetupView> => {
      const configuration = child?.applicationConfiguration,
        fresh = configuration ? { ...child! } : await this.port.inspect({ operationId: id }, context),
        current = { ...this.row(id)!, operation: fresh.operation! }
      // Keep the checked configuration and its envelope in the same observed revision.
      delete fresh.applicationConfiguration
      delete fresh.receipt
      const actions: ConnectionSetupProfileProgress['actions'] = []
      if (configuration) {
        const recover = configuration.actions.find(
          (a) => a.kind === 'recover-configuration-effect'
        )
        if (recover)
          actions.push({ ...recover, kind: 'recover-configuration-effect' })
      }
      if (
        !actions.length &&
        fresh.continuation?.stage === 'confirmed' &&
        state !== 'running' &&
        state !== 'complete' &&
        configuration?.reason !== 'original-effect-unconfirmed' &&
        !configuration?.unresolved &&
        (!configuration?.selected ||
          (configuration.selected.request === 'confirmed' &&
            configuration.selected.secureStorage === 'stored')) &&
        (action === 'refresh-publication-checks' || !draft)
      )
        actions.push(this.action(current, current.operation.revision, action))
      return {
        ...fresh,
        ...(includePublication && stage === 'publication-create' && configuration ? { applicationConfiguration: configuration } : {}),
        profileUpdate: {
          stage,
          state,
          actions,
          ...(versionId ? { versionId } : {}),
          ...(configuration?.unresolvedProfile
            ? {
                blockedBy: {
                  kind: 'profile-operation' as const,
                  ...configuration.unresolvedProfile
                }
              }
            : {}),
          ...(draft ? { publicationDraft: draft } : {})
        }
      }
    }
    if (base.reason || base.continuation?.stage !== 'confirmed' || base.operation?.authentication?.request !== 'confirmed' || base.operation.authentication.secureStorage !== 'stored') {
      const request = base.operation?.authentication?.request ?? base.operation?.request.state
      const storage = base.operation?.authentication?.secureStorage ?? base.operation?.secureStorage
      const stage = base.continuation?.stage
      const state = request === 'dispatching' || request === 'confirmed' && storage === 'storing' && base.challengeSource ? 'running' : request === 'confirmed' && storage === 'stored' && !base.reason
        ? stage === 'handoff' ? 'running' : stage === 'waiting' || stage === 'scanned' || stage === 'account' ? 'pending' : 'attention'
        : 'attention'
      return finish('authentication', state)
    }
    if (!(await this.input(row)))
      return {
        ...base,
        profileUpdate: {
          stage: 'profile-preflight',
          state: 'attention',
          actions: []
        }
      }
    let upload = await this.config(
        id,
        { effect: 'upload-profile-avatar' },
        context
      ),
      write = await this.config(
        id,
        { effect: 'update-application-profile' },
        context
      )
    if (stopped(write))
      return finish('profile-write', stopped(write)!, undefined, write)
    if (row.operation.goal.desired.avatarSha256 && stopped(upload))
      return finish('avatar-upload', stopped(upload)!, undefined, upload)
    let readback = await this.readback(id)
    if (!readback && !write.applicationConfiguration?.selected) {
      if (run) {
        if (!(await this.read(id, 'application-details', context)))
          return finish('profile-preflight', 'attention')
      } else if (
        !write.applicationConfiguration ||
        !('source' in write.applicationConfiguration) ||
        !write.applicationConfiguration.source
      ) {
        return finish(
          'profile-preflight',
          await this.readState(id, 'application-details', context)
        )
      }
      upload = await this.config(
        id,
        { effect: 'upload-profile-avatar' },
        context
      )
      if (upload.applicationConfiguration?.capability === 'unknown')
        return finish('profile-preflight', 'attention', undefined, upload)
      if (
        row.operation.goal.desired.avatarSha256 &&
        upload.applicationConfiguration?.capability !== 'enabled'
      ) {
        if (!run) return finish('avatar-upload', 'pending', undefined, upload)
        const action = upload.applicationConfiguration?.actions.find(
          (a) => a.kind === 'upload-profile-avatar'
        )
        if (!action)
          return finish('avatar-upload', 'attention', undefined, upload)
        upload = await this.perform(id, action, context)
        if (row.operation.goal.desired.avatarSha256 && stopped(upload))
          return finish('avatar-upload', stopped(upload)!, undefined, upload)
      }
      write = await this.config(
        id,
        { effect: 'update-application-profile' },
        context
      )
      if (write.applicationConfiguration?.capability !== 'enabled') {
        if (!run)
          return finish(
            'profile-write',
            write.applicationConfiguration?.capability === 'unknown' ? 'attention' : 'pending',
            undefined,
            write
          )
        const action = write.applicationConfiguration?.actions.find(
          (a) => a.kind === 'update-application-profile'
        )
        if (!action)
          return finish('profile-write', 'attention', undefined, write)
        write = await this.perform(id, action, context)
        if (stopped(write))
          return finish('profile-write', stopped(write)!, undefined, write)
      }
    }
    if (!readback) {
      if (!run)
        return finish(
          'profile-readback',
          await this.readState(id, 'application-details', context)
        )
      if (!(await this.read(id, 'application-details', context)))
        return finish('profile-readback', 'attention')
      readback = await this.readback(id)
      if (!readback) return finish('profile-readback', 'attention')
    }
    // Publication changes are re-read after base_info; only its actual original version can be submitted.
    let draft = await this.draft(id)
    let create = await this.config(
      id,
      { effect: 'create-application-version', ...(draft ? { draft } : {}) },
      context
    )
    if (stopped(create))
      return finish('publication-create', stopped(create)!, undefined, create)
    const missingSources = () => {
      const configuration = create.applicationConfiguration
      return configuration?.effect === 'create-application-version'
        ? configuration.requiredSubjects.filter(subject => !Object.values(configuration.sources).some(source => source?.subject === subject))
        : [...connectionSetupPublicationSubjects('create-application-version')]
    }
    if (!create.applicationConfiguration?.selected && run) {
      for (const subject of missingSources())
        if (!(await this.read(id, subject, context)))
          return finish('publication-create', 'attention')
      draft = await this.draft(id)
      create = await this.config(
        id,
        { effect: 'create-application-version', ...(draft ? { draft } : {}) },
        context
      )
    }
    if (stopped(create))
      return finish('publication-create', stopped(create)!, undefined, create)
    if (!create.applicationConfiguration?.selected && missingSources().length)
      return finish('publication-create', 'pending', undefined, create)
    if (!draft || !create.applicationConfiguration)
      return finish('publication-create', 'attention', undefined, create, undefined, 'refresh-publication-checks')
    if (!create.applicationConfiguration.selected) {
      // The profile goal alone cannot authorize unrelated pending application changes.
      if (
        create.applicationConfiguration.effect !==
          'create-application-version' ||
        create.applicationConfiguration.review?.changes.length
      )
        return finish(
          'publication-create',
          'attention',
          undefined,
          create,
          draft,
          'refresh-publication-checks'
        )
      const action = create.applicationConfiguration.actions.find(
        (a) => a.kind === 'create-application-version'
      )
      if (!action)
        return finish('publication-create', 'attention', undefined, create, draft, 'refresh-publication-checks')
      if (!run)
        return finish(
          'publication-create',
          create.applicationConfiguration.capability === 'unknown' ||
          create.applicationConfiguration.review?.issues.length ? 'attention' : 'pending',
          undefined,
          create
        )
      create = await this.perform(id, action, context, draft)
    }
    const created = create.applicationConfiguration?.selected
    if (
      !created ||
      created.effect !== 'create-application-version' ||
      created.request !== 'confirmed' ||
      created.secureStorage !== 'stored' ||
      !created.versionId
    )
      return finish(
        'publication-create',
        stopped(create) ?? 'attention',
        undefined,
        create
      )
    const versionId = created.versionId,
      submitDraft = {
        kind: 'submit-version' as const,
        versionId,
        fullRelease: false
      }
    let submit = await this.config(
      id,
      { effect: 'submit-application-version', draft: submitDraft },
      context
    )
    if (stopped(submit))
      return finish('publication-submit', stopped(submit)!, versionId, submit)
    if (!submit.applicationConfiguration?.selected) {
      if (!run) return finish('publication-submit', 'pending', versionId)
      for (const subject of [
        'publication-version',
        'publication-versions',
        'publication-features'
      ] as const)
        if (
          !(await this.read(
            id,
            subject,
            context,
            subject === 'publication-version' ? versionId : undefined
          ))
        )
          return finish('publication-submit', 'attention', versionId)
      submit = await this.config(
        id,
        { effect: 'submit-application-version', draft: submitDraft },
        context
      )
      const action = submit.applicationConfiguration?.actions.find(
        (a) => a.kind === 'submit-application-version'
      )
      if (!action)
        return finish('publication-submit', 'attention', versionId, submit)
      submit = await this.perform(id, action, context, submitDraft)
      if (stopped(submit))
        return finish('publication-submit', stopped(submit)!, versionId, submit)
    }
    if (
      run &&
      !(await this.read(id, 'publication-version', context, versionId))
    )
      return finish('publication-status', 'attention', versionId)
    const status = await this.port.inspect(
      { operationId: id, applicationInspection: { versionId, limit: 100 } },
      context
    )
    const original = status.applicationInspection?.observations.find(
      (r) => r.subject === 'publication-version' && r.versionId === versionId
    )
    if (!original) return finish('publication-status', 'pending', versionId)
    const result = await this.port.inspect(
        {
          operationId: id,
          applicationInspection: { versionId, selectedStepId: original.stepId }
        },
        context
      ),
      observed = result.applicationInspection?.readResult
    if (
      original.request !== 'confirmed' ||
      original.secureStorage !== 'stored' ||
      observed?.subject !== 'publication-version' ||
      observed.versionId !== versionId
    )
      return finish(
        'publication-status',
        original.request === 'dispatching' ? 'running' : 'attention',
        versionId
      )
    return finish(
      'publication-status',
      observed.status === 'approved'
        ? 'complete'
        : observed.status === 'reviewing' ||
            observed.status === 'awaiting-release'
          ? 'approval-required'
          : 'attention',
      versionId
    )
  }
}
