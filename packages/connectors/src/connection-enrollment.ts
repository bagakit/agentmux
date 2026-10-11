import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import {
  parseConnectionParams,
  parseConnectionResult,
  parseConnectionEnrollmentAccount,
  parseConnectionEnrollmentChallenge,
  parseConnectionEnrollmentDiagnostic,
  parseConnectionEnrollmentOperation,
  parseConnectionEnrollmentParams,
  parseConnectionEnrollmentPreset,
  parseConnectionEnrollmentView,
  summarizeConnectionEnrollmentPreset,
  type ConnectionEnrollmentAction,
  type ConnectionEnrollmentActionKind,
  type ConnectionEnrollmentAdvanceInput,
  type ConnectionEnrollmentBeginInput,
  type ConnectionEnrollmentCallContext,
  type ConnectionEnrollmentCapability,
  type ConnectionEnrollmentDiagnostic,
  type ConnectionEnrollmentListInput,
  type ConnectionEnrollmentOperation,
  type ConnectionEnrollmentOperationInput,
  type ConnectionEnrollmentPort,
  type ConnectionEnrollmentReceipt,
  type ConnectionEnrollmentView,
  type ConnectionSetupEnrollmentSource,
  type ConnectionApplication,
  type ConnectionSetupAccount
} from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import type {
  ConnectionEnrollmentAdapter,
  EnrollmentAdapterInput,
  EnrollmentAuthenticationReceipt,
  EnrollmentCreateReceipt,
  EnrollmentCredentialReceipt,
  EnrollmentSecrets,
  EnrollmentUploadReceipt
} from './connection-enrollment-adapter.js'
import {
  ConnectionEnrollmentStore,
  enrollmentDigest,
  sameEnrollmentActor,
  type EnrollmentRow,
  type EnrollmentStep
} from './connection-enrollment-store.js'
type Receipt =
  | EnrollmentAuthenticationReceipt
  | EnrollmentUploadReceipt
  | EnrollmentCreateReceipt
  | EnrollmentCredentialReceipt
type KnownReceipt = Exclude<
  Receipt,
  {
    kind: 'unknown'
  }
>
type Snapshot = {
  operationId: string
  connectionId: string
  actor: EnrollmentRow['actor']
  authAttemptId: string
  attemptId: string
  kind: EnrollmentStep
  privateState: string
  challenge: ConnectionEnrollmentView['challenge']
  account: ConnectionEnrollmentView['account']
  receipt: KnownReceipt
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const accountDigest = (account: NonNullable<Snapshot['account']>) =>
  enrollmentDigest({ userId: account.userId, tenantId: account.tenantId })
export type EnrollmentSetupSnapshot = { privateState: string; account: ConnectionSetupAccount; authAttemptId: string; assertCurrent(): void }
const issue = (code: string) =>
  new AgentMuxError(
    'Read the same original enrollment and choose its current action; existing connections remain available.',
    code
  )
/** Original enrollment intent, encrypted handoff and finite native calls; no scheduler or second workflow owner. */
export class ConnectionEnrollmentHost implements ConnectionEnrollmentPort {
  private readonly store: ConnectionEnrollmentStore
  private readonly pending = new Map<string, Promise<void>>()
  private readonly owner = randomUUID()
  private readonly unsettled = new Map<string, Snapshot>()
  private closed = false
  constructor(
    private readonly options: {
      connections: ConnectionHost
      secrets?: EnrollmentSecrets
    }
  ) {
    this.store = new ConnectionEnrollmentStore(options.connections)
  }
  close(): void {
    this.closed = true
    this.unsettled.clear()
  }
  private current(): void {
    if (this.closed) throw issue('CONNECTION_ENROLLMENT_UNAVAILABLE')
  }
  private async authority(
    row: EnrollmentRow | null,
    context: ConnectionEnrollmentCallContext
  ): Promise<void> {
    this.current()
    if (
      !context.actor ||
      !['user', 'device'].includes(context.actor.kind) ||
      !context.actor.id ||
      (row && !sameEnrollmentActor(row.actor, context.actor))
    )
      throw issue('CONTROL_PERMISSION_DENIED')
    context.signal?.throwIfAborted()
    await context.assertCurrent?.()
    this.current()
    context.signal?.throwIfAborted()
  }
  private async secure(): Promise<EnrollmentSecrets> {
    const s = this.options.secrets
    if (!s) throw issue('CONNECTION_CREDENTIAL_UNAVAILABLE')
    await s.assertAvailable()
    return s
  }
  private adapter(row: EnrollmentRow): ConnectionEnrollmentAdapter | undefined {
    const a = this.options.connections.registeredAdapter(row.operation.adapterId)?.enrollment
    return a?.domains.some((d) => d.domain === row.operation.domain) ? a : undefined
  }
  async list(value: ConnectionEnrollmentListInput) {
    this.current()
    const input = parseConnectionEnrollmentParams('connection.enrollment.ls', value)
    const available = !!this.options.secrets
    const capabilities: ConnectionEnrollmentCapability[] = this.options.connections
      .enrollmentAdapters()
      .flatMap((a) =>
        a.enrollment!.domains.map((d) => ({
          adapterId: a.adapterId,
          ...d,
          availability: available ? ('available' as const) : ('unavailable' as const),
          ...(available ? {} : { reason: 'secure-storage-unavailable' as const })
        }))
      )
    return { ...this.store.page(input.cursor, input.limit ?? 25), capabilities }
  }
  async inspect(
    value: ConnectionEnrollmentOperationInput,
    context: ConnectionEnrollmentCallContext
  ): Promise<ConnectionEnrollmentView> {
    const input = parseConnectionEnrollmentParams('connection.enrollment.inspect', value),
      row = this.store.read(input.operationId)
    await this.authority(row, context)
    return this.view(row, context)
  }
  private async join(id: string, work: () => Promise<void>): Promise<void> {
    const active = this.pending.get(id)
    if (active) return active
    const promise = work().finally(() => {
      if (this.pending.get(id) === promise) this.pending.delete(id)
    })
    this.pending.set(id, promise)
    return promise
  }
  private action(
    row: EnrollmentRow,
    kind: ConnectionEnrollmentActionKind
  ): ConnectionEnrollmentAction {
    return {
      actionId: row.operation.operationId + ':' + row.operation.revision + ':' + kind,
      ownRevision: row.operation.revision,
      kind
    }
  }
  private async view(
    row: EnrollmentRow | null,
    context: ConnectionEnrollmentCallContext,
    receipt?: ConnectionEnrollmentReceipt
  ): Promise<ConnectionEnrollmentView> {
    if (!row) return { operation: null, challenge: null, account: null, actions: [] }
    let snapshot: Snapshot | null = null,
      operation = row.operation
    if (row.version === 2 && row.privateRef) {
      try {
        snapshot = await this.privateSnapshot(row)
      } catch {
        operation = {
          ...operation,
          reason: 'secure-storage-unavailable',
          diagnostic: { stage: 'secure-storage', code: 'challenge-unconfirmed' }
        }
      }
    }
    await this.authority(row, context)
    const latest = this.store.read(row.operation.operationId)
    if (
      !latest ||
      latest.operation.revision !== row.operation.revision ||
      latest.operation.authentication?.attemptId !== row.operation.authentication?.attemptId
    ) {
      return parseConnectionEnrollmentView({
        operation: latest?.operation ?? null,
        challenge: null,
        account: null,
        actions:
          latest && latest.operation.configuration !== 'configured'
            ? [this.action(latest, 'recover-local')]
            : [],
        ...(receipt ? { receipt } : {})
      })
    }
    receipt ??= row.activeActionId
      ? this.store.readAction(row.operation.operationId, row.activeActionId)?.receipt
      : undefined
    const actions: ConnectionEnrollmentAction[] = [],
      auth = operation.authentication
    if (operation.configuration !== 'configured') {
      actions.push(this.action(row, 'recover-local'))
      if (row.version === 2 && (!this.store.claimed(row) || !!operation.application)) {
        if (
          auth?.stage === 'not-started' ||
          auth?.stage === 'unknown' ||
          auth?.stage === 'expired' ||
          (auth?.stage === 'confirmed' &&
            !!operation.application &&
            operation.credential !== 'stored')
        )
          actions.push(this.action(row, 'renew-authentication'))
        if (snapshot && auth && ['waiting', 'scanned', 'handoff'].includes(auth.stage))
          actions.push(this.action(row, 'continue-authentication'))
        if (snapshot?.account && auth?.stage === 'account')
          actions.push(this.action(row, 'confirm-account'))
        if (
          snapshot?.account &&
          auth?.stage === 'confirmed' &&
          row.confirmedAccountDigest === accountDigest(snapshot.account!)
        ) {
          if (
            !operation.application &&
            operation.creation?.create === 'not-started' &&
            operation.creation.upload !== 'unknown' &&
            (!row.creationAccountDigest || row.creationAccountDigest === row.confirmedAccountDigest)
          )
            actions.push(this.action(row, 'create'))
          if (
            operation.application &&
            operation.credential !== 'stored' &&
            row.creationAccountDigest === row.confirmedAccountDigest
          )
            actions.push(this.action(row, 'read-credential'))
        }
      } else if (
        row.version === 2 &&
        auth?.stage === 'unknown' &&
        ['begin', 'authentication'].includes(row.attemptKind ?? '')
      )
        actions.push(this.action(row, 'renew-authentication'))
    }
    const stage = auth?.stage,
      challenge =
        snapshot && stage && ['waiting', 'scanned', 'handoff'].includes(stage)
          ? snapshot.challenge
          : null,
      account =
        snapshot && stage && ['account', 'confirmed'].includes(stage) ? snapshot.account : null
    return parseConnectionEnrollmentView({
      operation,
      challenge,
      account,
      actions,
      ...(receipt ? { receipt } : {})
    })
  }
  private mark(
    row: EnrollmentRow,
    diagnostic: ConnectionEnrollmentDiagnostic,
    requireClaimed = true
  ): EnrollmentRow {
    return this.store.update(
      row.operation.operationId,
      (r) => {
        // A late local observer cannot overwrite a receipt another original owner has recovered.
        if (
          requireClaimed ? !this.store.claimed(r) : r.operation.revision !== row.operation.revision
        )
          return false

        r.operation.diagnostic = parseConnectionEnrollmentDiagnostic(diagnostic)
        if (r.attemptKind === 'credential') r.operation.credential = 'unknown'
        r.operation.reason =
          diagnostic.stage === 'secure-storage'
            ? 'storage-unconfirmed'
            : r.attemptKind === 'begin'
              ? 'begin-unconfirmed'
              : r.attemptKind === 'credential'
                ? 'credential-unconfirmed'
                : 'poll-unconfirmed'
        if (r.attemptKind === 'upload' || (r.attemptKind === 'create' && !r.operation.application))
          r.operation.creation![r.attemptKind] = 'unknown'
        if (r.activeActionId)
          this.store.changeReceipt(r.operation.operationId, r.activeActionId, (receipt) => {
            receipt.state = 'unknown'
          })
      },
      row.attemptId ?? undefined
    )
  }
  async begin(
    value: ConnectionEnrollmentBeginInput,
    context: ConnectionEnrollmentCallContext
  ): Promise<ConnectionEnrollmentView> {
    const input = parseConnectionEnrollmentParams('connection.enrollment.begin', value)
    await this.authority(this.store.read(input.operationId), context)
    const admitted = this.store.admit(input, context.actor)
    await this.join(input.operationId, async () => {
      let row = this.store.read(input.operationId)!
      if (row.attemptId || row.operation.authentication?.stage !== 'not-started') return
      try {
        const secrets = await this.secure(),
          saved = await secrets.inspect(row.assetOperationId!)
        if (!saved)
          await secrets.store({
            operationId: row.assetOperationId!,
            secret: JSON.stringify(input.preset)
          })
      } catch {
        this.store.update(input.operationId, (r) => {
          r.operation.reason = 'storage-unconfirmed'
          r.operation.diagnostic = { stage: 'secure-storage', code: 'asset-unconfirmed' }
        })
        return
      }
      row = this.store.read(input.operationId)!
      await this.runStep(row, 'begin', context)
    })
    return this.view(this.store.read(admitted.operation.operationId), context)
  }
  async advance(
    value: ConnectionEnrollmentAdvanceInput,
    context: ConnectionEnrollmentCallContext
  ): Promise<ConnectionEnrollmentView> {
    const input = parseConnectionEnrollmentParams('connection.enrollment.advance', value),
      original = this.store.read(input.operationId)
    await this.authority(original, context)
    if (!original) throw issue('UNKNOWN_CONNECTION_ENROLLMENT')
    const prior = this.store.readAction(input.operationId, input.decision.actionId)
    if (prior) {
      if (!same(prior.input, input)) throw issue('CONNECTION_OPERATION_CONFLICT')
      await this.join(input.operationId, async () => {
        await this.recover(this.store.read(input.operationId)!, context)
      })
      const row = this.store.read(input.operationId)!
      return this.view(
        row,
        context,
        this.store.readAction(input.operationId, input.decision.actionId)!.receipt
      )
    }
    const current = await this.view(original, context),
      offered = current.actions.find(
        (a) =>
          a.kind === input.decision.kind &&
          a.actionId === input.decision.actionId &&
          a.ownRevision === input.ownRevision
      )
    if (!offered) throw issue('CONNECTION_REVISION_CONFLICT')
    if (original.version !== 2) {
      if (input.decision.kind !== 'recover-local') throw issue('CONNECTION_REVISION_CONFLICT')
      const row = await this.recover(original, context)
      return this.view(row, context, {
        ...offered,
        stepId: row.configureOperationId,
        state: row.operation.configuration === 'configured' ? 'confirmed' : 'unknown'
      })
    }
    await this.join(input.operationId, async () => {
      await this.authority(this.store.read(input.operationId), context)
      const admitted = this.store.action(input.operationId, input, original)
      if (admitted.duplicate) {
        await this.recover(admitted.row, context)
        return
      }
      let row = admitted.row
      switch (input.decision.kind) {
        case 'recover-local':
          row = await this.recover(row, context)
          this.finishAction(
            row,
            input.decision.actionId,
            row.operation.configuration === 'configured' || !this.store.claimed(row)
              ? 'confirmed'
              : 'unknown'
          )
          return
        case 'confirm-account': {
          const snapshot = await this.privateSnapshot(row)
          if (!snapshot?.account || row.operation.authentication?.stage !== 'account')
            throw issue('CONNECTION_REVISION_CONFLICT')
          await this.authority(row, context)
          this.store.update(input.operationId, (r) => {
            if (
              r.operation.authentication?.attemptId !== row.operation.authentication!.attemptId ||
              r.activeActionId !== input.decision.actionId
            )
              throw issue('CONNECTION_REVISION_CONFLICT')
            r.confirmedAccountDigest = accountDigest(snapshot.account!)
            r.operation.authentication!.stage = 'confirmed'
            this.store.changeReceipt(input.operationId, input.decision.actionId, (receipt) => {
              receipt.state = 'confirmed'
            })
          })
          return
        }
        case 'renew-authentication':
          row = this.store.update(input.operationId, (r) => {
            r.operation.authentication = { attemptId: randomUUID(), stage: 'not-started' }
            delete r.confirmedAccountDigest
            r.privateRef = null
          })
          await this.runStep(row, 'begin', context, input.decision.actionId)
          return
        case 'continue-authentication':
          if (current.challenge && Date.now() < current.challenge.nextPollAt) {
            this.finishAction(row, input.decision.actionId, 'confirmed')
            return
          }
          await this.runStep(row, 'authentication', context, input.decision.actionId)
          return
        case 'create':
          row = this.store.update(input.operationId, (r) => {
            r.creationAccountDigest = r.confirmedAccountDigest!
          })
          if (row.operation.creation!.upload === 'not-started')
            row = await this.runStep(row, 'upload', context, input.decision.actionId)
          if (
            row.operation.creation!.upload !== 'confirmed' ||
            this.store.claimed(row) ||
            row.operation.creation!.create !== 'not-started' ||
            row.activeActionId !== input.decision.actionId
          )
            return
          const created = await this.runStep(row, 'create', context, input.decision.actionId)
          row = created
          if (
            created.operation.creation!.create !== 'confirmed' ||
            this.store.claimed(created) ||
            !created.operation.application ||
            created.activeActionId !== input.decision.actionId
          )
            return
          row = await this.runStep(row, 'credential', context, input.decision.actionId)
          if (row.operation.configuration === 'configured')
            this.finishAction(row, input.decision.actionId, 'confirmed')
          return
        case 'read-credential':
          await this.runStep(row, 'credential', context, input.decision.actionId)
          return
      }
    })
    const row = this.store.read(input.operationId)!
    const recorded = this.store.readAction(input.operationId, input.decision.actionId)
    // Joining another original action does not admit this distinct decision or borrow its receipt.
    if (!recorded) throw issue('CONNECTION_REVISION_CONFLICT')
    return this.view(row, context, recorded.receipt)
  }
  private finishAction(
    row: EnrollmentRow,
    actionId: string,
    state: 'confirmed' | 'unknown'
  ): EnrollmentRow {
    return this.store.update(row.operation.operationId, (r) => {
      this.store.changeReceipt(r.operation.operationId, actionId, (receipt) => {
        receipt.state = state
      })
    })
  }
  private adapterInput(
    row: EnrollmentRow,
    context: ConnectionEnrollmentCallContext
  ): EnrollmentAdapterInput {
    const { operationId, connectionId, domain, label } = row.operation
    return {
      operationId,
      connectionId,
      domain,
      label,
      attemptId: row.attemptId!,
      assertCurrent: () => {
        this.current()
        context.signal?.throwIfAborted()
        const latest = this.store.read(operationId)
        if (
          !latest ||
          latest.attemptId !== row.attemptId ||
          latest.operation.authentication?.attemptId !== row.operation.authentication?.attemptId ||
          !sameEnrollmentActor(latest.actor, context.actor) ||
          !this.store.claimed(latest)
        )
          throw issue('CONNECTION_REVISION_CONFLICT')
      }
    }
  }
  private validate(receipt: Receipt, row: EnrollmentRow, kind: EnrollmentStep): Receipt {
    if (receipt.kind === 'unknown')
      return {
        kind: 'unknown',
        diagnostic: parseConnectionEnrollmentDiagnostic(receipt.diagnostic)
      }
    if (typeof receipt.privateState !== 'string' || !receipt.privateState)
      throw issue('INVALID_CONNECTION_ENROLLMENT_DATA')
    if (kind === 'begin' || kind === 'authentication') {
      if (
        receipt.kind !== 'authentication' ||
        !['waiting', 'scanned', 'handoff', 'account', 'expired'].includes(receipt.stage)
      )
        throw issue('INVALID_CONNECTION_ENROLLMENT_DATA')
      const account =
          receipt.account === null ? null : parseConnectionEnrollmentAccount(receipt.account),
        challenge =
          receipt.challenge === null ? null : parseConnectionEnrollmentChallenge(receipt.challenge)
      if (
        (receipt.stage === 'account') !== (account !== null) ||
        (['waiting', 'scanned'].includes(receipt.stage) && !challenge)
      )
        throw issue('INVALID_CONNECTION_ENROLLMENT_DATA')
      return { ...receipt, account, challenge }
    }
    if (kind === 'upload' && receipt.kind === 'uploaded') return receipt
    if (kind === 'create' && receipt.kind === 'created') {
      const operation = parseConnectionEnrollmentOperation({
        ...row.operation,
        application: receipt.application,
        authorization: 'authorized'
      })
      return { ...receipt, application: operation.application! }
    }
    if (
      kind === 'credential' &&
      receipt.kind === 'credential' &&
      typeof receipt.secret === 'string' &&
      receipt.secret.trim()
    )
      return receipt
    throw issue('INVALID_CONNECTION_ENROLLMENT_DATA')
  }
  private decodeSnapshot(raw: string, row: EnrollmentRow, attemptId?: string): Snapshot {
    const s = JSON.parse(raw) as Snapshot
    if (
      s.operationId !== row.operation.operationId ||
      s.connectionId !== row.operation.connectionId ||
      !sameEnrollmentActor(s.actor, row.actor) ||
      s.authAttemptId !== row.operation.authentication?.attemptId ||
      (attemptId !== undefined && s.attemptId !== attemptId) ||
      typeof s.privateState !== 'string' ||
      !s.privateState
    )
      throw issue('INVALID_CONNECTION_ENROLLMENT_DATA')
    const receipt = this.validate(s.receipt, row, s.kind)
    if (receipt.kind === 'unknown') throw issue('INVALID_CONNECTION_ENROLLMENT_DATA')
    return {
      ...s,
      receipt,
      account: s.account === null ? null : parseConnectionEnrollmentAccount(s.account),
      challenge: s.challenge === null ? null : parseConnectionEnrollmentChallenge(s.challenge)
    }
  }
  private async privateSnapshot(row: EnrollmentRow): Promise<Snapshot | null> {
    if (row.version !== 2 || !row.privateRef) return null
    const secrets = await this.secure(),
      raw = await secrets.resolve(row.privateRef)
    if (!raw) throw issue('CONNECTION_CREDENTIAL_UNAVAILABLE')
    return this.decodeSnapshot(raw, row)
  }
  /** A narrow in-Host source read, not a public raw-state or credential API. */
  async setupSource(source: ConnectionSetupEnrollmentSource, target: { connectionId: string; adapterId: string; application: ConnectionApplication }, context: ConnectionEnrollmentCallContext): Promise<EnrollmentSetupSnapshot> {
    const row = this.store.read(source.operationId)
    await this.authority(row, context)
    const assertCurrent = () => {
      this.current()
      const current = this.store.read(source.operationId), operation = current?.operation, saved = operation?.configured
      if (!current || !sameEnrollmentActor(current.actor, context.actor)) throw issue('CONTROL_PERMISSION_DENIED')
      if (!row || current.version !== 2 || operation!.revision !== source.expectedRevision || current.operation.authentication?.attemptId !== row.operation.authentication?.attemptId) throw issue('CONNECTION_REVISION_CONFLICT')
      if (operation!.configuration !== 'configured' || operation!.credential !== 'stored' || operation!.creation?.create !== 'confirmed' || operation!.authentication?.stage !== 'confirmed' || !saved || saved.operationId !== current.configureOperationId || operation!.connectionId !== target.connectionId || operation!.adapterId !== target.adapterId || operation!.domain !== target.application.domain || operation!.application?.domain !== target.application.domain || operation!.application?.appId !== target.application.appId || saved.connection.config.connectionId !== target.connectionId || saved.connection.config.adapterId !== target.adapterId || saved.connection.config.application.domain !== target.application.domain || saved.connection.config.application.appId !== target.application.appId) throw issue('CONNECTION_SETUP_SOURCE_UNCONFIRMED')
    }
    assertCurrent()
    const snapshot = await this.privateSnapshot(row!)
    await this.authority(row, context)
    assertCurrent()
    if (!snapshot?.account || !row!.confirmedAccountDigest || row!.confirmedAccountDigest !== row!.creationAccountDigest || row!.confirmedAccountDigest !== accountDigest(snapshot.account)) throw issue('CONNECTION_SETUP_SOURCE_UNCONFIRMED')
    return { privateState: snapshot.privateState, account: snapshot.account, authAttemptId: row!.operation.authentication!.attemptId, assertCurrent }
  }
  private async runStep(
    captured: EnrollmentRow,
    kind: EnrollmentStep,
    context: ConnectionEnrollmentCallContext,
    actionId?: string
  ): Promise<EnrollmentRow> {
    let adapter: ConnectionEnrollmentAdapter | undefined
    try {
      adapter = this.adapter(captured)
    } catch {
      return this.mark(captured, { stage: 'adapter', code: 'receipt-unconfirmed' }, false)
    }
    if (!adapter)
      return this.store.update(captured.operation.operationId, (r) => {
        r.operation.reason = 'adapter-unavailable'
        if (actionId)
          this.store.changeReceipt(r.operation.operationId, actionId, (receipt) => {
            receipt.state = 'unknown'
          })
      })
    let previous: Snapshot | null = null,
      preset: ConnectionEnrollmentBeginInput['preset'] | null = null
    try {
      const secrets = await this.secure()
      if (kind !== 'begin') {
        previous = await this.privateSnapshot(captured)
        if (!previous) throw issue('CONNECTION_CREDENTIAL_UNAVAILABLE')
      }
      if (kind === 'begin' || kind === 'upload') {
        const saved = await secrets.inspect(captured.assetOperationId!),
          raw = saved ? await secrets.resolve(saved.credentialRef) : null
        if (!raw) throw issue('CONNECTION_CREDENTIAL_UNAVAILABLE')
        preset = parseConnectionEnrollmentPreset(JSON.parse(raw))
        if (!same(summarizeConnectionEnrollmentPreset(preset), captured.operation.preset))
          throw issue('CONNECTION_OPERATION_CONFLICT')
      }
    } catch {
      return this.mark(
        captured,
        {
          stage: 'secure-storage',
          code:
            kind === 'begin' || kind === 'upload' ? 'asset-unconfirmed' : 'challenge-unconfirmed'
        },
        false
      )
    }
    if (
      ['upload', 'create', 'credential'].includes(kind) &&
      (!previous?.account ||
        captured.operation.authentication?.stage !== 'confirmed' ||
        captured.confirmedAccountDigest !== accountDigest(previous.account) ||
        captured.creationAccountDigest !== captured.confirmedAccountDigest)
    )
      throw issue('CONNECTION_REVISION_CONFLICT')
    await this.authority(captured, context)
    const claim = this.store.claim(
      captured.operation.operationId,
      kind,
      this.owner,
      captured,
      actionId
    )
    if (!claim.claimed) return claim.row
    let receipt: Receipt
    try {
      const input = this.adapterInput(claim.row, context)
      receipt =
        kind === 'begin'
          ? await adapter.begin(input, context.signal)
          : kind === 'authentication'
            ? await adapter.advance(
                { ...input, privateState: previous!.privateState },
                context.signal
              )
            : kind === 'upload'
              ? await adapter.upload(
                  {
                    ...input,
                    privateState: previous!.privateState,
                    pngDataUrl: preset!.avatar.pngDataUrl
                  },
                  context.signal
                )
              : kind === 'create'
                ? await adapter.create(
                    {
                      ...input,
                      privateState: previous!.privateState,
                      preset: {
                        name: captured.operation.preset!.name,
                        ...(captured.operation.preset!.description === undefined
                          ? {}
                          : { description: captured.operation.preset!.description })
                      }
                    },
                    context.signal
                  )
                : await adapter.credential(
                    {
                      ...input,
                      privateState: previous!.privateState,
                      application: captured.operation.application!
                    },
                    context.signal
                  )
    } catch {
      return this.mark(claim.row, { stage: 'adapter', code: 'receipt-unconfirmed' })
    }
    try {
      receipt = this.validate(receipt, claim.row, kind)
    } catch {
      return this.mark(claim.row, { stage: 'response', code: 'invalid-response' })
    }
    if (receipt.kind === 'unknown') return this.mark(claim.row, receipt.diagnostic)
    const snapshot: Snapshot = {
      operationId: claim.row.operation.operationId,
      connectionId: claim.row.operation.connectionId,
      actor: claim.row.actor,
      authAttemptId: claim.row.operation.authentication!.attemptId,
      attemptId: claim.row.attemptId!,
      kind,
      privateState: receipt.privateState,
      challenge:
        receipt.kind === 'authentication' ? receipt.challenge : (previous?.challenge ?? null),
      account: receipt.kind === 'authentication' ? receipt.account : (previous?.account ?? null),
      receipt
    }
    this.unsettled.set(snapshot.operationId, snapshot)
    // An exact application receipt must survive before any credential request or secure handoff.
    if (receipt.kind === 'created') {
      try {
        this.store.update(
          snapshot.operationId,
          (r) => {
            r.operation.application = receipt.application
            r.operation.authorization = 'authorized'
            r.operation.creation!.create = 'confirmed'
          },
          snapshot.attemptId
        )
      } catch {
        return this.mark(claim.row, { stage: 'journal', code: 'receipt-unconfirmed' })
      }
    }
    let row: EnrollmentRow
    try {
      const secrets = await this.secure(),
        saved = await secrets.store({
          operationId: claim.row.snapshotOperationId!,
          secret: JSON.stringify(snapshot)
        })
      row = this.accept(claim.row, snapshot, saved.credentialRef)
      this.unsettled.delete(snapshot.operationId)
    } catch {
      return this.mark(claim.row, { stage: 'secure-storage', code: 'challenge-unconfirmed' })
    }
    if (receipt.kind === 'credential') return this.configure(row, context, receipt.secret)
    return row
  }
  private accept(row: EnrollmentRow, snapshot: Snapshot, privateRef: string): EnrollmentRow {
    return this.store.settle(row.operation.operationId, snapshot.attemptId, (r) => {
      r.privateRef = privateRef
      delete r.operation.reason
      delete r.operation.diagnostic
      const receipt = snapshot.receipt
      if (receipt.kind === 'authentication') r.operation.authentication!.stage = receipt.stage
      if (receipt.kind === 'uploaded') r.operation.creation!.upload = 'confirmed'
      if (receipt.kind === 'created') {
        r.operation.application = receipt.application
        r.operation.authorization = 'authorized'
        r.operation.creation!.create = 'confirmed'
      }
      if (receipt.kind === 'credential') r.operation.credential = 'storing'
      if (r.activeActionId && receipt.kind === 'authentication')
        this.store.changeReceipt(r.operation.operationId, r.activeActionId, (action) => {
          action.state = 'confirmed'
        })
    })
  }
  private async recover(
    row: EnrollmentRow,
    context: ConnectionEnrollmentCallContext
  ): Promise<EnrollmentRow> {
    // Original local ACKs precede platform availability, account eligibility and adapter loading.
    if (row.operation.application) {
      row = await this.configure(row, context)
      if (row.operation.configuration === 'configured') return row
    }
    if (row.version !== 2 || !row.snapshotOperationId || !this.store.claimed(row)) return row
    try {
      const secrets = await this.secure(),
        saved = await secrets.inspect(row.snapshotOperationId),
        live = this.unsettled.get(row.operation.operationId)
      const restored =
        saved ??
        (live?.attemptId === row.attemptId
          ? await secrets.store({
              operationId: row.snapshotOperationId,
              secret: JSON.stringify(live)
            })
          : null)
      if (!restored) return row
      const raw = await secrets.resolve(restored.credentialRef)
      if (!raw) throw issue('CONNECTION_CREDENTIAL_UNAVAILABLE')
      const snapshot = this.decodeSnapshot(raw, row, row.attemptId!)
      row = this.accept(row, snapshot, restored.credentialRef)
      this.unsettled.delete(row.operation.operationId)
      if (snapshot.receipt.kind === 'credential')
        row = await this.configure(row, context, snapshot.receipt.secret)
      return row
    } catch {
      return this.mark(row, { stage: 'secure-storage', code: 'challenge-unconfirmed' })
    }
  }
  private async configure(
    row: EnrollmentRow,
    context: ConnectionEnrollmentCallContext,
    knownSecret?: string
  ): Promise<EnrollmentRow> {
    const operationId = row.operation.operationId
    let stage: 'configuration' | 'secure-storage' | 'authority' | 'journal' = 'configuration'
    if (row.operation.configuration === 'configured' || !row.operation.application) return row
    try {
      const previous = await this.options.connections.inspect({
        operationId: row.configureOperationId
      })
      if (previous.operation) {
        const expected = parseConnectionParams('connection.configure', {
          operationId: row.configureOperationId,
          expectedRevision: null,
          connection: {
            connectionId: row.operation.connectionId,
            adapterId: row.operation.adapterId,
            application: row.operation.application,
            label: row.operation.label,
            credentialRef: previous.operation.connection.config.credentialRef,
            enabled: true
          }
        })
        const configured = parseConnectionResult(
          'connection.configure',
          previous.operation,
          expected
        )
        stage = 'journal'
        return this.store.update(operationId, (r) => {
          r.operation.authorization = 'authorized'
          r.operation.credential = 'stored'
          r.operation.configuration = 'configured'
          r.operation.configured = configured
          delete r.operation.reason
          delete r.operation.diagnostic
        })
      }
      stage = 'secure-storage'
      const secrets = await this.secure()
      let credential = await secrets.inspect(row.credentialOperationId)
      if (!credential && !knownSecret && row.version === 2) {
        const snapshot = await this.privateSnapshot(row)
        if (snapshot?.receipt.kind === 'credential') knownSecret = snapshot.receipt.secret
      }
      if (!credential && knownSecret)
        credential = await secrets.store({
          operationId: row.credentialOperationId,
          secret: knownSecret
        })
      if (!credential)
        return this.store.update(operationId, (r) => {
          r.operation.credential = 'unknown'
          r.operation.reason = 'credential-unconfirmed'
          r.operation.diagnostic = { stage: 'secure-storage', code: 'credential-unconfirmed' }
        })
      stage = 'journal'
      row = this.store.update(operationId, (r) => {
        r.operation.credential = 'stored'
        r.operation.configuration = 'saving'
        delete r.operation.diagnostic
      })
      stage = 'authority'
      await this.authority(row, context)
      const current = this.store.read(operationId)!
      if (
        !same(current.operation.application, row.operation.application) ||
        !sameEnrollmentActor(current.actor, context.actor)
      )
        throw issue('CONNECTION_REVISION_CONFLICT')
      stage = 'configuration'
      const intended = parseConnectionParams('connection.configure', {
        operationId: row.configureOperationId,
        expectedRevision: null,
        connection: {
          connectionId: row.operation.connectionId,
          adapterId: row.operation.adapterId,
          application: row.operation.application,
          label: row.operation.label,
          credentialRef: credential.credentialRef,
          enabled: true
        }
      })
      const configured = parseConnectionResult(
        'connection.configure',
        await this.options.connections.configure(intended),
        intended
      )
      stage = 'journal'
      return this.store.update(operationId, (r) => {
        r.operation.authorization = 'authorized'
        r.operation.configuration = 'configured'
        r.operation.configured = configured
        delete r.operation.reason
        delete r.operation.diagnostic
        if (r.activeActionId)
          this.store.changeReceipt(r.operation.operationId, r.activeActionId, (receipt) => {
            receipt.state = 'confirmed'
          })
      })
    } catch (error) {
      if (stage === 'authority') throw error
      const latest = this.store.read(operationId)!
      if (
        latest.operation.configuration === 'configured' ||
        (stage === 'secure-storage' && latest.operation.credential === 'stored')
      )
        return latest
      return this.store.update(operationId, (r) => {
        if (r.operation.configuration === 'configured') return false
        if (stage === 'secure-storage') {
          if (r.operation.credential === 'stored') return false
          r.operation.credential = 'unknown'
          r.operation.reason = 'credential-unconfirmed'
          r.operation.diagnostic = { stage: 'secure-storage', code: 'credential-unconfirmed' }
          return
        }
        r.operation.configuration =
          error instanceof AgentMuxError &&
          ['CONNECTION_IDENTITY_CONFLICT', 'CONNECTION_REVISION_CONFLICT'].includes(error.code)
            ? 'refused'
            : 'unknown'
        r.operation.reason =
          r.operation.configuration === 'refused'
            ? 'connection-conflict'
            : 'configuration-unconfirmed'
        r.operation.diagnostic = { stage: 'journal', code: 'receipt-unconfirmed' }
      })
    }
  }
}
