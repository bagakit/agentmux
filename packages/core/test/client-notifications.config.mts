import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_NOTIFICATION_CORE_MUTATION
const changes = {
  'control-target-unchecked': {
    file: '/packages/core/src/rpc-business-codec.ts',
    original: 'parseClientNotificationsObservation(actual.observation, request.target, request.includeRaw)',
    replacement: 'void actual.observation',
  },
  'cli-unread-filter-disconnected': {
    file: '/packages/core/src/agentmux-cli-commands.ts',
    original: "...(f.booleans.has('--unread') ? { unreadOnly: true } : {})",
    replacement: '...{}',
  },
} as const
if (mutation && !Object.hasOwn(changes, mutation)) throw new Error('Unknown client notification source mutation')
export default defineConfig({ root,
  cacheDir: resolve(root, '.tmp/client-notifications-core-vitest', mutation ?? 'positive'),
  plugins: [{ name: 'actual-client-notification-core-source', enforce: 'pre', transform(source, id) {
    if (!mutation) return
    const change = changes[mutation as keyof typeof changes]
    if (!id.replaceAll('\\', '/').endsWith(change.file)) return
    if (source.split(change.original).length !== 2) throw new Error('Original client notification source mutation anchor changed')
    console.log(`NOTIFICATION_CORE_MUTATION_APPLIED:${mutation}`)
    return { code: source.replace(change.original, change.replacement), map: null }
  } }],
  test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/client-notifications.test.ts'] },
})
