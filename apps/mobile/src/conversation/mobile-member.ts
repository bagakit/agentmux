import type { MobileMemberSelection } from '../navigation/mobile-member-target'
import { useCallback, useEffect, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { connectSpaceMember, type SpaceMemberClient } from '@agentmux/core/space-member-client'
import { parseSpaceMemberParams, parseSpaceMemberRoute } from '@agentmux/core/space-member-codec'
import { SPACE_MEMBER_NATIVE_CALLS, SPACE_MEMBER_NATIVE_SESSION_CALLS } from '@agentmux/core/space-member'
import { parseFileUploadIdentity } from '@agentmux/core/files'
import type { AgentMuxRpcResult } from '@agentmux/core'
import type { MobileConversationClient } from './mobile-conversation-client'

const readingMethods = ['readAgentInputEpoch', 'readAgentConversation', 'conversationCheckpoint', 'readConversationChanges',
  'releaseConversationView', 'observeConversation', 'readAgentSessionHistory', 'sessionHistoryResource', 'readAgentInputMailbox'] as const
const controlMethods = ['connect', 'agentSession', 'agentSessions', 'catalog', 'onEvent', 'runtimeOwnerIdentity', 'statusAgent',
  'readAgentSession', 'submitAgentPrompt', 'inspectAgentInput', 'inspectAgentPromptSubmission', 'stopAgentInputWaiting',
  'rejoinAgentInputWaiting', 'inspectAgentInteractionOperation', 'signalAgent', 'runtimeIdentity', 'reattachAgent',
  'readRunReplay', 'releaseRunAttachment', 'writeAgent'] as const satisfies readonly (keyof SpaceMemberClient)[]

export async function connectMobileMember(source: AgentMuxHostedClient, selection: MobileMemberSelection): Promise<{ client: MobileConversationClient; issue?: string }> {
  if (!selection.target || !source.forwardRpc) throw Error(selection.issue ?? '原成员的传输尚未确认，原对话和草稿保持不变。')
  const owner = source.runtimeOwnerIdentity?.()
  if (owner && owner.runtimeId !== selection.sourceRuntimeId) throw Error('当前连接不是原 Source；原成员引用和草稿保持不变。')
  const rpc = { call: source.forwardRpc.bind(source), subscribe: async (...args: Parameters<NonNullable<AgentMuxHostedClient['subscribeRpc']>>) => {
    if (!source.subscribeRpc) throw Error('原 Source 尚未提供成员观察，原阅读仍可重试。')
    return source.subscribeRpc(...args)
  } }
  const target = parseSpaceMemberRoute(selection.target)
  if (!target.expectedAdmission) throw Error('原成员的 C/L 尚未确认。')
  const identity = { reference: target.reference, regionId: target.regionId, runtimeId: target.runtimeId,
    agentSessionId: target.agentSessionId, expectedAdmission: target.expectedAdmission }
  const reading = await connectSpaceMember(rpc, { ...identity, kind: 'conversation', expectedAdmission: target.expectedAdmission })
  const control = 'expectedRun' in target ? await connectSpaceMember(rpc, target) : undefined
  const client: MobileConversationClient = { ...Object.fromEntries(readingMethods.map(key => [key, reading[key].bind(reading)])),
    dispose: async () => { await Promise.all([reading.dispose(), control?.dispose()]) } } as Pick<MobileConversationClient, typeof readingMethods[number] | 'dispose'>
  client.forwardRpc = async (method, params, context, expectedOwner) => {
    if (!(SPACE_MEMBER_NATIVE_CALLS as readonly string[]).includes(method) || expectedOwner !== undefined) throw Object.assign(new Error(
      '原成员尚未提供这项准确操作；原目标、对话和草稿保持不变。'), { code: 'CONTROL_PERMISSION_DENIED' })
    const nativeTarget = method === 'file.upload.inspect'
      ? { ...identity, expectedRun: parseFileUploadIdentity(params).expectedRun }
      : (SPACE_MEMBER_NATIVE_SESSION_CALLS as readonly string[]).includes(method)
        ? { ...identity, kind: 'session' as const, expectedAdmission: target.expectedAdmission! }
        : method === 'file.upload' ? target : { ...identity, kind: 'conversation' as const, expectedAdmission: target.expectedAdmission! }
    const packet = parseSpaceMemberParams('space.member.call', { target: nativeTarget, call: { method, params } })
    return await rpc.call('space.member.call', packet, context?.signal ? { signal: context.signal } : {}) as AgentMuxRpcResult<typeof method>
  }
  client.readMessage = (async input => {
    if (input.caller || input.participantSessionId !== undefined && input.participantSessionId !== target.agentSessionId ||
        input.participantRuntimeId !== undefined && input.participantRuntimeId !== target.runtimeId) throw Object.assign(new Error(
      '消息读取必须属于原成员，原引用保持不变。'), { code: 'SPACE_MEMBER_TARGET_MISMATCH' })
    const result = await client.forwardRpc!('message.read', { ...input, hostId: 'local',
      participantSessionId: target.agentSessionId, participantRuntimeId: target.runtimeId })
    return input.field === undefined ? result.message : result.field ?? null
  }) as NonNullable<MobileConversationClient['readMessage']>
  if (control) {
    for (const key of controlMethods) Object.assign(client, { [key]: control[key].bind(control) })
    Object.assign(client, { providers: control.providers })
    const original = control
    client.resizeAgent = async (id, run, cols, rows) => {
      if (id !== target.agentSessionId) throw Error('终端大小请求不属于原成员，未改动其他对话。')
      return await original.resizeTerminal(run, cols, rows)
    }
  }
  return { client }
}

export function useMobileMember(source: AgentMuxHostedClient | null, selection: MobileMemberSelection | undefined, expectedSessionId?: string | null): { client: MobileConversationClient | null; issue?: string | undefined; retry: (() => void) | undefined } {
  const [attempt, setAttempt] = useState(0), retry = useCallback(() => setAttempt(value => value + 1), [])
  const mismatched = !!selection?.target && expectedSessionId !== undefined && selection.target.agentSessionId !== expectedSessionId
  const key = JSON.stringify([selection, expectedSessionId]), [state, setState] = useState<{ source: typeof source; key: string; client: MobileConversationClient | null; issue?: string }>()
  useEffect(() => {
    if (!selection || !source || mismatched) return
    let live = true, acquired: MobileConversationClient | undefined
    void connectMobileMember(source, selection).then(value => {
      acquired = value.client
      if (!live) { void value.client.dispose(); return }
      setState({ source, key, ...value })
      // This SDK owns its cache and event lease. Observation is independent of
      // exact reads/input: a failed opening keeps this original client usable.
      void value.client.connect?.().catch(error => {
        if (live) setState({ source, key, client: value.client, issue: error instanceof Error ? error.message : String(error) })
      })
    }).catch(error => { if (live) setState({ source, key, client: null, issue: error instanceof Error ? error.message : String(error) }) })
    return () => { live = false; void acquired?.dispose() }
  }, [source, key, attempt])
  if (mismatched) return { client: null, issue: '当前选择与原成员引用不一致；原引用和草稿保持不变。', retry }
  return selection ? { ...(state?.source === source && state.key === key ? state : { client: null, issue: selection.issue }), retry }
    : { client: source, retry: undefined }
}
