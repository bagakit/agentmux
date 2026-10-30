import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { parseMoteDialogueIdentity, parseMoteDialogueResult, sameMoteDialogue,
  type MoteDialogueIdentity, type MoteDialogueInputInspection, type MoteMainSnapshot } from '@agentmux/core/mote-dialogue'
import { parseMoteDefaultConversation, parseMotePreferencesTarget, sameMotePreferencesTarget,
  type MoteDefaultConversation, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { AgentInputSubmit } from '@agentmux/core'

/** Original user navigation and observed role facts, never client-owned main authority. */
export type MobileMoteMainInput = { target: MotePreferencesTarget; identity: MoteDialogueIdentity; expectedRoleRevision: string; reference: MoteDefaultConversation }
function failure(message: string): never { throw Object.assign(new Error(message), { code: 'MOTE_MAIN_INPUT_UNCONFIRMED' }) }
export function parseMobileMoteMainInput(value: unknown): MobileMoteMainInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure('原主对话输入来源未能核实；原请求和草稿保留。')
  const p = value as Record<string, unknown>
  if (Object.keys(p).length !== 4 || !['target', 'identity', 'expectedRoleRevision', 'reference'].every(key => Object.hasOwn(p, key)) ||
    typeof p.expectedRoleRevision !== 'string' || !p.expectedRoleRevision.trim() || /[\0\r\n]/u.test(p.expectedRoleRevision)) return failure('原主角色修订未能核实；原请求保留。')
  const target = parseMotePreferencesTarget(p.target), identity = parseMoteDialogueIdentity(p.identity), reference = parseMoteDefaultConversation(p.reference)
  if (identity.hostId !== target.expectedResource.hostId) return failure('主对话与原资料不属于同一执行端；原引用保留。')
  return structuredClone({ target, identity, reference, expectedRoleRevision: p.expectedRoleRevision })
}
export function observedMobileMoteMain(snapshot: MoteMainSnapshot | undefined, target: MotePreferencesTarget | undefined,
  agentSessionId: string | null): MobileMoteMainInput | undefined {
  if (!agentSessionId || !snapshot?.identity || !snapshot.current || !snapshot.roleRevision || !target || !sameMotePreferencesTarget(target, snapshot.target) || snapshot.current.sessionId !== agentSessionId) return
  // The input producer verifies the exact typed Host/SID before intake. A known
  // wrong Host cannot turn this logical-main request into a generic Agent send.
  return parseMobileMoteMainInput({ target, identity: snapshot.identity, expectedRoleRevision: snapshot.roleRevision, reference: snapshot.current })
}
/** Missing or changed observations cannot rewrite an already selected Discussion
 * as a direct Agent intent. Core still qualifies this original role at intake. */
export function retainMobileMoteMain(previous: MobileMoteMainInput | undefined, snapshot: MoteMainSnapshot | undefined,
  target: MotePreferencesTarget | undefined, agentSessionId: string | null): MobileMoteMainInput | undefined {
  return observedMobileMoteMain(snapshot, target, agentSessionId) ?? (previous && target &&
    sameMotePreferencesTarget(previous.target, target) && previous.reference.sessionId === agentSessionId ? previous : undefined)
}
/** A known new Main cannot silently turn a logical Discussion input into a generic old-Agent send. */
export function mobileMoteMainInputIssue(snapshot: MoteMainSnapshot | undefined, target: MotePreferencesTarget | undefined,
  agentSessionId: string | null, unavailable: boolean): string | undefined {
  if (!target || !agentSessionId || unavailable || snapshot?.status !== 'ready' || !sameMotePreferencesTarget(target, snapshot.target)) return
  if (!snapshot.current || snapshot.current.sessionId !== agentSessionId)
    return '主 Agent 已更换或解除绑定。原正文和草稿保留；返回当前主对话，或从 Threads 明确选择原 Agent 继续。'
}
function originalInspection(value: MoteDialogueInputInspection, source: MobileMoteMainInput, input: { operationId: string; agentSessionId: string; expectedRun: { runId: string } }) {
  const route = value.route
  if (!route) return value
  if (!sameMoteDialogue(route.identity, source.identity) || route.roleRevision !== source.expectedRoleRevision ||
    route.operationId !== input.operationId || route.key.kind !== 'prompt' || route.key.agentSessionId !== input.agentSessionId || route.key.expectedRun.runId !== input.expectedRun.runId ||
    Object.keys(source.reference).some(key => source.reference[key as keyof MoteDefaultConversation] !== route.reference[key as keyof MoteDefaultConversation])) {
    return failure('回执不属于这条原主对话输入；原请求保留，没有改投。')
  }
  return value
}
export async function submitMobileMoteMain(client: AgentMuxHostedClient, source: MobileMoteMainInput, input: Parameters<AgentMuxHostedClient['submitAgentPrompt']>[0]) {
  if (!client.forwardRpc) return failure('原主对话输入端口暂不可用；原请求和草稿保留。')
  const { authorHuman: _human, agentMuxNote: _note, ...original } = input
  const params = { target: source.target, expectedRoleRevision: source.expectedRoleRevision, input: { ...original, moteGuidance: true as const } as AgentInputSubmit }
  const result = parseMoteDialogueResult('space.mote.dialogue.input.submit', await client.forwardRpc('space.mote.dialogue.input.submit', params), params)
  return originalInspection(result, source, input)
}
export async function inspectMobileMoteMain(client: AgentMuxHostedClient, source: MobileMoteMainInput,
  input: { operationId: string; agentSessionId: string; expectedRun: { runId: string } }) {
  if (!client.forwardRpc) return failure('原主对话核对端口暂不可用；原请求保留。')
  const params = { target: source.target, operationId: input.operationId }
  return originalInspection(parseMoteDialogueResult('space.mote.dialogue.input.inspect', await client.forwardRpc('space.mote.dialogue.input.inspect', params), params), source, input)
}
