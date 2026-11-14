import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import source from './mote-initialization.config.mts'

const mutations: Record<string, { file: string; before: string; after: string }> = {
  'drop-notice-producer': { file: 'GlobalSystemNotices.tsx', before: 'const item = moteHeartbeatNotice(source)', after: 'const item = null' },
  'read-clears-current': { file: 'GlobalSystemNotices.tsx', before: "append(moteInbox, 'operations', item => {", after: "if (moteInbox.unread.length) append(moteInbox, 'operations', item => {" },
  'forget-episode': { file: 'mote-heartbeat-notice.ts', before: 'source.target, schedule.loopId, pause.episodeId', after: 'source.target, schedule.loopId' },
  'prefixed-read-key': { file: 'mote-heartbeat-notice.ts', before: "id, readKey, readScope: 'global:events'", after: "id, readKey: id, readScope: 'global:events'" },
  'inspect-current-arrangement': { file: 'mote-heartbeat-notice.ts', before: 'run: () => source.inspect(originalSchedule)', after: 'run: () => source.inspect()' },
  'mutable-inspection-reference': { file: 'mote-heartbeat-notice.ts', before: 'const originalSchedule = structuredClone(schedule)', after: 'const originalSchedule = schedule' },
  'forget-target': { file: 'mote-heartbeat-notice.ts', before: 'source.target, schedule.loopId, pause.episodeId', after: 'schedule.loopId, pause.episodeId' },
  'diagnostic-churn': { file: 'mote-heartbeat-notice.ts', before: 'source.target, schedule.loopId, pause.episodeId', after: 'source.target, schedule.loopId, pause.episodeId, schedule.lastDecision' },
  'lost-observation-clears-pause': { file: 'mote-heartbeat-notice.ts', before: "if (presentation.state !== 'attention'", after: "if (source.unavailable || presentation.state !== 'attention'" },
  'legacy-fault': { file: 'mote-heartbeat-notice.ts', before: '!pause?.episodeId || pause.pausedAt === undefined', after: '!pause' },
  'every-pause-alarms': { file: 'mote-heartbeat-notice.ts', before: "if (presentation.state !== 'attention' || schedule?.status !== 'paused' || !schedule.managedSource ||\n    saved?.defaults.presence?.enabled === false || !pause?.episodeId || pause.pausedAt === undefined ||\n    !['input-unconfirmed', 'persistence-unconfirmed', 'timing-unrepresentable'].includes(pause.reason)) return null", after: "if (schedule?.status !== 'paused' || !pause?.episodeId || pause.pausedAt === undefined) return null" },
  'reannounce-on-reopen': { file: 'GlobalSystemNotices.tsx', before: 'if (moteAnnouncement && !moteAnnouncement.ids.some(id => unreadMoteIds.has(id))) setMoteAnnouncement(null)', after: 'if (moteAnnouncement && !moteAnnouncement.ids.some(id => unreadMoteIds.has(id))) { announcedMotes.current.clear(); setMoteAnnouncement(null) }' }
}
const selected = process.env.MOTE_HEARTBEAT_NOTICE_MUTATION
if (selected && !mutations[selected]) throw Error('Select an exact heartbeat notice mutation')

/** Exact current-source notice consumers; Provider execution belongs to the Host gate. */
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), {
  name: 'actual-mote-heartbeat-notice-source', enforce: 'pre', transform(original, id) {
    const file = id.split('?')[0]!, mutation = selected ? mutations[selected] : undefined
    if (!file.includes('/src/') || !['GlobalSystemNotices.tsx', 'mote-heartbeat-notice.ts', 'mote-heartbeat-reading.ts', 'mote-heartbeat-presentation.ts'].some(name => file.endsWith('/' + name))) return null
    let loaded = original
    if (mutation && file.endsWith('/' + mutation.file)) {
      if (original.split(mutation.before).length !== 2) throw Error('One exact current production source anchor is required')
      loaded = original.replace(mutation.before, mutation.after)
    }
    if (process.env.MOTE_HEARTBEAT_NOTICE_LOADED) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.MOTE_HEARTBEAT_NOTICE_LOADED, JSON.stringify({ file, sourceSHA256: hash(original), loadedSHA256: hash(loaded), mutation: loaded === original ? null : selected }) + '\n')
    }
    return loaded === original ? null : { code: loaded, map: null }
  }
}], test: { ...source.test,
  include: selected ? ['apps/desktop/test/mote-heartbeat-notifications.test.tsx'] : ['apps/desktop/test/mote-heartbeat-notifications.test.tsx',
    'apps/desktop/test/notification-center.test.tsx', 'apps/desktop/test/notification-center-events.test.tsx',
    'apps/desktop/test/notification-read-identity.test.ts'], maxWorkers: 1
} })
