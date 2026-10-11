import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_AVATAR_REUSE_MUTATION
const mutations = {
  'omit-derived-avatar': ['} else if (current.svg) {', '} else if (false && current.svg) {'],
  'omit-drawing-revision': ['...(svg ? { drawing: svg } : {})', '...{}']
} as const
if (mutation && !Object.hasOwn(mutations, mutation)) throw Error('Unknown avatar reuse mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/mote-avatar-reuse'), plugins: [{
  name: 'exact-mote-avatar-reader', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'apps/desktop/src/main/mote-avatar-writer.ts') return
    let code = source
    if (mutation) {
      const [from, to] = mutations[mutation as keyof typeof mutations]
      if (source.split(from).length !== 2) throw Error('Missing unique actual avatar reader mutation')
      code = source.replace(from, to)
    }
    if (process.env.AGENTMUX_AVATAR_REUSE_LOADED) {
      const hash = (v: string) => createHash('sha256').update(v).digest('hex')
      appendFileSync(process.env.AGENTMUX_AVATAR_REUSE_LOADED, JSON.stringify({ file, mutation: mutation ?? null, originalSHA256: hash(source), sha256: hash(code) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...original.test, include: ['apps/desktop/test/mote-avatar-reuse.test.ts', 'packages/client-ui/test/mote-avatar-svg.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
