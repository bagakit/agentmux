import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const mutation = process.env.AGENTMUX_SELECTION_UI_MUTANT, trace = process.env.AGENTMUX_SELECTION_UI_LOADED
if (mutation && mutation !== 'disconnect-global') throw Error('Unknown selection UI inverse')
if (mutation && !trace) throw Error('The selection UI inverse needs a real loaded-source trace')
const owners = new Set(['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx',
  'apps/desktop/src/renderer/src/components/settings/FocusSettingsPane.tsx', 'apps/desktop/src/renderer/src/components/settings/FocusSettingsPreview.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/focus.tsx', 'apps/desktop/src/renderer/src/lib/focus-preferences.ts',
  'apps/desktop/src/renderer/src/lib/focus-selection-style.ts', 'apps/desktop/src/renderer/src/components/settings/save-config-slice.ts'])
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
let applied = false
export default defineConfig({ ...source, cacheDir: '.tmp/focus-selection-settings-ui-cache',
  plugins: [...source.plugins ?? [], { name: 'actual-selection-ui-consumer', enforce: 'pre', transform(original, id) {
    const file = id.split('?')[0]!, path = relative(process.cwd(), file)
    if (!owners.has(path)) return
    let code = original
    if (mutation && path.endsWith('/GlobalFocusSurface.tsx')) {
      const anchor = '...focusSelectionStyle(config?.focus)'
      if (code.split(anchor).length !== 2) throw Error('The actual Global consumer inverse must match exactly once')
      code = code.replace(anchor, '...focusSelectionStyle(undefined)'); applied = true
    }
    const record = { path, original_sha256: sha(readFileSync(file, 'utf8')), loaded_sha256: sha(code), applied: code !== original, mutation: code !== original ? mutation : null }
    if (trace) appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...record }) + '\n')
    return { code: code + '\n;globalThis.__focusSelectionUiLoaded ??= []; globalThis.__focusSelectionUiLoaded.push(' + JSON.stringify(record) + ');\n', map: null }
  }, buildEnd() { if (mutation && !applied) throw Error('The inverse did not reach the actual Global source') } }],
  test: { ...source.test, include: ['apps/desktop/test/focus-selection-settings-ui.test.tsx'], testNamePattern: mutation ? 'previews authored choices locally' : undefined,
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 15000 }
})
