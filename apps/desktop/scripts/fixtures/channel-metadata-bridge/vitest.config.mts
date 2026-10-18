import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
import { aliases, installedDependency } from '../settings-connections/environment.mjs'
import { candidateResolve } from '../../candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = process.env.AGENTMUX_METADATA_BRIDGE_EVIDENCE
assert.ok(evidence, 'Explicit private metadata bridge evidence directory')
const mutant = process.env.AGENTMUX_METADATA_BRIDGE_MUTANT ?? 'baseline'
const edits: Record<string, { file: string; before: string; after: string }> = {
  'main-relay': { file: 'apps/desktop/src/main/ipc.ts',
    before: 'contents.send(CONNECTION_METADATA_CHANGED_CHANNEL, change)', after: 'void change' },
  'preload-relay': { file: 'apps/desktop/src/preload/index.ts',
    before: "const receive = (_event: unknown, change: import('@agentmux/core/connections').ChannelMetadataChange) => listener(change)",
    after: "const receive = (_event: unknown, change: import('@agentmux/core/connections').ChannelMetadataChange) => { void change; void listener }" },
  'preload-release': { file: 'apps/desktop/src/preload/index.ts',
    before: 'return () => ipcRenderer.removeListener(CONNECTION_METADATA_CHANGED_CHANNEL, receive)', after: 'return () => { void receive }' },
  'main-release': { file: 'apps/desktop/src/main/ipc.ts',
    before: "{ owner: 'channel-metadata', dispose: disposeChannelMetadata },", after: '' },
  'read-generation': { file: 'apps/desktop/src/renderer/src/lib/use-connector-room-name.ts',
    before: 'const request = ++generation', after: 'const request = generation' },
  'preview-retain': { file: 'apps/desktop/src/renderer/src/lib/use-connector-room-name.ts',
    before: "catch { subscriptionIssue = 'Group name updates unconfirmed' }", after: "catch { throw new Error('Notification observation interrupted the card') }" }
}
assert.ok(mutant === 'baseline' || edits[mutant], 'Known metadata bridge source mutation')
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
mkdirSync(evidence, { recursive: true })
export default defineConfig({ ...base, root, cacheDir: resolve(evidence, 'cache'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/u, replacement: resolve(root, 'packages/connectors/src/index.ts') }, ...aliases] },
  plugins: [{ name: 'metadata-bridge-loaded-source', enforce: 'pre', resolveId(source, importer) {
    if (source.startsWith('@agentmux/')) return candidateResolve(root, source, { source: true })
    return installedDependency.call(this, source, importer)
  }, transform(input, id) {
    if (id.includes('?')) return
    const path = relative(root, id)
    if (!path.startsWith('apps/desktop/src/') || !/\.[jt]sx?$/u.test(path)) return
    const edit = edits[mutant]
    let code = input, applied = false
    if (edit?.file === path) {
      assert.equal(input.split(edit.before).length, 2, 'One exact production source mutation anchor')
      code = input.replace(edit.before, edit.after); applied = true
    }
    appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(input), consumedSHA256: sha(code), mutant, applied }) + '\n')
    return applied ? { code, map: null } : undefined
  } }],
  test: { ...base.test, include: ['apps/desktop/test/channel-metadata-bridge.test.tsx', 'apps/desktop/test/channel-room-name-review.test.tsx'],
    maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
