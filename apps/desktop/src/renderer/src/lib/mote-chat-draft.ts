import { parseMoteChatValues, type MoteChatTarget, type MoteChatValues } from '@agentmux/core/mote-chat'
import { parseMoteConnectionValues, parseMotePreferencesTarget, type MoteConnectionRef } from '@agentmux/core/mote-preferences'
import { parseConnectionActor, type ConnectionActor } from '@agentmux/core/connections'
import { isObjectId } from '@agentmux/core/object-id'
import { readConnectionHostingTarget } from '../../../shared/connection-hosting-target'
import type { ConnectionHostingTarget } from '../../../shared/contracts'

/** Private editable input only. Core owns saved policy, identity, quota and receipts. */
export type MoteChatDraft = { target: MoteChatTarget; hostingTarget: ConnectionHostingTarget | null; version: string; issue: string } & (
  | { kind: 'policy'; values: MoteChatValues; minutes: string; strangers: string }
  | { kind: 'allowance'; connection: MoteConnectionRef | null; actor: ConnectionActor; total: string }
)
export function moteChatDraftKey(draft: Pick<MoteChatDraft, 'target' | 'hostingTarget'> & ({ kind: 'policy' } | { kind: 'allowance'; connection: MoteConnectionRef | null; actor: ConnectionActor })): string {
  const target = parseMotePreferencesTarget(draft.target), owner = draft.hostingTarget
  return 'mote-chat:' + JSON.stringify([target, owner ? [owner.hostId, owner.runtimeId] : null, draft.kind,
    ...(draft.kind === 'allowance' ? [parseMoteConnectionValues({ connection: draft.connection }).connection, parseConnectionActor(draft.actor)] : [])])
}
export function restoredMoteChatDraft(value: unknown, expectedKey?: string): MoteChatDraft | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const p = value as MoteChatDraft, fields = ['kind', 'target', 'hostingTarget', 'version', 'issue', ...(p.kind === 'policy' ? ['values', 'minutes', 'strangers'] : ['connection', 'actor', 'total'])]
    if (Object.keys(p).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(p, key)) || !isObjectId(p.version) || typeof p.issue !== 'string') return
    const target = parseMotePreferencesTarget(p.target), hostingTarget = p.hostingTarget === null ? null : readConnectionHostingTarget(p.hostingTarget)
    if (hostingTarget === undefined) return
    const base = { target, hostingTarget, version: p.version, issue: p.issue }
    if (p.kind === 'policy') {
      // A partial form may have enabled checked before a bot is chosen. This is
      // editable input, never an enabled configuration or an authority grant.
      if (!p.values || typeof p.values.enabled !== 'boolean' || typeof p.minutes !== 'string' || typeof p.strangers !== 'string') return
      const result: MoteChatDraft = { ...base, kind: 'policy', values: { ...parseMoteChatValues({ ...p.values, enabled: false }), enabled: p.values.enabled }, minutes: p.minutes, strangers: p.strangers }
      return expectedKey === undefined || moteChatDraftKey(result) === expectedKey ? result : undefined
    }
    if (p.kind !== 'allowance' || !hostingTarget || typeof p.total !== 'string') return
    const connection = parseMoteConnectionValues({ connection: p.connection }).connection
    const result: MoteChatDraft = { ...base, hostingTarget, kind: 'allowance', connection, actor: parseConnectionActor(p.actor), total: p.total }
    return expectedKey === undefined || moteChatDraftKey(result) === expectedKey ? result : undefined
  } catch { return undefined }
}
