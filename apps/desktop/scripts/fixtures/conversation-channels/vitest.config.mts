import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
import { aliases, installedDependency, root } from '../settings-connections/environment.mjs'

const evidence = process.env.AGENTMUX_CHANNELS_EVIDENCE
assert.ok(evidence, 'Explicit private evidence directory')
const mutant = process.env.AGENTMUX_CHANNELS_MUTANT ?? 'baseline'
const settings = 'apps/desktop/src/renderer/src/components/settings/'
const edits: Record<string, { file: string; before: string; after: string }> = {
  catalog: { file: settings + 'modules/amux-conversation.tsx', before: "group: 'conversation-channels'", after: "group: 'resources'" },
  native: { file: settings + 'modules/amux-conversation.tsx', before: '<DeviceManagementSettings active={active} />', after: '<DeviceManagementSettings active={false} />' },
  lark: { file: settings + 'modules/lark.tsx', before: '<ConnectorServiceControl active={active} />', after: '' }
}
assert.ok(mutant === 'baseline' || edits[mutant], 'Known loaded-source mutation')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
mkdirSync(evidence, { recursive: true })
export default defineConfig({ ...base, cacheDir: resolve(evidence, 'cache'), resolve: { alias: aliases },
  plugins: [{ name: 'conversation-channel-source-proof', enforce: 'pre', resolveId: installedDependency,
    transform(input, id) {
      if (id.includes('?')) return
      const path = relative(root, id)
      if (!path.startsWith('apps/desktop/src/') || !/\.[jt]sx?$/u.test(path)) return
      const edit = edits[mutant]
      let code = input, applied = false
      if (edit?.file === path) {
        assert.equal(input.split(edit.before).length, 2, 'One exact production mutation anchor')
        code = input.replace(edit.before, edit.after); applied = true
      }
      appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, original: sha(input), consumed: sha(code), mutant, applied }) + '\n')
      return applied ? { code, map: null } : undefined
    } }],
  test: { ...base.test, include: ['apps/desktop/test/settings-connections.test.tsx', 'apps/desktop/test/connector-mod-discovery.test.tsx'],
    // This experiment loads Core source through the aliases above. The ordinary
    // package-dist freshness gate remains in the task's original normal command.
    globalSetup: [], maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
