import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mobile-web.config.mts'
import { workspaceSourceExport } from '../../../packages/core/test/helpers/workspace-source-export.mjs'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'
import { directoryNoticeMutations } from './mobile-directory-notices-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.MOBILE_DIRECTORY_MUTATION, report = process.env.MOBILE_DIRECTORY_LOADED
if (mutation && !Object.hasOwn(directoryNoticeMutations, mutation)) throw Error('Unknown directory notice mutation')
const variant = mutation ? directoryNoticeMutations[mutation] : undefined
const identityModule = `export const identityRuntimeSource = ${JSON.stringify((await bundleIdentityRuntime()).source)};\n`
const inputs = new Set(['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/navigation/MobileDirectoryNotice.tsx', 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', 'apps/mobile/test/mobile-directory-notices.test.tsx'])
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/mobile-directory-notices', mutation ?? 'baseline'),
  resolve: { ...base.resolve, alias: (base.resolve?.alias as { find: string; replacement: string }[]).map(entry => entry.find === '@agentmux/identity/runtime-source' ? { ...entry, replacement: 'virtual:mobile-directory-identity-source' } : entry) },
  plugins: [...(base.plugins ?? []), { name: 'actual-directory-notice-source', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:mobile-directory-identity-source' || id === '@agentmux/identity/runtime-source') return '\0virtual:mobile-directory-identity-source'; return workspaceSourceExport(root, id) },
    load(id) { if (id === '\0virtual:mobile-directory-identity-source') return identityModule },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!inputs.has(path)) return
      let code = original
      if (variant?.file === path) {
        if (code.split(variant.before).length !== 2) throw Error('Production mutation must match exactly once: ' + mutation)
        code = code.replace(variant.before, variant.after)
      }
      if (report) {
        const sha = (value: string) => createHash('sha256').update(value).digest('hex')
        const row = { path, originalSHA256: sha(readFileSync(id.split('?')[0]!, 'utf8')), loadedSHA256: sha(code), mutation: variant?.file === path ? mutation : null }
        code = `import { appendFileSync as __directoryLoaded } from 'node:fs'; __directoryLoaded(${JSON.stringify(report)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + code
      }
      return code === original ? undefined : { code, map: null }
    }
  }], test: { ...base.test, include: ['test/mobile-directory-notices.test.tsx', 'test/mobile-directory-tree.test.tsx', 'test/spatial-navigation.test.tsx', 'test/mobile-navigation-consumers.test.tsx', 'test/mobile-space-owner.test.tsx'],
    testNamePattern: variant?.target ?? 'keeps .* issues in the actual App header|scopes missing selected-session metadata|retains a Mote binding diagnostic|keeps horizontal Mote selection|retains exact original failure details|shows a presentation owner failure',
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
