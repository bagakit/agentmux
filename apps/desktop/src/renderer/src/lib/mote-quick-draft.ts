import { parseMotePreferencesSaveParams, parseMoteQuickDefaults, type MoteQuickDefaults, type MoteQuickPreferencesSaveParams } from '@agentmux/core/mote-preferences'

/** Client input custody only. The original preference/schedule owner supplies results. */
export type MoteQuickDraft = {
  draft: MoteQuickDefaults
  minutes: string
  rolloverKind: 'keep-current' | 'idle'
  rolloverMinutes: string
  pending?: { input: MoteQuickPreferencesSaveParams; phase: 'not-dispatched' | 'may-have-dispatched' }
  resume?: { ownerHostId: string; scheduleId: string; expectedRevision: number; operationId: string }
}
export function restoredMoteQuickDraft(value: unknown): MoteQuickDraft | undefined {
  try {
    if (!value || typeof value !== 'object') return
    const p = value as MoteQuickDraft, draft = parseMoteQuickDefaults(p.draft)
    if (typeof p.minutes !== 'string' || typeof p.rolloverMinutes !== 'string' || !['keep-current', 'idle'].includes(p.rolloverKind)) return
    const input = p.pending ? parseMotePreferencesSaveParams(p.pending.input) : undefined
    if (input && input.kind !== 'quick') return
    const resume = p.resume
    if (resume && ([resume.ownerHostId, resume.scheduleId, resume.operationId].some(value => typeof value !== 'string' || !value.trim()) || !Number.isSafeInteger(resume.expectedRevision) || resume.expectedRevision < 1)) return
    return { draft, minutes: p.minutes, rolloverKind: p.rolloverKind, rolloverMinutes: p.rolloverMinutes,
      ...(input ? { pending: { input: input as MoteQuickPreferencesSaveParams, phase: p.pending?.phase === 'not-dispatched' ? 'not-dispatched' : 'may-have-dispatched' } } : {}),
      ...(resume ? { resume: structuredClone(resume) } : {}) }
  } catch { return undefined }
}
