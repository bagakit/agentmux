import {
  CONNECTION_SETUP_READ_ACTIONS, connectionSetupPublicationSubjects, parseConnectionParams, parseConnectionResult,
  type ConnectionMethod, type ConnectionParamsMap, type ConnectionResultMap, type ConnectionRecord,
  type ConnectionOperation, type ConnectionServiceOperation, type ConnectionSetupAction, type ConnectionSetupAdvance,
  type ConnectionSetupConfigurationReceipt, type ConnectionSetupConfigurationSelector, type ConnectionSetupInspectionReceipt, type ConnectionSetupInspectionAction,
  type ConnectionSetupOperation, type ConnectionSetupPublicationReview, type ConnectionSetupReadSubject, type ConnectionSetupView
} from '@agentmux/core/connections'
import { api } from '../../../src/renderer/src/lib/api'

const botId = 'settings-preview-bot', setupId = 'settings-preview-setup'
const permissions = [
  ['im:message:send_as_bot', 'messages'], ['im:message:readonly', 'messages'], ['im:message.group_msg', 'messages'],
  ['im:chat:create', 'groups'], ['im:chat:read', 'groups'], ['im:chat.members:read', 'groups'],
  ['im:chat.members:write_only', 'groups'], ['application:application:self_manage', 'identity']
] as const
const effectKinds = new Set<ConnectionSetupAction['kind']>([
  'enable-messaging', 'use-persistent-connection', 'use-persistent-callback', 'add-card-actions', 'add-application-permissions',
  'add-message-reception', 'create-application-version', 'submit-application-version', 'upload-profile-avatar', 'update-application-profile'
])

/** Controlled public DTOs, not a substitute Settings UI or a platform implementation. */
export function installLarkPreview() {
  const original = api.connections.call
  const record: ConnectionRecord = {
    config: { connectionId: botId, adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_preview_conversations' },
      label: 'Research and engineering assistant', enabled: false, credentialRef: 'preview-credential-reference' },
    revision: 1, initialSetup: { state: 'incomplete' },
    observation: { authentication: { state: 'ready' }, transport: { state: 'disabled' }, intake: { state: 'unknown', reason: 'not-tested' }, delivery: { state: 'unknown', reason: 'not-tested' } }
  }
  const records = new Map([[botId, record]])
  const operation: ConnectionSetupOperation = {
    operationId: setupId, connectionId: botId, expectedConnectionRevision: 1, goal: { kind: 'agent-conversation', interaction: 'messages' },
    revision: 3, adapterId: 'feishu', application: record.config.application,
    request: { state: 'confirmed', attemptId: 'preview-sign-in' }, secureStorage: 'stored',
    authentication: { attemptId: 'preview-sign-in', stepId: 'preview-account-confirmed', stage: 'confirmed', request: 'confirmed', secureStorage: 'stored' }
  }
  const calls: Array<{ method: string; input: unknown; actionKind: ConnectionSetupAction['kind'] | null; effect: boolean }> = []
  const reads = new Map<ConnectionSetupReadSubject, ConnectionSetupInspectionReceipt>()
  const effects = new Map<string, ConnectionSetupConfigurationReceipt>()
  const saves = new Map<string, ConnectionOperation>(), serviceSaves = new Map<string, ConnectionServiceOperation>()
  let service = { enabled: false, revision: 1 }, selection: ConnectionSetupConfigurationSelector = { effect: 'enable-messaging' }
  let requestedPermissions = false, latestRead: ConnectionSetupInspectionReceipt | null = null
  const readAction = (subject: Exclude<ConnectionSetupReadSubject, 'publication-version'>): ConnectionSetupInspectionAction => ({
    kind: CONNECTION_SETUP_READ_ACTIONS[subject], actionId: 'preview-read-' + subject + '-' + operation.revision, expectedRevision: operation.revision
  })
  function readReceipt(subject: ConnectionSetupReadSubject) {
    let receipt = reads.get(subject)
    if (!receipt) {
      receipt = { subject, stepId: 'preview-original-' + subject, input: { operationId: setupId, expectedRevision: 2,
        decision: { actionId: 'preview-original-read-' + subject, value: 'continue' } }, request: 'confirmed', secureStorage: 'stored' }
      reads.set(subject, receipt)
    }
    return receipt
  }
  const baseView = (): ConnectionSetupView => ({ operation: structuredClone(operation), challenge: null,
    continuation: { stage: 'confirmed', account: { userId: 'preview-user', tenantId: 'preview-team', userName: 'Alex Chen', tenantName: 'Research and engineering' }, actions: [] } })
  function view(): ConnectionSetupView {
    const value = baseView(), effect = selection.effect, selected = effects.get(effect) ?? null
    const common = { effects: selected ? [selected] : [], next: null, selected, actions: [] }
    let subjects: Array<Exclude<ConnectionSetupReadSubject, 'publication-version'>>
    if (effect === 'add-application-permissions') {
      subjects = ['permission-catalog', 'application-permissions']
      value.applicationConfiguration = { ...common, effect, subject: 'application-permissions', purpose: 'agent-conversation',
        capability: requestedPermissions ? 'enabled' : 'disabled', sources: { catalog: readReceipt('permission-catalog'), applied: readReceipt('application-permissions') },
        review: { permissions: permissions.map(([name, group]) => ({ name, group, state: requestedPermissions ? 'requested' : 'missing' })) },
        actions: requestedPermissions ? [] : [{ kind: effect, actionId: 'setup-permissions:agent-conversation:preview-' + operation.revision, expectedRevision: operation.revision }] }
    } else if (effect === 'create-application-version') {
      subjects = connectionSetupPublicationSubjects(effect).filter((subject): subject is Exclude<typeof subject, 'publication-version'> => subject !== 'publication-version')
      const audience = { include: { all: false, departments: ['engineering'], people: ['preview-user'], groups: ['research-team'] },
        exclude: { all: false, departments: [], people: ['guest-reviewer'], groups: [] } }
      const review: ConnectionSetupPublicationReview = { versions: [], selectedVersion: null,
        changes: [{ category: 'permissions', details: ['Conversation and group permissions'] }, { category: 'events', details: ['Bot message reception'] }],
        audience, proposedAudience: audience, entries: { desktop: { current: 'bot', choices: ['bot'] }, mobile: { current: 'bot', choices: ['bot'] } },
        sharing: { kind: 'split', groups: false, direct: false, directReview: true }, reasonRequired: false, creatorAudienceAvailable: false, issues: [] }
      const draft = selection.draft ?? null
      value.applicationConfiguration = { ...common, effect, subject: 'publication-pending', capability: draft && !selected ? 'disabled' : 'unknown',
        requiredSubjects: subjects, sources: Object.fromEntries(subjects.map(subject => [subject.slice(12), readReceipt(subject)])), draft, review,
        actions: draft && !selected ? [{ kind: effect, actionId: 'setup-publish-create:preview-' + operation.revision, expectedRevision: operation.revision }] : [] }
    } else if (effect === 'enable-messaging' || effect === 'use-persistent-connection' || effect === 'use-persistent-callback' || effect === 'add-card-actions') {
      const subject = effect === 'enable-messaging' ? 'bot-settings' : effect === 'use-persistent-connection' ? 'event-settings' : 'callback-settings'
      subjects = [subject]
      value.applicationConfiguration = { ...common, effect, subject, source: readReceipt(subject), capability: 'disabled',
        actions: [{ kind: effect, actionId: 'preview-effect-' + effect + '-' + operation.revision, expectedRevision: operation.revision }] }
    } else throw new Error('This preview does not cover setup effect ' + effect)
    const selectedRead = latestRead && subjects.includes(latestRead.subject as typeof subjects[number]) ? latestRead : readReceipt(subjects[0]!)
    value.applicationInspection = { observations: subjects.map(readReceipt), next: null, selected: selectedRead,
      applicationInfoReadPermission: 'unknown', actions: subjects.map(readAction) }
    return value
  }
  function offeredAction(input: unknown) {
    const actionId = (input as Partial<ConnectionSetupAdvance>)?.decision?.actionId
    const current = view()
    return [...(current.applicationInspection?.actions ?? []), ...(current.applicationConfiguration?.actions ?? [])].find(action => action.actionId === actionId) ?? null
  }
  const probe = { botId, setupId, calls, credentialWrites: [] as Array<{ operationId: string }>,
    boundary: 'Controlled current public DTOs; real App and Settings owners. No platform, keychain, live Runtime or external messaging.',
    state: () => ({ service: structuredClone(service), records: [...records.values()].map(item => structuredClone(item)), setup: structuredClone(operation) }) }
  api.connections.call = async <M extends ConnectionMethod>(method: M, raw: ConnectionParamsMap[M]): Promise<ConnectionResultMap[M]> => {
    const action = method === 'connection.setup.advance' ? offeredAction(raw) : null
    calls.push({ method, input: structuredClone(raw), actionKind: action?.kind ?? null,
      effect: method === 'connection.configure' || method === 'connection.service.configure' || method === 'connection.delete' || !!action && effectKinds.has(action.kind) })
    const input = parseConnectionParams(method, raw)
    let result: unknown
    if (method === 'connection.ls') result = { connections: [...records.values()] }
    else if (method === 'connection.inspect') {
      const target = input as ConnectionParamsMap['connection.inspect'], saved = target.operationId ? saves.get(target.operationId) ?? null : null
      result = { connection: saved?.connection ?? (target.connectionId ? records.get(target.connectionId) ?? null : null), operation: saved }
    } else if (method === 'connection.configure') {
      const request = input as ConnectionParamsMap['connection.configure']
      const saved: ConnectionOperation = { operationId: request.operationId, status: 'configured', connection: {
        config: request.connection, revision: (request.expectedRevision ?? 0) + 1,
        observation: { authentication: { state: 'unknown', reason: 'not-tested' }, transport: { state: 'unknown', reason: 'not-tested' },
          intake: { state: 'unknown', reason: 'not-tested' }, delivery: { state: 'unknown', reason: 'not-tested' } } } }
      records.set(saved.connection.config.connectionId, saved.connection); saves.set(saved.operationId, saved); result = saved
    } else if (method === 'connection.service.get') result = service
    else if (method === 'connection.service.configure') {
      const request = input as ConnectionParamsMap['connection.service.configure']
      if (request.expectedRevision !== service.revision) throw new Error('Controlled service revision changed')
      service = { enabled: request.service.enabled, revision: service.revision + 1 }
      const saved: ConnectionServiceOperation = { operationId: request.operationId, expectedRevision: request.expectedRevision, status: 'configured', service }
      serviceSaves.set(request.operationId, saved); result = saved
    } else if (method === 'connection.service.inspect') result = { operation: serviceSaves.get((input as ConnectionParamsMap['connection.service.inspect']).operationId) ?? null }
    else if (method === 'connection.enrollment.ls') result = { operations: [], next: null, capabilities: [] }
    else if (method === 'connection.profile.ls') result = { operations: [], next: null }
    else if (method === 'connection.setup.ls') result = { operations: (input as ConnectionParamsMap['connection.setup.ls']).connectionId === botId ? [operation] : [], next: null,
      support: { connectionRevision: 1, capabilities: ['management-authentication', 'application-inspection', 'messaging-capability', 'persistent-event-transport', 'application-permissions', 'card-actions', 'application-publication'] } }
    else if (method === 'connection.setup.inspect') {
      const request = input as ConnectionParamsMap['connection.setup.inspect']
      if (request.operationId !== setupId || request.requestTrace) return original(method, input)
      if (request.applicationConfiguration) selection = request.applicationConfiguration
      result = view()
      if (!request.applicationConfiguration) delete (result as ConnectionSetupView).applicationConfiguration
      if (!request.applicationInspection) delete (result as ConnectionSetupView).applicationInspection
    } else if (method === 'connection.setup.advance') {
      const request = input as ConnectionSetupAdvance
      if (request.operationId !== setupId || request.expectedRevision !== operation.revision || !action) throw new Error('No matching controlled setup action')
      const current = view(), stepId = 'preview-result-' + operation.revision
      operation.revision++
      if (action.kind === 'add-application-permissions' && current.applicationConfiguration?.effect === action.kind) {
        requestedPermissions = true
        effects.set(action.kind, { effect: action.kind, purpose: 'agent-conversation', stepId, input: request, request: 'confirmed', secureStorage: 'stored',
          sourceStepIds: { catalog: current.applicationConfiguration.sources.catalog!.stepId, applied: current.applicationConfiguration.sources.applied!.stepId },
          scopeNames: permissions.map(([name]) => name), requiresDataRangeConfiguration: false })
      } else if (action.kind === 'create-application-version' && current.applicationConfiguration?.effect === action.kind) {
        effects.set(action.kind, { effect: action.kind, stepId, input: request, request: 'confirmed', secureStorage: 'stored',
          sourceStepIds: Object.fromEntries(Object.entries(current.applicationConfiguration.sources).map(([key, value]) => [key, value.stepId])), versionId: 'preview-created-version', submission: null })
      } else {
        const subject = Object.entries(CONNECTION_SETUP_READ_ACTIONS).find(([, kind]) => kind === action.kind)?.[0] as ConnectionSetupReadSubject | undefined
        if (!subject) throw new Error('This preview does not execute that setup effect')
        latestRead = { subject, stepId, input: request, request: 'confirmed', secureStorage: 'stored' }; reads.set(subject, latestRead)
      }
      result = { ...baseView(), receipt: { actionId: action.actionId, stepId, state: 'confirmed' } }
    } else return original(method, input)
    return parseConnectionResult(method, structuredClone(result), input)
  }
  api.connections.inspectCredential = async () => null
  api.connections.storeCredential = async input => {
    probe.credentialWrites.push({ operationId: input.operationId })
    return { operationId: input.operationId, credentialRef: 'preview-explicit-credential' }
  }
  return probe
}
