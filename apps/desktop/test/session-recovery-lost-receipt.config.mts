import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import base from '../../../packages/core/test/hook-postcommit-observation.vitest.config.mts'
const hostExports = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../host/package.json'), 'utf8')).exports as Record<string, { import: string }>
const hostAliases = Object.entries(hostExports).map(([name, entry]) => ({ find: `@agentmux/host/${name.slice(2)}`, replacement: resolve(import.meta.dirname, '../../host/src', entry.import.slice(7).replace(/\.js$/u, '.ts')) })).sort((a, b) => b.find.length - a.find.length)
const mutation = process.env.AGENTMUX_DESKTOP_RECOVERY_MUTATION
const changes: Record<string, [string, string, string]> = {
  'lose-pending-resolution-id': ['apps/desktop/src/renderer/src/store.ts', "resolution?.outcome === 'pending'", 'false'],
  'reuse-handed-off-resolution-id': ['apps/desktop/src/renderer/src/store.ts', "resolution?.outcome === 'pending'", 'Boolean(resolution)'],
  'trust-business-code': ['apps/desktop/src/renderer/src/store.ts', '!isSessionRecoveryReplyUnconfirmed(error)', "!(error instanceof Error && (error as Error & { code?: string }).code === 'SESSION_RECOVERY_REPLY_UNCONFIRMED')"],
  'discard-reconciliation': ['apps/desktop/src/renderer/src/store.ts', '        recovery = await recoverOriginal()', '        throw error'],
  'lose-rpc-provenance': ['apps/desktop/src/main/session-recovery-operation.ts', "isAgentMuxRpcReplyUnconfirmed(error) ? 'unconfirmed' : 'received'", "'received'"],
}
if (mutation && !changes[mutation]) throw new Error('Unknown Desktop recovery mutation')
export default { ...base,
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  resolve: { conditions: ['browser', 'import', 'default'], alias: [{ find: '@agentmux/identity/runtime-source', replacement: resolve(import.meta.dirname, '../../../packages/identity/dist/runtime-source.js') }, ...hostAliases, ...base.resolve.alias.filter(entry => !entry.find.startsWith('@agentmux/client-ui'))] },
  plugins: mutation ? [{ name: 'actual-desktop-recovery-mutation', enforce: 'pre' as const,
    transform(code: string, id: string) {
      const [file, from, to] = changes[mutation]!
      if (id.split('?')[0] !== resolve(import.meta.dirname, '../../..', file)) return
      if (code.split(from).length !== 2) throw new Error('Mutation must match the owner exactly once')
      console.log('loaded-desktop-recovery-mutation=' + mutation)
      return { code: code.replace(from, to), map: null }
    }
  }] : [],
  test: { ...base.test, include: ['apps/desktop/test/session-recovery-lost-receipt.test.tsx'], passWithNoTests: false, maxWorkers: 1, testTimeout: 30000 }
}
