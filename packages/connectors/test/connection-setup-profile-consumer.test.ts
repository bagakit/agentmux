import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import {
  connectionSetupDecisionForAction,
  parseConnectionSetupOperation,
  parseConnectionSetupParams,
  parseConnectionSetupResult,
  type ConnectionSetupBegin,
  type ConnectionSetupView,
  type ConnectionSetupPublicationReview
} from '@agentmux/core/connections'
import type { ConnectionAdapter } from '@agentmux/connectors'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import {
  enrollmentEncryption,
  enrollmentAvatar
} from './fixtures/connection-enrollment.js'
import {
  objectCliEnvironment,
  runCompiledObjectCli
} from '../../core/test/helpers/object-cli-rpc.js'
const clean: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
async function fixture(
  options: {
    unknown?: 'upload' | 'write'
    hold?: 'upload' | 'write' | 'readback'
    pending?: boolean
    reviewing?: boolean
    readFailure?: boolean
    incompleteProfile?: boolean
    draftUnavailable?: boolean
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'console-profile-')),
    socketPath = join(root, 'owner.sock'),
    encryption = enrollmentEncryption()
  let services: Awaited<ReturnType<typeof createDesktopConnections>>,
    server: AgentMuxControlServer,
    sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>,
    release = () => {}
  const requests: Array<{
      kind: string
      preclaimed?: boolean
    }> = [],
    state = {
      name: 'Original',
      description: 'Original description',
      avatar: 'original-avatar'
    },
    audience = {
      all: false,
      departments: ['original-dept'],
      people: ['original-person'],
      groups: []
    }
  let created = false,
    submitted = false,
    blocked = Boolean(options.readFailure)
  const held = async (kind: string) => {
    if (options.hold === kind)
      await new Promise<void>((r) => {
        release = r
      })
  }
  const review = (
    effect: string,
    draft: any
  ): ConnectionSetupPublicationReview => ({
    versions: [
      { versionId: 'old-version', version: '1.0.0', status: 'approved' }
    ],
    selectedVersion:
      effect === 'submit-application-version'
        ? {
            versionId: 'new-version',
            version: '1.0.1',
            status: 'draft',
            notes: 'AMUX identity update'
          }
        : null,
    changes: options.pending
      ? [
          {
            category: 'permissions',
            details: ['Separate pending permission change']
          }
        ]
      : [],
    audience: {
      include: audience,
      exclude: {
        all: false,
        departments: [],
        people: ['excluded-person'],
        groups: []
      }
    },
    proposedAudience: {
      include: audience,
      exclude: {
        all: false,
        departments: [],
        people: ['excluded-person'],
        groups: []
      }
    },
    entries: null,
    sharing: null,
    reasonRequired: null,
    creatorAudienceAvailable: false,
    issues: options.draftUnavailable ? ['Current publication version is unconfirmed'] : []
  })
  const effect = async (kind: string, operationId: string) => {
    const rows = services
      .database!.prepare(
        'SELECT record_json FROM connection_setup_inspection WHERE operation_id=? ORDER BY ordinal DESC LIMIT 1'
      )
      .get(operationId)
    expect(JSON.parse(String(rows!.record_json)).receipt.request).toBe(
      'dispatching'
    )
    requests.push({ kind, preclaimed: true })
    await held(kind)
  }
  const configuration: any = {
    domains: ['profile.example'],
    initialPublicationDraft: undefined,
    publicationPlan: async (
      effect: string,
      states: any,
      draft: any,
      creator: any,
      provenance: any
    ) => ({
      review: review(effect, draft),
      requiredSubjects:
        effect === 'create-application-version'
          ? [
              'publication-pending',
              'publication-versions',
              'publication-visibility',
              'publication-sharing',
              'publication-features'
            ]
          : [
              'publication-version',
              'publication-versions',
              'publication-features'
            ],
      privateIntent: draft && !options.draftUnavailable ? JSON.stringify({ effect, draft }) : null
    }),
    createVersion: async (input: any) => {
      await effect('create', input.operationId)
      created = true
      return {
        kind: 'accepted',
        privateState: 'private-created-receipt',
        versionId: 'new-version',
        submission: null
      }
    },
    submitVersion: async (input: any) => {
      await effect('submit', input.operationId)
      submitted = true
      return {
        kind: 'accepted',
        privateState: 'private-submitted-receipt',
        versionId: 'new-version',
        submission: { outcome: 'accepted', issues: [] }
      }
    },
    applicationProfile: {
      plan: async (desired: any, raw: string, uploaded?: string) => {
        const baseline = JSON.parse(raw)
        if (!baseline.complete)
          return {
            baseline: 'unknown',
            privateIntent: null,
            matches: 'unknown'
          }
        if (desired.avatarSha256 && !uploaded)
          return {
            baseline: 'confirmed',
            privateIntent: null,
            matches: 'unknown'
          }
        const next = {
          ...(desired.name === undefined ? {} : { name: desired.name }),
          ...(desired.description === undefined
            ? {}
            : { description: desired.description }),
          ...(desired.avatarSha256 ? { avatar: 'uploaded-avatar' } : {})
        }
        const matches = Object.entries(next).every(
          ([k, v]) => baseline[k] === v
        )
        return {
          baseline: 'confirmed',
          privateIntent: matches ? null : JSON.stringify(next),
          matches: matches ? 'matched' : 'different'
        }
      },
      uploadAvatar: async (input: any) => {
        expect(input.pngDataUrl).toBe(enrollmentAvatar)
        input.assertCurrent()
        await effect('upload', input.operationId)
        return options.unknown === 'upload'
          ? {
              kind: 'unknown',
              diagnostic: { httpStatus: 502, code: 'http-status' }
            }
          : { kind: 'accepted', privateState: 'private-uploaded-avatar' }
      },
      update: async (input: any) => {
        input.assertCurrent()
        await effect('write', input.operationId)
        Object.assign(state, JSON.parse(input.privateIntent))
        return options.unknown === 'write'
          ? {
              kind: 'unknown',
              diagnostic: { httpStatus: 502, code: 'http-status' }
            }
          : { kind: 'accepted', privateState: 'private-updated-profile' }
      },
      publicationDraft: async (states: any, notes: string) =>
        !options.draftUnavailable && states.versions && states.visibility
          ? {
              kind: 'create-version',
              version: JSON.parse(states.versions).versions.length
                ? '1.0.2'
                : '1.0.1',
              notes,
              visibility: 'current'
            }
          : null
    },
    messagingCapability: async () => 'enabled',
    eventTransportCapability: async () => 'enabled',
    permissionPlan: async () => {
      throw Error('No profile scope request')
    },
    messageReceptionPlan: async () => {
      throw Error('No profile event request')
    },
    addMessageReception: async () => {
      throw Error('No profile event write')
    },
    addApplicationPermissions: async () => {
      throw Error('No profile scope write')
    },
    usePersistentConnection: async () => {
      throw Error('No profile mode write')
    },
    enableMessaging: async () => {
      throw Error('No profile bot switch')
    }
  }
  const adapter: ConnectionAdapter = {
    adapterId: 'profile-protocol',
    test: async () => {
      throw Error('No profile receiver test')
    },
    setup: {
      domains: ['profile.example'],
      begin: async (input) => {
        requests.push({ kind: 'auth-init' })
        return {
          kind: 'challenge',
          challenge: {
            qrPayload: 'private-profile-qr',
            expiresAt: null,
            nextPollAt: 0
          },
          privateState: JSON.stringify({ operationId: input.operationId })
        }
      },
      advance: async (input) => {
        requests.push({ kind: 'auth' })
        expect(JSON.parse(input.privateState).operationId).toBe(
          input.operationId
        )
        return {
          kind: 'progress',
          stage: 'account',
          challenge: null,
          account: {
            userId: 'private-profile-user',
            tenantId: 'private-profile-tenant'
          },
          privateState: input.privateState
        }
      },
      applicationConfiguration: configuration,
      applicationInspection: {
        domains: ['profile.example'],
        inspect: async () => ({ kind: 'unknown' }),
        read: async (input) => {
          requests.push({ kind: input.subject })
          if (blocked && input.subject === 'application-details')
            return { kind: 'unknown' }
          if (
            input.subject === 'application-details' &&
            state.name !== 'Original'
          )
            await held('readback')
          return {
            kind: 'observed',
            readResult:
              input.subject === 'application-details'
                ? {
                    subject: input.subject,
                    name: state.name,
                    description: state.description
                  }
                : input.subject === 'publication-version'
                  ? {
                      subject: input.subject,
                      versionId: input.versionId!,
                      status: submitted
                        ? options.reviewing
                          ? 'reviewing'
                          : 'approved'
                        : 'draft'
                    }
                  : ({ subject: input.subject } as any),
            privateState: JSON.stringify(
              input.subject === 'application-details'
                ? { ...state, complete: !options.incompleteProfile }
                : input.subject === 'publication-versions'
                  ? { versions: created ? [{ versionId: 'new-version' }] : [] }
                  : input.subject === 'publication-version'
                    ? { versionId: input.versionId }
                    : { complete: true }
            )
          }
        }
      }
    }
  }
  const open = async () => {
    services = await createDesktopConnections({
      directory: join(root, 'connections'),
      encryption,
      adapters: [adapter]
    })
    server = new AgentMuxControlServer({
      socketPath,
      connections: services.connections,
      coreClients: () => {
        throw Error('No profile runtime dependency')
      }
    })
    await server.start()
    sdk = await connectAgentMuxRpc({
      endpoint: { transport: 'unix', path: socketPath }
    })
  }
  const close = async () => {
    sdk.dispose()
    await server.stop()
    services.close()
  }
  await open()
  clean.push(() => rm(root, { recursive: true, force: true }), close)
  const credential = await services.secrets.store({
    operationId: 'profile-original-credential',
    secret: 'private-original-credential'
  })
  await sdk.call('connection.configure', {
    operationId: 'profile-original-save',
    expectedRevision: null,
    connection: {
      connectionId: 'profile-connection',
      adapterId: adapter.adapterId,
      application: { domain: 'profile.example', appId: 'original-app' },
      label: 'Saved bot',
      enabled: false,
      credentialRef: credential.credentialRef
    }
  })
  const input: ConnectionSetupBegin = {
    operationId: 'profile-setup',
    connectionId: 'profile-connection',
    expectedConnectionRevision: 1,
    goal: {
      kind: 'profile-update',
      desired: {
        name: 'Saved Mote',
        description: '',
        avatar: { pngDataUrl: enrollmentAvatar }
      },
      publication: { notes: 'AMUX identity update' }
    }
  }
  const advance = async (view: ConnectionSetupView, kind: string) => {
    const offered = [
      ...(view.continuation?.actions ?? []),
      ...(view.profileUpdate?.actions ?? []),
      ...(view.applicationConfiguration?.actions ?? [])
    ].find((a) => a.kind === kind)!
    expect(offered, kind).toBeDefined()
    return sdk.call('connection.setup.advance', {
      operationId: view.operation!.operationId,
      expectedRevision: offered.expectedRevision,
      decision: {
        actionId: offered.actionId,
        value: connectionSetupDecisionForAction(offered)
      },
      ...(view.applicationConfiguration &&
      'draft' in view.applicationConfiguration &&
      view.applicationConfiguration.draft
        ? { publicationDraft: view.applicationConfiguration.draft }
        : {})
    })
  }
  const begin = async () => {
    let view = await sdk.call('connection.setup.begin', input)
    view = await advance(view, 'continue')
    return advance(view, 'confirm-account')
  }
  const cli = async (args: string[], body?: unknown) => {
    const result = await runCompiledObjectCli(
      ['--endpoint', 'unix:' + socketPath, 'connection', ...args],
      objectCliEnvironment(root),
      body === undefined ? '' : JSON.stringify(body)
    )
    expect(result.code, result.stdout + result.stderr).toBe(0)
    return JSON.parse(result.stdout).result
  }
  return {
    input,
    requests,
    begin,
    advance,
    cli,
    get sdk() {
      return sdk
    },
    get services() {
      return services
    },
    unblock() {
      blocked = false
    },
    release() {
      release()
    },
    reopen: async () => {
      await close()
      await open()
    }
  }
}
it('executes the public existing-profile flow and compiled CLI history without creating another application or SDK write', async () => {
  const f = await fixture(),
    view = await f.begin()
  expect(view.profileUpdate).toMatchObject({
    stage: 'publication-status',
    state: 'complete',
    versionId: 'new-version',
    actions: []
  })
  expect(f.requests.filter((r) => r.preclaimed).map((r) => r.kind)).toEqual([
    'upload',
    'write',
    'create',
    'submit'
  ])
  expect(view.operation?.goal).toMatchObject({
    kind: 'profile-update',
    desired: {
      name: 'Saved Mote',
      description: '',
      avatarSha256: createHash('sha256').update(Buffer.from(enrollmentAvatar.slice(22),'base64')).digest('hex')
    }
  })
  expect(JSON.stringify(view.operation)).not.toContain(enrollmentAvatar)
  const count = f.requests.length
  expect(
    (await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId]))
      .profileUpdate.state
  ).toBe('complete')
  expect(
    (await f.cli(['setup', 'ls', '--connection', f.input.connectionId]))
      .operations[0].goal
  ).toEqual(view.operation!.goal)
  expect(f.requests).toHaveLength(count)
  await f.reopen()
  expect(
    (
      await f.sdk.call('connection.setup.inspect', {
        operationId: f.input.operationId
      })
    ).profileUpdate?.state
  ).toBe('complete')
  await expect(
    f.sdk.call('connection.setup.begin', {
      ...f.input,
      goal: { ...f.input.goal, desired: { name: 'Different' } }
    } as ConnectionSetupBegin)
  ).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  const trace = await f.sdk.call('connection.setup.inspect', {
    operationId: f.input.operationId,
    requestTrace: { limit: 100 }
  })
  expect(
    trace.requestTrace!.entries.filter(
      (r) => r.kind === 'application-configuration'
    )
  ).toHaveLength(4)
  expect(JSON.stringify(trace)).not.toMatch(/private-|pngDataUrl/)
  expect(JSON.stringify(trace.requestTrace)).not.toContain('avatarSha256')
}, 30000)
it('updates and reads back the original profile before publication facts can block their own stage', async () => {
  const f = await fixture({ draftUnavailable: true }), view = await f.begin()
  expect(view.profileUpdate).toMatchObject({ stage: 'publication-create', state: 'attention' })
  const firstPublication = f.requests.findIndex(r => r.kind.startsWith('publication-'))
  expect(firstPublication).toBeGreaterThan(0)
  expect(f.requests.slice(0, firstPublication).map(r => r.kind).filter(k => !k.startsWith('auth'))).toEqual(['application-details', 'upload', 'write', 'application-details'])
  expect(f.requests.filter(r => r.preclaimed).map(r => r.kind)).toEqual(['upload', 'write'])
  const selector = { operationId: f.input.operationId, applicationConfiguration: { effect: 'create-application-version' as const } }
  const reviewed = await f.sdk.call('connection.setup.inspect', selector), count = f.requests.length
  expect(reviewed.applicationConfiguration).toMatchObject({ effect: 'create-application-version', draft: null, capability: 'unknown', actions: [], review: { issues: ['Current publication version is unconfirmed'] } })
  const cli = await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId, '--application-configuration', 'create-application-version'])
  expect(cli.applicationConfiguration).toEqual(reviewed.applicationConfiguration)
  expect(f.requests).toHaveLength(count)
  const profileSelector = { operationId: f.input.operationId, applicationConfiguration: { effect: 'update-application-profile' as const } }
  const originalEffect = (await f.sdk.call('connection.setup.inspect', profileSelector)).applicationConfiguration!.selected
  let current = view
  for (let retry = 0; retry < 2; retry++) {
    current = await f.advance(current, 'continue-profile-update')
    expect(current.profileUpdate).toMatchObject({ stage: 'publication-create', state: 'attention' })
    expect(current.operation?.operationId).toBe(f.input.operationId)
  }
  expect(f.requests.filter(r => r.kind === 'application-details')).toHaveLength(2)
  expect(f.requests.filter(r => r.preclaimed).map(r => r.kind)).toEqual(['upload', 'write'])
  expect((await f.sdk.call('connection.setup.inspect', profileSelector)).applicationConfiguration!.selected).toEqual(originalEffect)
  const trace = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, requestTrace: { limit: 100 } })
  expect(trace.requestTrace!.entries.filter(r => r.kind === 'application-configuration').map(r => r.effect)).toEqual(['upload-profile-avatar', 'update-application-profile'])
}, 30000)

it('keeps a confirmed but incomplete application baseline in profile preflight without any future publication work', async () => {
  const f = await fixture({ incompleteProfile: true }), view = await f.begin()
  expect(view.profileUpdate).toMatchObject({ stage: 'profile-preflight', state: 'attention' })
  expect(f.requests.filter(r => !r.kind.startsWith('auth'))).toEqual([{ kind: 'application-details' }])
  const source = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: 'upload-profile-avatar' } })
  expect(source.applicationConfiguration).toMatchObject({ capability: 'unknown', reason: 'source-unconfirmed', actions: [], source: { request: 'confirmed', secureStorage: 'stored' } })
  expect(f.requests.filter(r => r.preclaimed)).toEqual([])
}, 30000)

it.each(['upload', 'write'] as const)(
  'retains original unknown %s after owner restart and never effects it again',
  async (unknown) => {
    const f = await fixture({ unknown }),
      view = await f.begin()
    expect(view.profileUpdate).toMatchObject({
      stage: unknown === 'upload' ? 'avatar-upload' : 'profile-write',
      state: 'attention',
      actions: []
    })
    const selected = await f.sdk.call('connection.setup.inspect', {
      operationId: f.input.operationId,
      applicationConfiguration: {
        effect:
          unknown === 'upload'
            ? 'upload-profile-avatar'
            : 'update-application-profile'
      }
    })
    expect(selected.applicationConfiguration?.selected).toMatchObject({
      request: 'unknown',
      diagnostic: { httpStatus: 502, code: 'http-status' }
    })
    const traced = await f.cli([
      'setup',
      'inspect',
      '--operation-id',
      f.input.operationId,
      '--request-trace'
    ])
    expect(
      traced.requestTrace.entries.find(
        (e: any) =>
          e.effect ===
          (unknown === 'upload'
            ? 'upload-profile-avatar'
            : 'update-application-profile')
      ).diagnostic
    ).toEqual({ httpStatus: 502, code: 'http-status' })
    const count = f.requests.length
    await f.reopen()
    expect((await f.sdk.call('connection.setup.begin', f.input)).profileUpdate).toEqual(view.profileUpdate)
    expect((await f.cli(['setup', 'inspect', '--operation-id', f.input.operationId])).profileUpdate).toEqual(view.profileUpdate)
    expect(f.requests).toHaveLength(count)
    expect(f.requests.filter((r) => r.kind === unknown)).toHaveLength(1)
  },
  30000
)
it.each(['upload', 'write', 'readback'] as const)(
  'keeps the actual pending %s phase readable through local public inspect',
  async (hold) => {
    const f = await fixture({ hold }),
      pending = f.begin()
    await vi.waitFor(() =>
      expect(
        f.requests.some(
          (r) =>
            r.kind === (hold === 'readback' ? 'application-details' : hold) &&
            (hold !== 'readback' || f.requests.some((r) => r.kind === 'write'))
        )
      ).toBe(true)
    )
    const count = f.requests.length,
      view = await f.sdk.call('connection.setup.inspect', {
        operationId: f.input.operationId
      })
    expect(view.profileUpdate).toMatchObject({
      stage:
        hold === 'upload'
          ? 'avatar-upload'
          : hold === 'write'
            ? 'profile-write'
            : 'profile-readback',
      state: 'running'
    })
    expect(f.requests).toHaveLength(count)
    f.release()
    expect((await pending).profileUpdate?.state).toBe('complete')
  },
  30000
)
it('uses only an offered continuation for failed reads and original approval-status refresh', async () => {
  const f = await fixture({ readFailure: true, reviewing: true }),
    view = await f.begin()
  expect(view.profileUpdate).toMatchObject({
    stage: 'profile-preflight',
    state: 'attention'
  })
  f.unblock()
  const resumed = await f.advance(view, 'continue-profile-update')
  expect(resumed.profileUpdate).toMatchObject({
    stage: 'publication-status',
    state: 'approval-required',
    versionId: 'new-version'
  })
  const count = f.requests.filter((r) => r.preclaimed).length
  expect(
    (await f.advance(resumed, 'continue-profile-update')).profileUpdate?.state
  ).toBe('approval-required')
  expect(f.requests.filter((r) => r.preclaimed)).toHaveLength(count)
}, 30000)
it('requires the existing publication review and original confirm action before including independent pending changes', async () => {
  const f = await fixture({ pending: true }),
    view = await f.begin()
  expect(view.profileUpdate).toMatchObject({
    stage: 'publication-create',
    state: 'attention',
    actions: [],
    publicationDraft: { kind: 'create-version', visibility: 'current' }
  })
  expect(f.requests.filter((r) => r.kind === 'create')).toHaveLength(0)
  const review = await f.sdk.call('connection.setup.inspect', {
    operationId: f.input.operationId,
    applicationConfiguration: {
      effect: 'create-application-version',
      draft: view.profileUpdate!.publicationDraft!
    }
  })
  expect(
    review.applicationConfiguration &&
      'review' in review.applicationConfiguration &&
      review.applicationConfiguration.review
  ).toMatchObject({
    changes: [{ category: 'permissions' }],
    audience: {
      include: { departments: ['original-dept'] },
      exclude: { people: ['excluded-person'] }
    }
  })
  expect(
    (await f.advance(review, 'create-application-version')).profileUpdate?.state
  ).toBe('complete')
}, 30000)
it('strictly separates frozen input pixels from public safe operation and rejects forged profile progress', () => {
  const input: ConnectionSetupBegin = {
    operationId: 'safe-profile',
    connectionId: 'safe-connection',
    expectedConnectionRevision: 1,
    goal: {
      kind: 'profile-update',
      desired: { avatar: { pngDataUrl: enrollmentAvatar } },
      publication: { notes: 'Update' }
    }
  }
  expect(parseConnectionSetupParams('connection.setup.begin', input)).toEqual(
    input
  )
  const operation = {
    ...input,
    revision: 1,
    adapterId: 'safe-provider',
    application: { domain: 'safe.example', appId: 'safe-app' },
    request: { state: 'not-dispatched', attemptId: null },
    secureStorage: 'not-started'
  }
  expect(() => parseConnectionSetupOperation(operation)).toThrow()
  expect(() =>
    parseConnectionSetupParams('connection.setup.begin', {
      ...input,
      source: { kind: 'enrollment', operationId: 'other', expectedRevision: 1 }
    })
  ).toThrow()
})
it('keeps the frozen original version after an explicit version-list refresh, same begin and owner restart', async () => {
  const f = await fixture(),
    done = await f.begin()
  const original = await f.sdk.call('connection.setup.inspect', {
    operationId: f.input.operationId,
    applicationInspection: {}
  })
  const action = original.applicationInspection!.actions.find(
    (a) => a.kind === 'read-publication-versions'
  )!
  const refreshed = await f.sdk.call('connection.setup.advance', {
    operationId: f.input.operationId,
    expectedRevision: action.expectedRevision,
    decision: { actionId: action.actionId, value: 'continue' }
  })
  expect(refreshed.profileUpdate).toMatchObject({
    state: 'complete',
    versionId: 'new-version'
  })
  await f.reopen()
  expect(
    (await f.sdk.call('connection.setup.begin', f.input)).profileUpdate
  ).toMatchObject({ state: 'complete', versionId: 'new-version' })
  expect(f.requests.filter((r) => r.kind === 'create')).toHaveLength(1)
  expect(f.requests.filter((r) => r.kind === 'submit')).toHaveLength(1)
}, 30000)
it('recovers the original persisted upload ACK after owner restart without a second upload', async () => {
  const f = await fixture(),
    originalStore = DesktopConnectorSecrets.prototype.store
  let failed = false
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(
    async function (input) {
      const saved = await originalStore.call(this, input)
      if (!failed && input.operationId.startsWith('connection-setup-effect:')) {
        failed = true
        throw Error('Synthetic lost secret-store ACK')
      }
      return saved
    }
  )
  const uncertain = await f.begin()
  expect(uncertain.profileUpdate).toMatchObject({
    stage: 'avatar-upload',
    state: 'attention',
    actions: [{ kind: 'recover-configuration-effect' }]
  })
  await f.reopen()
  const retained = await f.sdk.call('connection.setup.inspect', {
    operationId: f.input.operationId
  })
  expect(
    (await f.advance(retained, 'recover-configuration-effect')).profileUpdate
      ?.state
  ).toBe('complete')
  expect(f.requests.filter((r) => r.kind === 'upload')).toHaveLength(1)
}, 30000)

it.each([
  ['confirmed', 'unknown', true, false],
  ['confirmed', 'dispatching', true, false],
  ['unknown', 'not-dispatched', false, false],
  ['confirmed', 'confirmed', false, false],
  ['confirmed', 'unknown', false, true]
] as const)(
  'scopes historical upload=%s patch=%s to the exact app write',
  async (upload, patch, blocked, otherApp) => {
    const f = await fixture()
    await f.sdk.call('connection.setup.begin', f.input)
    const db = f.services.database!,
      actor = db
        .prepare(
          'SELECT actor_json FROM connection_setup_operation WHERE operation_id=?'
        )
        .get(f.input.operationId)!.actor_json
    db.exec(
      'CREATE TABLE connection_profile_operation (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL,input_json TEXT NOT NULL,config_json TEXT NOT NULL,actor_json TEXT NOT NULL,record_json TEXT NOT NULL,upload_wire TEXT,patch_wire TEXT,avatar_url TEXT)'
    )
    const old = {
      operationId: 'prior-profile-write',
      connectionId: 'prior-app-alias',
      connectionRevision: 1,
      application: {
        domain: 'profile.example',
        appId: otherApp ? 'another-app' : 'original-app'
      },
      language: null,
      fields: ['name', 'avatar'],
      desired: { name: 'Prior requested name', avatarSha256: 'a'.repeat(64) },
      upload: { state: upload },
      patch: { state: patch },
      publication:
        patch === 'confirmed' ? 'platform-review-required' : 'not-requested',
      online: null
    }
    db.prepare(
      'INSERT INTO connection_profile_operation(operation_id,connection_id,input_json,config_json,actor_json,record_json) VALUES(?,?,?,?,?,?)'
    ).run(
      old.operationId,
      old.connectionId,
      '{}',
      '{}',
      String(actor),
      JSON.stringify(old)
    )
    const view = await f.begin()
    if (blocked) {
      expect(view.profileUpdate).toMatchObject({
        stage: 'profile-write',
        state: 'attention',
        actions: [],
        blockedBy: {
          kind: 'profile-operation',
          operationId: old.operationId,
          connectionId: old.connectionId
        }
      })
      expect(f.requests.filter((r) => r.kind === 'write')).toHaveLength(0)
      const before = f.requests.length
      const observed = await f.sdk.call('connection.setup.inspect', {
        operationId: f.input.operationId,
        applicationInspection: {}
      })
      expect(
        observed.applicationInspection!.actions.some(
          (a) => a.kind === 'read-application-details'
        )
      ).toBe(true)
      expect(
        (
          await f.sdk.call('connection.profile.inspect', {
            operationId: old.operationId
          })
        ).operation?.patch.state
      ).toBe('unknown')
      expect(f.requests).toHaveLength(before)
    } else expect(view.profileUpdate?.state).toBe('complete')
  },
  30000
)

it('does not advertise or execute publication before this goal has matching original profile readback', async () => {
  const f = await fixture({ hold: 'write' }),
    pending = f.begin()
  await vi.waitFor(() =>
    expect(f.requests.some((r) => r.kind === 'write')).toBe(true)
  )
  for (const subject of [
    'publication-pending',
    'publication-versions',
    'publication-visibility',
    'publication-sharing',
    'publication-features'
  ] as const) {
    const observed = await f.sdk.call('connection.setup.inspect', {
      operationId: f.input.operationId,
      applicationInspection: {}
    })
    const action = observed.applicationInspection!.actions.find(
      (a) => a.kind === 'read-' + subject
    )!
    await f.sdk.call('connection.setup.advance', {
      operationId: f.input.operationId,
      expectedRevision: action.expectedRevision,
      decision: { actionId: action.actionId, value: 'continue' }
    })
  }
  const view = await f.sdk.call('connection.setup.inspect', {
    operationId: f.input.operationId,
    applicationConfiguration: {
      effect: 'create-application-version',
      draft: {
        kind: 'create-version',
        version: '1.0.1',
        notes: 'AMUX identity update',
        visibility: 'current'
      }
    }
  })
  expect(view.applicationConfiguration!.actions).toEqual([])
  expect(view.applicationConfiguration!.capability).toBe('unknown')
  expect(f.requests.filter((r) => r.kind === 'create')).toHaveLength(0)
  f.release()
  expect((await pending).profileUpdate?.state).toBe('complete')
}, 30000)

it('does not make an independent name-only goal depend on an earlier unknown Console avatar upload', async () => {
  const f = await fixture({ unknown: 'upload' })
  expect((await f.begin()).profileUpdate?.stage).toBe('avatar-upload')
  const next: ConnectionSetupBegin = {
    ...f.input,
    operationId: 'independent-name-update',
    goal: {
      kind: 'profile-update',
      desired: { name: 'Independent name' },
      publication: { notes: 'AMUX name update' }
    }
  }
  let view = await f.sdk.call('connection.setup.begin', next)
  view = await f.advance(view, 'continue')
  view = await f.advance(view, 'confirm-account')
  expect(view.profileUpdate?.state).toBe('complete')
  expect(f.requests.filter((r) => r.kind === 'upload')).toHaveLength(1)
  expect(
    (
      await f.sdk.call('connection.setup.inspect', {
        operationId: f.input.operationId
      })
    ).profileUpdate
  ).toMatchObject({ stage: 'avatar-upload', state: 'attention' })
}, 30000)


it('refuses a publication action whose profile read epoch changed through another original app alias', async()=>{
  const f=await fixture({pending:true}),view=await f.begin()
  const reviewed=await f.sdk.call('connection.setup.inspect',{operationId:f.input.operationId,applicationConfiguration:{effect:'create-application-version',draft:view.profileUpdate!.publicationDraft!}})
  expect(reviewed.applicationConfiguration!.actions.map(a=>a.kind)).toEqual(['create-application-version'])
  let alias=await f.sdk.call('connection.setup.begin',{operationId:'other-app-observer',connectionId:f.input.connectionId,expectedConnectionRevision:1,goal:{kind:'agent-conversation',interaction:'messages'}})
  alias=await f.advance(alias,'continue');alias=await f.advance(alias,'confirm-account')
  const observed=await f.sdk.call('connection.setup.inspect',{operationId:'other-app-observer',applicationInspection:{}}),read=observed.applicationInspection!.actions.find(a=>a.kind==='read-application-details')!
  await f.sdk.call('connection.setup.advance',{operationId:'other-app-observer',expectedRevision:read.expectedRevision,decision:{actionId:read.actionId,value:'continue'}})
  await expect(f.advance(reviewed,'create-application-version')).rejects.toMatchObject({code:'CONNECTION_SETUP_ACTION_STALE'})
  expect(f.requests.filter(r=>r.kind==='create')).toHaveLength(0)
  const current=await f.sdk.call('connection.setup.inspect',{operationId:f.input.operationId})
  expect((await f.advance(current,'continue-profile-update')).profileUpdate).toMatchObject({stage:'publication-create',state:'attention'})
},30000)
