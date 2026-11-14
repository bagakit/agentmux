import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import source from '../scripts/fixtures/settings-overview/vitest.config.mts'
const mutation = process.env.AGENTMUX_PICKER_APP_MUTATION
const changes: Record<string, [string, string]> = {
  'unobserved-location': ['quickSwitcher: quickSwitchVisible', 'quickSwitcher: quickSwitchOpen'],
  'stale-open-document': ['confirmed && workbenchDocumentIdentity(document) === main && workbenchDocumentIdentity(sourceDocument) === source', 'confirmed'],
  'stale-return-focus': ['confirmed && epoch === quickSwitchFocusEpoch.current && quickSwitchOrigin.current === original', 'confirmed && quickSwitchOrigin.current === original']
}
if (mutation && !changes[mutation]) throw Error('Unknown App picker mutation')
export default defineConfig({ ...source, plugins: [{ name: 'actual-picker-app-owner', enforce: 'pre', transform(code, id) {
  if (!id.endsWith('/App.tsx')) return
  let changed = code
  if (mutation) {
    const [before, after] = changes[mutation]!
    if (code.split(before).length !== 2) throw Error('Exact App mutation boundary missing')
    changed = code.replace(before, after)
  }
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  if (process.env.AGENTMUX_PICKER_APP_LOADED) appendFileSync(process.env.AGENTMUX_PICKER_APP_LOADED, JSON.stringify({ id, mutation: mutation ?? null, original: hash(code), changed: hash(changed) }) + '\n')
  return changed
} }], test: { ...source.test, passWithNoTests: false, include: [
  'apps/desktop/test/session-picker-app-owner.test.tsx',
  'apps/desktop/test/session-projection-navigation.test.tsx',
  'apps/desktop/test/quick-switch-demand.test.tsx',
  'apps/desktop/test/quick-switch.test.ts'
] } })
