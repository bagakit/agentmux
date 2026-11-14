import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import source from './performance-capture.config.mts'
const mutations = {
  'eager-history-details': ['children: <NotificationHistoryDetail event={event} />,',
    'children: <p>{historyProvenance(event)}</p>,'],
  'revisit-unchanged-sessions': [
    '[sessions, queues, sending, endpointWarnings, runServiceVersion, sessionServiceNotices, sessionNoticeViews, selectSession]', 'undefined'],
} as const
const requestedMutation = process.env.AGENTMUX_NOTIFICATION_PROJECTION_MUTATION
const mutation = mutations[requestedMutation as keyof typeof mutations]
if (requestedMutation && !mutation) throw new Error(`Unknown notification projection mutation: ${requestedMutation}`)
export default defineConfig({ ...source,
  plugins: [...source.plugins ?? [], { name: 'notification-projection-pressure', enforce: 'pre', transform(code, id) {
    if (!mutation || !id.endsWith('/src/renderer/src/components/GlobalSystemNotices.tsx')) return
    const [before, after] = mutation
    if (code.split(before).length !== 2) throw new Error(`Notification mutation anchor is missing or ambiguous: ${requestedMutation}`)
    return code.replace(before, after)
  } }],
  cacheDir: resolve(import.meta.dirname, '../../../.cache/notification-demand'),
  test: { ...source.test, setupFiles: ['apps/desktop/test/fixtures/notification-publication-boundary.ts'], include: process.env.AGENTMUX_NOTIFICATION_OWNING
    ? ['apps/desktop/test/{notification-demand,notification-receipt-demand,notification-preview,notification-item,unified-notifications,startup-snapshot-notice-resolution,agent-launch-resume-feedback,focus-terminal-recovery,layered-human-interaction,displaced-agent-notice,native-identity-notice-reconciliation,agent-fault-notice,runtime-endpoint-notice}.test.{ts,tsx}']
    : ['apps/desktop/test/notification-demand.test.tsx', 'apps/desktop/test/notification-receipt-demand.test.tsx', 'apps/desktop/test/notification-preview.test.ts'] }
})
