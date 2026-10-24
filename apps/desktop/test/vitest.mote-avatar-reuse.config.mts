import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_AVATAR_REUSE_MUTATION
const mutations = {
  'omit-derived-avatar': ['} else if (current.svg) {', '} else if (false && current.svg) {'],
  'omit-drawing-revision': ['...(drawing ? { drawing } : {})', '...{}'],
  'ignore-current-avatar': ['image = saved.image?.dataUrl ?? null', 'image = null']
} as const
if (mutation && !Object.hasOwn(mutations, mutation)) throw Error('Unknown avatar reuse mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/mote-avatar-reuse'), plugins: [{
  resolveId(source) { if (source.startsWith('@agentmux/host/')) return resolve(root, 'apps/host/src', source.slice('@agentmux/host/'.length) + '.ts') },
  name: 'exact-mote-avatar-reader', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    const hook = 'apps/desktop/src/renderer/src/lib/use-mote-bot-setup.ts'
    const state = 'apps/host/src/mote-avatar-state.ts'
    if (!['apps/desktop/src/main/mote-avatar-writer.ts', hook, state].includes(file)) return
    let code = source
    const applies = mutation && (mutation === 'ignore-current-avatar' ? file === hook : mutation === 'omit-drawing-revision' ? file === state : file === 'apps/desktop/src/main/mote-avatar-writer.ts')
    if (applies) {
      const [from, to] = mutations[mutation as keyof typeof mutations]
      if (source.split(from).length !== 2) throw Error('Missing unique actual avatar reader mutation')
      code = source.replace(from, to)
    }
    if (process.env.AGENTMUX_AVATAR_REUSE_LOADED) {
      const hash = (v: string) => createHash('sha256').update(v).digest('hex')
      appendFileSync(process.env.AGENTMUX_AVATAR_REUSE_LOADED, JSON.stringify({ file, mutation: applies ? mutation : null, originalSHA256: hash(source), sha256: hash(code) }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...original.test, include: ['apps/desktop/test/mote-avatar-reuse.test.ts', 'apps/desktop/test/mote-avatar-reuse-ui.test.tsx', 'packages/client-ui/test/mote-avatar-svg.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 20000 } })
