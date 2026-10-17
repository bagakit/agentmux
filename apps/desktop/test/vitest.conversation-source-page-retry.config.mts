import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), owner = 'packages/core/src/conversation-reader.ts'
const observed = [owner, 'packages/client-ui/src/lib/use-conversation-view.ts', 'apps/desktop/src/renderer/src/lib/session-conversation-window.ts']
export default defineConfig({ ...base, cacheDir: '.cache/conversation-source-page-retry', plugins: [...base.plugins ?? [], {
  name: 'source-page-retry-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!observed.includes(path)) return
    const mutation = process.env.AGENTMUX_SOURCE_PAGE_RETRY_MUTATION
    if (mutation && !['failure-as-eof', 'keep-unaccepted-native-page'].includes(mutation)) throw new Error('Unknown source-page retry mutation')
    let code = source
    if (mutation === 'keep-unaccepted-native-page' && path === owner) {
      const before = `      nativePage = undefined; checkpoint = state.checkpoint!\n      if (state.position.native === undefined) delete after.native; else after.native = state.position.native`
      if (code.split(before).length !== 2) throw new Error('Native qualification rollback must match exactly once')
      code = code.replace(before, '')
    }
    if (mutation === 'failure-as-eof' && path === owner) for (const kind of ['native', 'captured']) {
      const before = `      after.unavailable = [...(after.unavailable ?? []).filter(value => value.source.kind !== '${kind}'), failure]`
      if (code.split(before).length !== 2) throw new Error('Source-page retry mutation must match each original source exactly once')
      code = code.replace(before, before + `; after.${kind === 'native' ? 'native' : 'capturedBefore'} = null`)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_SOURCE_PAGE_RETRY_LOADED) appendFileSync(process.env.AGENTMUX_SOURCE_PAGE_RETRY_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), mutation: source === code ? null : mutation }) + '\n')
    return source === code ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/conversation-source-page-retry.test.tsx'], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
