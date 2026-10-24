import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import base from './renderer-hosting-continuation.config.mts'
const owner = base.plugins![0] as Plugin
const anchor = "  return { adapterId, actor: structuredClone(actor), baseline: structuredClone(baseline), decision: 'rule', capabilities: [...capabilities],"
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/application-member-access'), plugins: [{
  name: 'application-member-original-consumer', enforce: 'pre', resolveId: owner.resolveId,
  transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let loaded = original
    if (process.env.APPLICATION_MEMBER_MUTANT && path === 'apps/desktop/src/renderer/src/lib/application-member-intent.ts') {
      if (process.env.APPLICATION_MEMBER_MUTANT !== 'drop-empty-decision' || original.split(anchor).length !== 2) throw Error('The empty member-decision counterexample anchor changed')
      loaded = original.replace(anchor, '  if (baseline === null && capabilities.length === 0) return undefined\n' + anchor)
    }
    if (!process.env.APPLICATION_MEMBER_LOADED) return loaded === original ? undefined : loaded
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const marker = { path, originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: loaded === original ? null : process.env.APPLICATION_MEMBER_MUTANT }
    return { code: "import { appendFileSync as __applicationMemberLoaded } from 'node:fs'; __applicationMemberLoaded(" + JSON.stringify(process.env.APPLICATION_MEMBER_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/application-member-access.test.tsx'], passWithNoTests: false, fileParallelism: false } })
