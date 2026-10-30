import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mobile-web.config.mts'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.MOBILE_RECOVERY_MUTANT, loaded = process.env.MOBILE_RECOVERY_LOADED
import { recoveryMutations } from './mobile-recovery-mutations.mjs'
const connection = 'apps/mobile/src/connection/MobileConnectionRoot.tsx', creation = 'apps/mobile/src/navigation/MobileAgentCreate.tsx'
if (mutant && !Object.hasOwn(recoveryMutations, mutant)) throw Error('Unknown original Mobile recovery mutation')
const variant = mutant ? recoveryMutations[mutant] : undefined
const identityModule = `export const identityRuntimeSource = ${JSON.stringify((await bundleIdentityRuntime()).source)};\n`
const hostAliases = Object.entries(JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports).map(([key, entry]) => ({
  find: '@agentmux/host' + (key === '.' ? '' : key.slice(1)), replacement: resolve(root, 'apps/host', (entry as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
}))
const observed = new Set([connection, creation, 'apps/mobile/src/recovery/device-workface.ts', 'apps/mobile/src/mobile-web/update-safety.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-value.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/diagnostic-evidence/src/index.ts', 'packages/diagnostic-evidence/src/protocol.ts', 'packages/diagnostic-evidence/src/query.ts',
  'apps/desktop/src/renderer/src/lib/space-agent-control.ts', 'apps/mobile/test/mobile-agent-create.test.tsx', 'apps/mobile/test/mobile-recovery-connection.test.tsx', 'apps/mobile/test/mobile-update-connection.test.tsx'])
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/mobile-recovery-usability', mutant ?? 'baseline'),
  resolve: { ...base.resolve, alias: [{ find: '@agentmux/diagnostic-evidence', replacement: resolve(root, 'packages/diagnostic-evidence/src/index.ts') }, ...hostAliases, ...(base.resolve?.alias as { find: string; replacement: string }[]).map(entry => entry.find === '@agentmux/identity/runtime-source' ? { ...entry, replacement: 'virtual:mobile-recovery-identity-source' } : entry)].sort((a, b) => b.find.length - a.find.length) },
  plugins: [...(base.plugins ?? []), { name: 'actual-mobile-recovery-input', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:mobile-recovery-identity-source') return '\0' + id },
    load(id) {
      if (id !== '\0virtual:mobile-recovery-identity-source') return
      const row = { path: 'virtual:mobile-recovery-identity-source', generated: true, loadedSHA256: createHash('sha256').update(identityModule).digest('hex') }
      return loaded ? `import { appendFileSync as __identityLoaded } from 'node:fs'; __identityLoaded(${JSON.stringify(loaded)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + identityModule : identityModule
    }, transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!observed.has(path)) return
    let code = original
    if (variant?.file === path) for (const [before, after] of variant.edits) {
      if (code.split(before).length !== 2) throw Error('The original Mobile recovery mutation must have one exact source anchor: ' + mutant)
      code = code.replace(before, after)
    }
    if (loaded) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      const row = { path, originalSHA256: hash(readFileSync(id.split('?')[0]!, 'utf8')), loadedSHA256: hash(code), mutation: variant?.file === path ? mutant : null }
      code = `import { appendFileSync as __recoveryLoaded } from 'node:fs'; __recoveryLoaded(${JSON.stringify(loaded)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + code
    }
    return code === original ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['test/mobile-agent-create.test.tsx', 'test/mobile-recovery-connection.test.tsx', 'test/mobile-update-connection.test.tsx'],
    testNamePattern: variant?.target ?? 'Mobile recovery usability|actual connected key|entry preflight|original key after waiting|on a new document refuses|original saved offer|workface replaced by another page|unreadable workface',
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
