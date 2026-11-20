import { AgentMuxError } from '../errors.js'
import { rpcRecord } from '../rpc-data.js'
import { parseMotePreferencesTarget, type MotePreferencesTarget } from './preferences.js'
import type { ScheduleParamsMap, ScheduleResultMap } from '../public-rpc-schedules.js'

/** An authorized assignment follows the coordinating Mote, independently of Main rotation. */
export type MoteScheduledRecipient = { moteId: string; generation: string }
export type MoteScheduledWork = { mote: MotePreferencesTarget } & (
  { kind: 'direct'; peer: MotePreferencesTarget } |
  { kind: 'group'; groupId: string; recipients: MoteScheduledRecipient[] })

export type MoteScheduleContext = {
  schedule(input: ScheduleParamsMap['schedule.create'], work?: MoteScheduledWork): Promise<ScheduleResultMap['schedule.create']>
  readSchedule(input: ScheduleParamsMap['schedule.inspect']): Promise<ScheduleResultMap['schedule.inspect']>
}

export function parseMoteScheduledWork(value: unknown): MoteScheduledWork {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const invalid = (): never => { throw new AgentMuxError('The original Mote assignment audience is invalid.', code) }
  const entry = rpcRecord(value, ['kind', 'mote', 'peer', 'groupId', 'recipients'], code)
  const mote = parseMotePreferencesTarget(entry.mote, code)
  if (entry.kind === 'direct') {
    const peer = parseMotePreferencesTarget(entry.peer, code)
    if (mote.spaceId === peer.spaceId || entry.groupId !== undefined || entry.recipients !== undefined) return invalid()
    return { kind: entry.kind, mote, peer }
  }
  const id = (input: unknown) => typeof input === 'string' && input.length > 0 && input.length <= 512 && !/[\0\r\n]/u.test(input) ? input : invalid()
  if (entry.kind !== 'group' || entry.peer !== undefined || !Array.isArray(entry.recipients) || entry.recipients.length < 1 || entry.recipients.length > 32) return invalid()
  const recipients = Array.from(entry.recipients, value => {
    const member = rpcRecord(value, ['moteId', 'generation'], code)
    return { moteId: id(member.moteId), generation: id(member.generation) }
  })
  if (recipients.some(recipient => recipient.moteId === mote.spaceId) || new Set(recipients.map(recipient => recipient.moteId)).size !== recipients.length) return invalid()
  return { kind: entry.kind, mote, groupId: id(entry.groupId), recipients }
}
