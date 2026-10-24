import { defineConfig } from 'vitest/config'
import source from './vitest.complete-sharing.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const mutation = process.env.PUBLICATION_CONTINUITY_MUTANT
if (mutation && mutation !== 'discontinuity') throw Error('Unknown publication continuity mutation')
export default defineConfig({ ...source, cacheDir: '.cache/publication-continuity', plugins: [...source.plugins!, {
  name: 'publication-continuity-loaded', enforce: 'pre', resolveId(source) {
    if (source === '@agentmux/client-ui/theme') return resolve(import.meta.dirname, '../../client-ui/src/theme/index.ts')
    if (source.startsWith('@agentmux/client-ui/note/')) return resolve(import.meta.dirname, '../../client-ui/src/note', source.slice('@agentmux/client-ui/note/'.length) + '.ts')
    if (source.startsWith('@agentmux/client-ui/') && !source.startsWith('@agentmux/client-ui/components/')) return resolve(import.meta.dirname, '../../client-ui/src/lib', source.slice('@agentmux/client-ui/'.length) + '.ts')
  }, transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!/^packages\/(?:core|connectors)\/src\/.+\.ts$/u.test(path)) return
    let code = original
    if (mutation && path === 'packages/connectors/src/room-binding.ts') {
      const anchor = "const continuous = !!before && before.state === 'active'"
      if (code.split(anchor).length !== 2) throw Error('Original continuity owner anchor absent')
      code = code.replace(anchor, "const continuous = false && !!before && before.state === 'active'")
    }
    if (process.env.PUBLICATION_CONTINUITY_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.PUBLICATION_CONTINUITY_LOADED, JSON.stringify({ path, originalSHA256: sha(original), loadedSHA256: sha(code), ...(code !== original ? { mutation } : {}) }) + '\n')
    }
    return code === original ? undefined : code
  }
}], test: { ...source.test, include: ['packages/connectors/test/publication-continuity.test.ts', 'packages/connectors/test/publication-continuity-consumer.test.ts'], testTimeout: 30_000 } })
