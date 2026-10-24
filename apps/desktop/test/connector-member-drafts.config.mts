import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import base from './renderer-hosting-continuation.config.mts'

const owner = base.plugins![0] as Plugin
const anchor = 'if (!draft || !sameMemberCapabilities(draft.capabilities, submitted)) return drafts'
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/member-access'), plugins: [{
  name: 'member-access-original-consumer', enforce: 'pre', resolveId: owner.resolveId,
  transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let loaded = original
    if (process.env.MEMBER_ACCESS_MUTANT && path === 'apps/desktop/src/renderer/src/lib/connector-member-draft.ts') {
      if (process.env.MEMBER_ACCESS_MUTANT !== 'drop-dirty-ack' || original.split(anchor).length !== 2) throw Error('The member dirty-ACK counterexample anchor changed')
      loaded = original.replace(anchor, 'if (!draft) return drafts')
    }
    if (!process.env.MEMBER_ACCESS_LOADED) return loaded === original ? undefined : loaded
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const marker = { path, originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: loaded === original ? null : process.env.MEMBER_ACCESS_MUTANT }
    return { code: "import { appendFileSync as __memberLoaded } from 'node:fs'; __memberLoaded(" + JSON.stringify(process.env.MEMBER_ACCESS_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/connector-member-drafts.test.tsx'], passWithNoTests: false, fileParallelism: false } })
