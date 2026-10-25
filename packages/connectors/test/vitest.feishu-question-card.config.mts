import { defineConfig } from 'vitest/config'
import native from './vitest.channel-history.config.mts'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = native.root!
const sources = ['publication-store.ts', 'adapters/feishu/publication.ts', 'adapters/feishu/role-card.ts', 'adapters/feishu/question-card.ts']
export default defineConfig({ ...native, cacheDir: resolve(root, '.cache/feishu-question-card'), plugins: [{
  name: 'question-card-runtime-source', enforce: 'pre',
  resolveId(source) {
    if (source.startsWith('@agentmux/client-ui/')) {
      const key = './' + source.slice('@agentmux/client-ui/'.length)
      const entries = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports
      const match = Object.keys(entries).filter(name => name.includes('*') && key.startsWith(name.split('*')[0]!) && key.endsWith(name.split('*')[1]!))
        .sort((a, b) => b.length - a.length)[0]
      const entry = entries[key] ?? entries[match!], path = typeof entry === 'string' ? entry : entry?.types
      if (path) return resolve(root, 'packages/client-ui', match && !entries[key] ? path.replace('*', key.slice(match.split('*')[0]!.length, key.length - match.split('*')[1]!.length)) : path)
    }
    if (source.startsWith('@agentmux/host/')) return resolve(root, 'apps/host/src', source.slice('@agentmux/host/'.length) + '.ts')
  },
  transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!sources.some(source => path === 'packages/connectors/src/' + source)) return
    let loaded = original, mutation: string | undefined
    if (process.env.QUESTION_CARD_MUTANT && path === 'packages/connectors/src/publication-store.ts') {
      if (process.env.QUESTION_CARD_MUTANT !== 'speaker-disconnect') throw Error('Unknown Question card mutation')
      const before = "...(speaker && (payload.kind === 'speech' || payload.kind === 'question') ? { speaker } : {}),"
      if (original.split(before).length !== 2) throw Error('Exact Question speaker boundary must occur once')
      loaded = original.replace(before, "...(speaker && payload.kind === 'speech' ? { speaker } : {}),"); mutation = 'speaker-disconnect'
    }
    if (process.env.QUESTION_CARD_LOADED) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, originalSHA256: hash(original), loadedSHA256: hash(loaded), ...(mutation ? { mutation } : {}) }
      return { code: "import { appendFileSync as __questionCardLoaded } from 'node:fs'; __questionCardLoaded(" + JSON.stringify(process.env.QUESTION_CARD_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + loaded, map: null }
    }
    if (mutation) return loaded
  }
}, ...native.plugins!], test: { ...native.test, include: ['packages/connectors/test/feishu-question-actions.test.ts', 'packages/connectors/test/feishu-publication.test.ts'] } })
