import base from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '../../..'), evidence = process.env.CONNECTION_EDIT_EVIDENCE
if (evidence) mkdirSync(evidence, { recursive: true })
const observed = new Set([
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts',
  'apps/desktop/src/renderer/src/lib/workbench-user-storage.ts', 'apps/desktop/src/main/workbench-user-state.ts',
  'apps/desktop/src/renderer/src/lib/tailcat-connection-draft.ts',
  'apps/desktop/src/renderer/src/components/settings/use-tailcat-connection-drafts.tsx',
  'apps/desktop/src/renderer/src/components/settings/MeshSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/HostSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/LocalIncomingConnections.tsx',
  'apps/desktop/src/renderer/src/components/settings/HostTailcatListenerFields.tsx',
  'apps/desktop/test/connection-settings-persistence.test.tsx', 'packages/core/src/durable-write.ts',
])
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'connection-native-user-document-consumer', enforce: 'pre' as const, transform(original: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!observed.has(path)) return
    let source = original
    if (path.endsWith('/store.ts') || path.endsWith('/desktop-user-state.ts')) source = source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
    if (evidence) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      const receipt = { path, originalSHA256: sha(original), servedSHA256: sha(source),
        assembly: 'native-user-document', phase: process.env.CONNECTION_EDIT_PHASE ?? 'parent' }
      source = `import { appendFileSync as __connectionDocumentLoad } from 'node:fs'; __connectionDocumentLoad(${JSON.stringify(resolve(evidence, `${process.env.CONNECTION_EDIT_PHASE ?? 'parent'}-loaded.jsonl`))}, JSON.stringify({...${JSON.stringify(receipt)},pid:process.pid})+'\\n');\n` + source
    }
    return source === original ? undefined : { code: source, map: null }
  }
}], cacheDir: resolve(root, '.tmp/connection-edit-persistence'), test: {
  ...base.test, include: ['apps/desktop/test/connection-settings-persistence.test.tsx'], pool: 'forks' as const,
  maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 120_000, hookTimeout: 30_000,
} }
