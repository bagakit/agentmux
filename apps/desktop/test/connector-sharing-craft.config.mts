import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import base from './connector-details-modern.config.mts'

const owner = base.plugins![0] as Plugin
const mutant = process.env.CONNECTOR_SHARING_MUTANT
if (mutant && mutant !== 'discard-selected-scope') throw Error('Unknown Sharing counterexample')

export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/connector-sharing-craft'), plugins: [{
  name: 'connector-sharing-original-consumer', enforce: 'pre', resolveId: owner.resolveId,
  transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors|client-ui))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let loaded = original
    if (mutant && path === 'apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx') {
      const anchor = 'scope: { input: completeOriginal ? binding!.scope.input : scope,'
      if (original.split(anchor).length !== 2) throw Error('Sharing counterexample anchor changed')
      loaded = original.replace(anchor, "scope: { input: completeOriginal ? binding!.scope.input : 'mentions-and-replies',")
    }
    if (!process.env.CONNECTOR_SHARING_LOADED) return loaded === original ? undefined : loaded
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const marker = { path, originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: loaded === original ? null : mutant }
    return { code: "import { appendFileSync as __sharingLoaded } from 'node:fs'; __sharingLoaded(" + JSON.stringify(process.env.CONNECTOR_SHARING_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/connector-sharing-craft.test.tsx', 'apps/desktop/test/connector-details-modern.test.tsx'], testNamePattern: /Sharing choices|Sharing audiences|opens View group details|keeps configured paused/, passWithNoTests: false, fileParallelism: false } })
