import base from './vitest.focus-editor-app-navigation.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const entry = 'apps/desktop/src/renderer/src/components/settings/MeshSettingsPaneEntry.tsx'
const contribution = 'apps/desktop/src/renderer/src/components/settings/modules/hosts.tsx'
const editor = 'apps/desktop/src/renderer/src/components/settings/MeshSettingsPane.tsx'
const panel = 'apps/desktop/src/renderer/src/components/SettingsPanel.tsx'
const inverse = process.env.AGENTMUX_MESH_ENTRY_INVERSE
if (inverse && !['eager-editor', 'unmount-hidden', 'skip-field-ready'].includes(inverse)) throw Error('Unknown Mesh entry inverse')
export default defineConfig({ ...base, cacheDir: '.tmp/mesh-settings-entry-vitest', plugins: [{
  name: 'original-mesh-entry-proof', enforce: 'pre', transform(source, id) {
    const path = relative(process.cwd(), id.split('?')[0]!)
    if (![entry, contribution, editor, panel].includes(path)) return
    let code = source
    if (path === entry) code = code.replace("import('./MeshSettingsPane')", "((globalThis as any).__agentmuxMeshEntryFixture?.load(() => import('./MeshSettingsPane')) ?? import('./MeshSettingsPane'))")
    if (path === editor) code += '\n;if ((globalThis as any).__agentmuxMeshEntryFixture) (globalThis as any).__agentmuxMeshEntryFixture.evaluations++\n'
    let before: string | undefined, after: string | undefined
    if (path === contribution && inverse === 'eager-editor') { before = "from '../MeshSettingsPaneEntry'"; after = "from '../MeshSettingsPane'" }
    if (path === entry && inverse === 'unmount-hidden') { before = "if (entry && 'Component' in entry) return"; after = "if (enabled && entry && 'Component' in entry) return" }
    if (path === panel && inverse === 'skip-field-ready') { before = 'observer = new MutationObserver(reveal)'; after = 'observer = new MutationObserver(() => {})' }
    if (before !== undefined) { if (code.split(before).length !== 2) throw Error('One original owner inverse required'); code = code.replace(before, after!) }
    if (process.env.AGENTMUX_MESH_ENTRY_LOADED) appendFileSync(process.env.AGENTMUX_MESH_ENTRY_LOADED,
      JSON.stringify({ path, sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), inverse: inverse ?? null }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}, ...(base.plugins ?? [])], test: { ...base.test, include: ['apps/desktop/test/mesh-settings-entry.test.tsx', 'apps/desktop/test/host-settings-navigation.test.tsx', 'apps/desktop/test/renderer-startup-graph.test.ts'], testTimeout: 20000 } })
