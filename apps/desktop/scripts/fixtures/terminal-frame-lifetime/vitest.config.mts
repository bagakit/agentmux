import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
const product = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const consumer = 'apps/desktop/test/terminal-incident-product.test.tsx'
const anchor = '      focusWindow.cancelAnimationFrame(focusFrame)'
const mutations: Record<string, string> = {
  uncancelled: '      /* mutation: retired initialization frame retained */',
  owner: '      root.ownerDocument.defaultView!.cancelAnimationFrame(focusFrame)'
}
export default defineConfig({ ...base, root,
  resolve: { conditions: ['browser'] },
  ssr: { resolve: { conditions: ['browser'] }, noExternal: ['@agentmux/client-ui'] },
  plugins: [{
  name: 'terminal-frame-lifetime', enforce: 'pre',
  transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== product && path !== consumer) return
    let code = source
    const mutation = process.env.AGENTMUX_TERMINAL_FRAME_MUTANT
    if (path === product && mutation) {
      assert.ok(Object.hasOwn(mutations, mutation), 'Unknown terminal frame mutation')
      assert.equal(code.split(anchor).length - 1, 1, 'Mutation must hit exactly one production anchor')
      code = code.replace(anchor, mutations[mutation]!)
    }
    if (process.env.AGENTMUX_TERMINAL_FRAME_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_FRAME_LOADED,
      JSON.stringify({ path, mutation: path === product ? mutation ?? null : null,
        sourceSHA256: createHash('sha256').update(source).digest('hex'),
        effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: [consumer, 'apps/desktop/test/session-restart.test.tsx', 'apps/desktop/test/terminal-webgl-visibility.test.tsx'],
  passWithNoTests: false, testTimeout: 20_000, fileParallelism: false, maxWorkers: 1 } })
