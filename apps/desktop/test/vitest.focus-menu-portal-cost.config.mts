import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.focus-dialog-cost.config.mts'

const owner = 'apps/desktop/src/renderer/src/components/FocusContextMenu.tsx'
const portal = 'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({
  ...source, cacheDir: resolve(source.root!, '.tmp/focus-menu-portal-cost-vitest-cache'),
  plugins: [...source.plugins ?? [], { name: 'actual-focus-menu-portal-owner', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (path !== owner && path !== portal) return
    let code = path === owner && process.env.AGENTMUX_FOCUS_MENU_SOURCE ? readFileSync(process.env.AGENTMUX_FOCUS_MENU_SOURCE, 'utf8') : original
    const effective = code
    if (path === owner && process.env.AGENTMUX_FOCUS_MENU_EAGER) {
      const anchor = '{open ? <DocumentOverlayPortal component={ContextMenu.Portal}>'
      assert.equal(code.split(anchor).length - 1, 1, 'Unique loaded menu portal gate')
      assert.equal(code.split('</DocumentOverlayPortal> : null}').length - 1, 1, 'Unique loaded menu portal end')
      code = code.replace(anchor, '<DocumentOverlayPortal component={ContextMenu.Portal}>').replace('</DocumentOverlayPortal> : null}', '</DocumentOverlayPortal>')
      process.stderr.write('MUTATION_APPLIED=menu-eager\n')
    }
    if (path === owner && process.env.AGENTMUX_FOCUS_MENU_STALE_ACTIVE) {
      assert.equal(code.split('if (!activeRef.current)').length - 1, 1, 'Unique actual close presentation fact')
      code = code.replace('if (!activeRef.current)', 'if (!active)')
      process.stderr.write('MUTATION_APPLIED=stale-active\n')
    }
    if (path === portal) {
      const anchor = '  const root = resolveOverlayContainer(container, document)'
      assert.equal(code.split(anchor).length - 1, 1, 'Actual DocumentOverlayPortal consumer')
      code = code.replace(anchor, `  globalThis.__focusMenuPortalCalls?.push(Portal)\n${anchor}`)
      code += '\nglobalThis.__focusMenuPortalProbeLoaded = true\n'
    }
    if (process.env.AGENTMUX_FOCUS_MENU_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_MENU_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), effectiveSHA256: hash(effective), loadedSHA256: hash(code), mutant: process.env.AGENTMUX_FOCUS_MENU_EAGER ? 'menu-eager' : null }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: [...source.test!.include!, 'apps/desktop/test/focus-menu-portal-cost.test.tsx'] }
})
