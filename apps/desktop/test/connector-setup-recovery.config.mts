import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import base from './connector-details-modern.config.mts'

const owner = base.plugins![0] as Plugin
const mutant = process.env.CONNECTOR_SETUP_RECOVERY_MUTANT
if (mutant && mutant !== 'refusal-is-unknown') throw Error('Unknown setup recovery counterexample')

export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/connector-setup-recovery'), plugins: [{
  name: 'connector-setup-recovery-original-consumer', enforce: 'pre', resolveId: owner.resolveId,
  transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!/^(?:apps\/(?:host|desktop)|packages\/(?:core|connectors|client-ui))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let loaded = original
    if (mutant && path === 'apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx') {
      const anchor = "const bindingRefused = !!bindingFact && 'state' in bindingFact && bindingFact.state === 'refused'"
      if (original.split(anchor).length !== 2) throw Error('Setup recovery counterexample anchor changed')
      loaded = original.replace(anchor, 'const bindingRefused = false')
    }
    if (!process.env.CONNECTOR_SETUP_RECOVERY_LOADED) return loaded === original ? undefined : loaded
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const marker = { path, originalSHA256: sha(original), loadedSHA256: sha(loaded), mutation: loaded === original ? null : mutant }
    return { code: "import { appendFileSync as __setupRecoveryLoaded } from 'node:fs'; __setupRecoveryLoaded(" + JSON.stringify(process.env.CONNECTOR_SETUP_RECOVERY_LOADED) + ', ' + JSON.stringify(JSON.stringify(marker) + '\n') + ');\n' + loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/connector-setup-recovery.test.tsx'], testNamePattern: /Setup recovery/, passWithNoTests: false, fileParallelism: false } })
