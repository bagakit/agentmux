import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import source from '../../../packages/connectors/test/vitest.mote-host.config.mts'
const root = source.root!, mutant = process.env.CONVERSATION_SYNC_MUTANT
if (mutant && mutant !== 'scope-disconnect') throw Error('Unknown conversation sync mutation')
const manifest = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8'))
export default { ...source, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, cacheDir: resolve(root, '.cache/conversation-sync'),
  plugins: [{ name: 'conversation-sync-public-source', enforce: 'pre' as const,
    resolveId(id: string) {
      if (id !== '@agentmux/client-ui' && !id.startsWith('@agentmux/client-ui/')) return
      const key = id === '@agentmux/client-ui' ? '.' : './' + id.slice('@agentmux/client-ui/'.length)
      let entry = manifest.exports[key], capture = ''
      if (!entry) for (const [pattern, value] of Object.entries(manifest.exports).sort(([a], [b]) => b.length - a.length)) {
        if (!pattern.includes('*')) continue
        const [prefix, suffix] = pattern.split('*')
        if (key.startsWith(prefix!) && key.endsWith(suffix!)) { entry = value; capture = key.slice(prefix!.length, suffix ? -suffix.length : undefined); break }
      }
      const path = typeof entry === 'string' ? entry : entry?.browser
      if (path) return resolve(root, 'packages/client-ui', path.replace('*', capture))
    },
    transform(original: string, id: string) {
      const path = relative(root, id.split('?')[0]!), target = 'apps/desktop/src/renderer/src/components/ConnectorHeaderLinks.tsx'
      let loaded = original
      if (mutant && path === target) {
        const before = "const fullConversation = binding.scope.publication === 'future-shared-conversation'"
        if (loaded.split(before).length !== 2) throw Error('Exact scope consumer mutation must load once')
        loaded = loaded.replace(before, 'const fullConversation = false')
      }
      if (process.env.CONVERSATION_SYNC_LOADED && /^(apps\/(desktop|host)\/src|packages\/(core|connectors|client-ui)\/src)\/.+\.tsx?$/u.test(path)) {
        const sha = (text: string) => createHash('sha256').update(text).digest('hex')
        appendFileSync(process.env.CONVERSATION_SYNC_LOADED, JSON.stringify({ path, originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: loaded === original ? null : mutant }) + '\n')
      }
      if (loaded !== original) return loaded
    }
  }, ...source.plugins!], test: { ...source.test, include: ['apps/desktop/test/connector-sharing-composer.test.tsx', 'apps/desktop/test/composer-input-context.test.tsx'], testTimeout: 25000 }
}
