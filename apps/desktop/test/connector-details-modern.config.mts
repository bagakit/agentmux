import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import base from './renderer-hosting-continuation.config.mts'
import { candidateResolve } from '../scripts/candidate-package-resolve.mjs'
const owner = base.plugins![0] as Plugin
const mutant = process.env.CONNECTOR_DETAILS_MUTANT
if (mutant && mutant !== 'hide-source-behind-content') throw Error('Unknown connector details mutation')
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/connector-details-modern'), plugins: [{
  name: 'connector-details-original-consumer', enforce: 'pre', resolveId(source, importer, options) {
    if (source === '@agentmux/client-ui' || source.startsWith('@agentmux/client-ui/')) return candidateResolve(base.root!, source, { browser: true })
    return typeof owner.resolveId === 'function' ? owner.resolveId.call(this, source, importer, options) : undefined
  },
  transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let loaded = original
    if (mutant && path === 'apps/desktop/src/renderer/src/lib/connector-group-status.ts') {
      const anchor = "const sourceUnconfirmed = !!out && out.sourceObservation?.state !== 'ready'"
      if (original.split(anchor).length !== 2) throw Error('Source visibility counterexample anchor changed')
      loaded = original.replace(anchor, "const sourceUnconfirmed = !!out && !contentGap && out.sourceObservation?.state !== 'ready'")
    }
    if (!process.env.CONNECTOR_DETAILS_LOADED) return loaded === original ? undefined : loaded
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const marker = { path, originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: loaded === original ? null : mutant }
    return { code: "import { appendFileSync as __detailsLoaded } from 'node:fs'; __detailsLoaded(" + JSON.stringify(process.env.CONNECTOR_DETAILS_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/connector-details-modern.test.tsx', 'apps/desktop/test/connector-member-drafts.test.tsx', 'apps/desktop/test/connector-input-recovery.test.tsx'], testNamePattern: /shows source failure|starts with compact|keeps per-member edits|keeps a dirty member|keeps the original unknown request|keeps earlier draft|opens the original saved connector input/, passWithNoTests: false, fileParallelism: false } })
