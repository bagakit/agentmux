import { AgentMuxError } from '@agentmux/core'
import { scheduleHistoryPageSize, type MoteWorkPublication, type ScheduleHistoryQuery, type ScheduleHistoryReading } from '@agentmux/core/schedule-rpc'

export async function readMotePublicationHistory(
  query: ScheduleHistoryQuery,
  read: (before: number, limit: number) => Promise<MoteWorkPublication[]>,
  latest?: MoteWorkPublication
): Promise<ScheduleHistoryReading> {
  const scope = JSON.stringify([query.scheduleId, query.from, query.to])
  let before = query.to
  if (query.cursor) {
    const decoded = Buffer.from(query.cursor, 'base64url').toString('utf8')
    const separator = decoded.lastIndexOf('\n')
    before = Number(decoded.slice(separator + 1))
    if (decoded.slice(0, separator) !== scope || !Number.isSafeInteger(before) ||
      before <= query.from || before >= query.to)
      throw new AgentMuxError('Use the cursor from this original schedule window.', 'INVALID_CONTROL_REQUEST')
  }
  const limit = scheduleHistoryPageSize(query)
  const rows = await read(before, limit + 1)
  if (latest && latest.occurrenceAt >= query.from && latest.occurrenceAt < before &&
    !rows.some(row => row.occurrenceAt === latest.occurrenceAt)) rows.push(latest)
  rows.sort((a, b) => b.occurrenceAt - a.occurrenceAt)
  const publications = rows.slice(0, limit)
  return { coverage: 'recorded-publications', publications, entries: [],
    nextCursor: rows.length > limit ? Buffer.from(scope + '\n' + publications.at(-1)!.occurrenceAt).toString('base64url') : null }
}
