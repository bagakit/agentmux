import { parseSpaceMemberRoute } from '@agentmux/core/space-member-codec'
import { spaceMountMemberCallHasReceipt } from '../shared/space-mount'
import { parseHostRouteAgentTarget } from '@agentmux/core/host-route'
import { parseAgentOpenDescribe } from '@agentmux/core/agent-open-contract'
import { parseNameControlParams } from '@agentmux/core/name-control'
import type { AppConfig } from '../shared/contracts.js'
import type { IpcMainInvokeEvent } from 'electron'
import { sourceWorkbenchClosePort, parseSourceWorkbenchCloseMember } from './source-workbench-close'
import { parseSpaceCloseParams } from '@agentmux/core/space-close'
import { parseFolderSpaceRegistration, parseFolderSpaceRegisterInput } from '@agentmux/core/space-folder'
import { parseAgentExecutionReference, parseSpaceAuthorityRef, parseSpaceAuthorityParams, rpcControlRequest } from '@agentmux/core'
import type { RuntimeController } from './runtime-controller.js'
import { SessionHistoryReadOwners } from './session-history-read.js'
import { sessionInputOperationResult } from '../shared/session-input-result.js'
import { SPACE_MOUNT_EVENT, SPACE_MOUNT_SESSIONS_EVENT, SPACE_MOUNT_MEMBER_EVENT, type SpaceMountWatch, type SpaceMountMemberSurface, type SpaceMountMemberMethods } from '../shared/space-mount.js'

export function fields(input: unknown, allowed: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Use the exact original Space mount request.')
  return input as Record<string, unknown>
}
function host(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Choose the original configured Space Host.')
  return value
}
export function sourceTarget(p: Record<string, unknown>): import('../shared/space-mount.js').SpaceMountSourceTarget {
  if (p.reference !== undefined && p.expectedRuntimeId !== undefined) throw new Error('Choose one exact original Source address.')
  return p.expectedRuntimeId === undefined ? { hostId: host(p.hostId), reference: parseSpaceAuthorityRef(p.reference) }
    : { hostId: host(p.hostId), expectedRuntimeId: host(p.expectedRuntimeId) }
}
/** Trusted App frame and reader custody only; all business writes return to the original Core. */
export function registerSpaceMountIpc(ports: {
  handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...values: T) => R | Promise<R>): void
  config?(): AppConfig
  runtime: Pick<RuntimeController, 'callOriginalCore' | 'subscribeOriginalCore' | 'openMountedSpaceMember' | 'spaceMountResources' | 'describeMountedSpace' | 'mountedSpaceHostChoices' | 'mountedSpaceRouteChoices' | 'mountedSpaceRouteExecutors' | 'registerFolderSpace' | 'inspectFolderSpace' | 'readMountedSpace' | 'applyMountedSpace' | 'watchMountedSpace' | 'mountedSpaceExecutors' | 'openMountedSpace' | 'inspectMountedSpaceRequest' | 'continueMountedSpaceExecution' | 'watchMountedSpaceSessions' | 'inspectMountedMemberName' | 'changeMountedMemberName' | 'inspectOriginalAgentName' | 'changeOriginalAgentName'>
}) {
  const reads = new SessionHistoryReadOwners()
  const close = sourceWorkbenchClosePort(ports.runtime)
  const members = new Map<string, SpaceMountMemberSurface>()
  ports.handle('spaceMounts:call', (event, token: string, method: unknown, value: unknown) => sessionInputOperationResult(async () => {
    if (method === 'close' || method === 'closeLocations') {
      const p = fields(value, method === 'closeLocations' ? ['hostId', 'reference', 'member'] : ['hostId', 'reference', 'method', 'request', 'member'])
      const destination = { hostId: host(p.hostId), reference: parseSpaceAuthorityRef(p.reference) }
      let obtained: import('../shared/source-workbench-close').SourceWorkbenchCloseResult | undefined
      try { return await reads.read(event.sender, token, async signal => {
        const actor = { kind: 'user' as const, id: `local-user:${process.getuid?.() ?? 'current'}` }
        const context = { principal: actor, transport: 'unix' as const, signal }
        if (method === 'closeLocations') return await close.locations(destination, parseSourceWorkbenchCloseMember(p.member), context)
        if (p.method === 'space.close.prepare') return obtained = await close.call({ ...destination, method: p.method, request: parseSpaceCloseParams(p.method, p.request), member: parseSourceWorkbenchCloseMember(p.member) }, context)
        if (p.method === 'space.close.apply' || p.method === 'space.close.inspect') return obtained = await close.call({ ...destination, method: p.method, request: parseSpaceCloseParams(p.method, p.request) } as import('../shared/source-workbench-close').SourceWorkbenchCloseCall, context)
        throw new Error('Choose an original workface close operation.')
      }) } catch (cause) { if (obtained) return obtained; throw cause }
    }
    if (method === 'register') {
      const p = fields(value, ['hostId', 'registration']), originalHost = host(p.hostId), packet = structuredClone(parseFolderSpaceRegisterInput(p.registration))
      let obtained: Awaited<ReturnType<RuntimeController['registerFolderSpace']>> | undefined
      try { return await reads.read(event.sender, token, async signal => obtained = await ports.runtime.registerFolderSpace(originalHost, packet, signal)) }
      catch (cause) { if (obtained) return obtained; throw cause }
    }
    return await reads.read(event.sender, token, async signal => {
    if (method === 'resources') { const p = fields(value, ['hostId']); return await ports.runtime.spaceMountResources(host(p.hostId), signal) }
    if (method === 'memberNameInspect' || method === 'memberNameChange') {
      const p = fields(value, ['hostId', 'reference', 'name']), target = { hostId: host(p.hostId), reference: parseSpaceAuthorityRef(p.reference) }
      return method === 'memberNameInspect' ? await ports.runtime.inspectMountedMemberName(target, parseNameControlParams('space.member.name.inspect', p.name), signal)
        : await ports.runtime.changeMountedMemberName(target, parseNameControlParams('space.member.name.change', p.name), signal)
    }
    if (method === 'agentNameInspect' || method === 'agentNameChange') {
      const p = fields(value, ['hostId', 'expectedRuntimeId', 'name']), target = { hostId: host(p.hostId), expectedRuntimeId: host(p.expectedRuntimeId) }
      return method === 'agentNameInspect' ? await ports.runtime.inspectOriginalAgentName(target, parseNameControlParams('agent.name.inspect', p.name), signal)
        : await ports.runtime.changeOriginalAgentName(target, parseNameControlParams('agent.name.change', p.name), signal)
    }
    if (method === 'describe') {
      const p = fields(value, ['hostId', 'reference', 'expectedRuntimeId', 'execution', 'executionOnly']), target = sourceTarget(p)
      const input = parseAgentOpenDescribe({ expectedRuntimeId: 'expectedRuntimeId' in target ? target.expectedRuntimeId : target.reference.runtimeId,
        ...(p.execution === undefined ? {} : { execution: p.execution }), ...(p.executionOnly === undefined ? {} : { executionOnly: p.executionOnly }) })
      return await ports.runtime.describeMountedSpace(target, signal, { ...(input.execution === undefined ? {} : { execution: input.execution }), ...(input.executionOnly === undefined ? {} : { executionOnly: input.executionOnly }) })
    }
    if (method === 'hostChoices') { const p = fields(value, ['hostId', 'reference', 'expectedRuntimeId']); return await ports.runtime.mountedSpaceHostChoices(sourceTarget(p),signal) }
    if (method === 'routeChoices' || method === 'routeExecutors') {
      const p = fields(value, ['hostId', 'reference', 'expectedRuntimeId', ...(method === 'routeExecutors' ? ['agentTarget', 'executorId'] : [])])
      const target = sourceTarget(p)
      return method === 'routeChoices' ? await ports.runtime.mountedSpaceRouteChoices(target, signal)
        : await ports.runtime.mountedSpaceRouteExecutors(target, parseHostRouteAgentTarget(p.agentTarget), signal, p.executorId === undefined ? undefined : host(p.executorId))
    }
    if (method === 'inspectRegistration') { const p = fields(value, ['hostId', 'registration']); return await ports.runtime.inspectFolderSpace(host(p.hostId), parseFolderSpaceRegistration(p.registration), signal) }
    if (method === 'snapshot' || method === 'apply') {
      const p = fields(value, method === 'snapshot' ? ['hostId', 'reference'] : ['hostId', 'reference', 'edit'])
      const target = { hostId: host(p.hostId), reference: parseSpaceAuthorityRef(p.reference) }
      return method === 'snapshot' ? await ports.runtime.readMountedSpace(target, signal)
        : await ports.runtime.applyMountedSpace(target, parseSpaceAuthorityParams('space.apply', p.edit), signal)
    }
    if (method === 'executors') { const p = fields(value, ['hostId', 'reference', 'expectedRuntimeId', 'agentHostId', 'executorId']);
      return await ports.runtime.mountedSpaceExecutors(sourceTarget(p), host(p.agentHostId), signal, p.executorId === undefined ? undefined : host(p.executorId)) }
    if (method === 'continueExecution') {
      const p = fields(value, ['hostId', 'reference', 'execution'])
      return await ports.runtime.continueMountedSpaceExecution({ hostId: host(p.hostId), reference: parseSpaceAuthorityRef(p.reference) }, parseAgentExecutionReference(p.execution), signal)
    }
    if (method === 'open' || method === 'inspect') {
      const p = fields(value, ['hostId', 'reference', ...(method === 'open' ? ['request'] : ['requestId'])])
      const target = { hostId: host(p.hostId), reference: parseSpaceAuthorityRef(p.reference) }
      if (method === 'inspect') return await ports.runtime.inspectMountedSpaceRequest(target, host(p.requestId), signal)
      const parsed = rpcControlRequest('agent.open', p.request)
      if (parsed.operation !== 'agent.open') throw new Error('Use the original Agent creation request.')
      return await ports.runtime.openMountedSpace(target, { operationId: parsed.requestId, content: parsed.content, destination: parsed.destination,
        focus: parsed.focus, ...(parsed.moteMain ? { moteMain: parsed.moteMain } : {}) }, signal)
    }
    throw new Error('Unknown fixed Space mount operation.')
    })
  }))
  ports.handle('spaceMounts:cancel', (event, token: string) => reads.cancel(event.sender.id, token))
  function reader<I, E extends { type: string }>(event: IpcMainInvokeEvent, token: string, eventChannel: string,
    open: (signal: AbortSignal, listener: (observation: E) => void) => Promise<{ initial: I; dispose(): unknown | Promise<unknown> }>) {
    return sessionInputOperationResult(() => new Promise<I>((resolve, reject) => {
      let opened = false, ended = false, finish: (() => void) | undefined
      void reads.read(event.sender, token, async signal => {
        const observed = await open(signal, observation => {
          if (!signal.aborted && !event.sender.isDestroyed()) event.sender.send(eventChannel, { token, observation })
          if (observation.type === 'error') { ended = true; finish?.() }
        })
        try {
          signal.throwIfAborted(); opened = true; resolve(observed.initial)
          await new Promise<void>(done => {
            finish = () => done()
            if (ended || signal.aborted) done()
            else signal.addEventListener('abort', finish, { once: true })
          })
        } finally { if (finish) signal.removeEventListener('abort', finish); await observed.dispose() }
      }).catch(error => {
        if (!opened) reject(error)
        else if (!event.sender.isDestroyed()) event.sender.send(eventChannel, { token, observation: { type: 'error', error: { code: 'SPACE_OBSERVATION_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } } })
      })
    }))
  }
  ports.handle('spaceMounts:watch', (event, token: string, value: unknown) => reader(event, token, SPACE_MOUNT_EVENT, async (signal, listener) => {
    const p = fields(value, ['hostId', 'reference', 'after']), input: SpaceMountWatch = { hostId: host(p.hostId), ...parseSpaceAuthorityParams('space.watch', { reference: p.reference, ...(p.after === undefined ? {} : { after: p.after }) }) }
    return await ports.runtime.watchMountedSpace(input, listener, signal)
  }))
  ports.handle('spaceMounts:sessions', (event, token: string, value: unknown) => reader(event, token, SPACE_MOUNT_SESSIONS_EVENT, async (signal, listener) => {
    const p = fields(value, ['hostId', 'reference'])
    return await ports.runtime.watchMountedSpaceSessions({ hostId: host(p.hostId), reference: parseSpaceAuthorityRef(p.reference) }, listener, signal)
  }))
  ports.handle('spaceMounts:member', (event, token: string, value: unknown) => reader(event, token, SPACE_MOUNT_MEMBER_EVENT, async (signal, listener) => {
    const p = fields(value, ['hostId', 'target'])
    if (!ports.config) throw new Error('The original App configuration owner is unavailable for this member presentation.')
    const surface = await ports.runtime.openMountedSpaceMember({ hostId: host(p.hostId), target: parseSpaceMemberRoute(p.target) }, ports.config(), listener, signal)
    const key = `${event.sender.id}:${token}`; members.set(key, surface); surface.start()
    return { initial: surface.initial, dispose: async () => { if (members.get(key) === surface) members.delete(key); await surface.dispose() } }
  }))
  const memberFields: { [M in keyof SpaceMountMemberMethods]: string[] } = {
    retainImage: ['bytes', 'mimeType'], 'file.upload.inspect': ['hostId', 'agentSessionId', 'expectedRun', 'operationId', 'name', 'mimeType', 'byteLength', 'revision'],
    inputEpoch: [],
    'agent.progress.list': ['target', 'operationId'],
    'agent.progress.create': ['target', 'intervalMs', 'prompt', 'taskSource', 'operationId', 'inputEpoch'],
    'agent.progress.action': ['target', 'loopId', 'action', 'expectedLoop', 'operationId'],
    'agent.progress.update': ['target', 'loopId', 'expectedLoop', 'intervalMs', 'prompt', 'operationId'],
    history: ['input'], historyResource: ['input'], inputMailbox: ['input'], skills: [],
    read: [], attach: ['afterByte'], refreshAttachment: ['attachmentId','afterByte'], replay: ['attachmentId','afterByte'], detach: ['attachmentId'],
    conversationRead: ['input'], conversationCheckpoint: ['input'], conversationChanges: ['input'], conversationRelease: ['view'], conversationWatch: ['view'], conversationUnwatch: ['readerId'],
    resize: ['attachmentId','cols','rows'], write: ['data','source','observation'], paste: ['text','terminalData','observation'],
    inspectInteraction: ['operationId']
  }
  ports.handle('spaceMounts:memberCall', (event, token: string, memberToken: string, method: unknown, value: unknown) => sessionInputOperationResult(async () => {
    let obtained: SpaceMountMemberMethods[keyof SpaceMountMemberMethods]['result'] | undefined
    try { return await reads.read(event.sender, token, async signal => {
    if (typeof method !== 'string' || !Object.hasOwn(memberFields, method)) throw new Error('Unknown fixed original member operation.')
    const surface = members.get(`${event.sender.id}:${memberToken}`)
    if (!surface) throw new Error('This original member view is closed. Its Session and input are retained.')
    const original = method as keyof SpaceMountMemberMethods
    const result = await surface.call(original, fields(value, memberFields[original]) as SpaceMountMemberMethods[typeof original]['input'], signal)
    if (spaceMountMemberCallHasReceipt(original)) obtained = result
    return result
    }) } catch (cause) { if (obtained !== undefined) return obtained; throw cause }
  }))
  return { dispose: () => reads.dispose() }
}
