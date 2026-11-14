import base from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { installedDependency } from '../scripts/fixtures/settings-resource-library/environment.mjs'

const root = resolve(import.meta.dirname, '../../..'), evidence = process.env.MESH_EDIT_EVIDENCE
const mutation = process.env.MESH_EDIT_MUTATION
if (mutation && !['drop-mesh-partialize', 'retain-inflight'].includes(mutation)) throw Error('Unknown Mesh user-document mutation')
if (evidence) mkdirSync(evidence, { recursive: true })
const observed = new Set(['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts',
  'apps/desktop/src/renderer/src/lib/workbench-user-storage.ts', 'apps/desktop/src/main/workbench-user-state.ts',
  'apps/desktop/src/renderer/src/lib/mesh-settings-draft.ts', 'apps/desktop/src/renderer/src/components/settings/MeshNetworkSettings.tsx',
  'apps/desktop/test/mesh-settings-persistence.test.tsx', 'packages/core/src/durable-write.ts'])
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'mesh-native-user-document-consumer', enforce: 'pre' as const, resolveId: installedDependency, transform(original: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!observed.has(path)) return
    let source = original, mutated = false
    if (mutation === 'drop-mesh-partialize' && path.endsWith('/store.ts')) {
      const anchor = '    meshSettingsDrafts: state.meshSettingsDrafts,'
      if (source.split(anchor).length !== 2) throw Error('One actual Mesh user-document projection required')
      source = source.replace(anchor, ''); mutated = true
    }
    if (mutation === 'retain-inflight' && path.endsWith('/mesh-settings-draft.ts')) {
      const anchor = "pending: { ...entry.pending, phase: 'unknown' }"
      if (source.split(anchor).length !== 2) throw Error('One actual departed Mesh producer transition required')
      source = source.replace(anchor, "pending: { ...entry.pending, phase: 'in-flight' }"); mutated = true
    }
    // API leaves are controlled; the shipping Store and document use their actual
    // native filesystem writer, not the web-preview localStorage projection.
    if (path.endsWith('/store.ts') || path.endsWith('/desktop-user-state.ts')) source = source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
    if (evidence) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      const receipt = { path, originalSHA256: sha(original), servedSHA256: sha(source), mutated,
        assembly: 'native-user-document', phase: process.env.MESH_EDIT_PHASE ?? 'parent' }
      source = `import { appendFileSync as __meshDocumentLoad } from 'node:fs'; __meshDocumentLoad(${JSON.stringify(resolve(evidence, `${process.env.MESH_EDIT_PHASE ?? 'parent'}-loaded.jsonl`))}, JSON.stringify({...${JSON.stringify(receipt)},pid:process.pid})+'\\n');\n` + source
    }
    return source === original ? undefined : { code: source, map: null }
  }
}], cacheDir: resolve(root, '.tmp/mesh-edit-persistence', mutation ?? 'original'), test: {
  ...base.test, include: ['apps/desktop/test/mesh-settings-persistence.test.tsx'], pool: 'forks' as const,
  maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 120_000, hookTimeout: 30_000
} }
