import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.WORKING_LOCATION_MUTATION
const edits: Record<string, [string, string, string]> = {
  'forget-context': ['lib/source-files-workbench.ts', 'const mount = ports.location?.(workspaceId, runtimeId)', 'const mount = undefined'],
  'require-previous-click': ['lib/source-files-workbench.ts', "if (!workspace || registration.hostId !== workspace.hostId)", "if (!original || !workspace || registration.hostId !== workspace.hostId)"],
  'adopt-late-location': ['lib/source-files-workbench.ts', '(observedLocation === undefined || observedLocation ===', '(true || observedLocation === undefined || observedLocation ==='],
  'reuse-previous-locator': ['lib/source-files-workbench.ts', 'const selected: SourceFilesInput = { workspace: input.workspace, target: input.target, selection, ...(sameLocation ? { locator: input.locator } : {}) }', 'const selected: SourceFilesInput = { ...input, selection }'],
  'ignore-selected-zone': ['lib/original-space-navigation.ts', 'workspaceId === target.workspaceId ? zones.find(zone => zone.zoneId === target.zoneId) : zones.length === 1 ? zones[0] : undefined', 'zones.length === 1 ? zones[0] : undefined']
}
if (mutation && !edits[mutation]) throw Error('Unknown working location mutation')
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], {
  name: 'working-location-product-consumer', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    let code = original
    if (process.env.WORKING_LOCATION_CONTROL && ['source-files-workbench.ts', 'source-files-discovery.ts', 'SourceFilesAccess.tsx', 'original-space-navigation.ts'].some(file => path.endsWith('/' + file))) {
      code = readFileSync(resolve(process.env.WORKING_LOCATION_CONTROL, path.split('/').at(-1)!), 'utf8')
    }
    if (['store.ts', 'lib/desktop-user-state.ts', 'lib/launcher-state.ts'].some(file => path === 'apps/desktop/src/renderer/src/' + file)) code = code.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
    const selected = mutation && edits[mutation]
    if (selected && path === 'apps/desktop/src/renderer/src/' + selected[0]) {
      if (code.split(selected[1]).length !== 2) throw Error('One loaded working location consumer is required')
      code = code.replace(selected[1], selected[2])
    }
    if (process.env.WORKING_LOCATION_LOADED && path.startsWith('apps/desktop/src/renderer/src/') &&
      ['store.ts', 'source-files-workbench.ts', 'source-files-discovery.ts', 'SourceFilesAccess.tsx', 'original-space-navigation.ts'].some(file => path.endsWith('/' + file))) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.WORKING_LOCATION_LOADED, JSON.stringify({ path, mutation: mutation ?? null, original: hash(original), loaded: hash(code) }) + '\n')
    }
    return code !== original ? { code, map: null } : undefined
  }
}], test: { ...base.test, include: ['apps/desktop/test/file-path-client-projection.test.ts'], passWithNoTests: false, testTimeout: 60000 } })
