import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../terminal-frame-lifetime/vitest.config.mts'
const product = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const consumer = 'apps/desktop/test/terminal-webgl-visibility.test.tsx'
const mutations = {
  viewport: ['cleanup(() => viewport.dispose())', 'viewport.dispose()'],
  subscription: ['cleanup(disposeEvents)', 'disposeEvents()']
} as const
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'terminal-independent-retirement', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (path !== product && path !== consumer) return
    const name = process.env.AGENTMUX_TERMINAL_RETIREMENT_MUTATION
    let code = source
    if (path === product && name) {
      assert.ok(Object.hasOwn(mutations, name), 'Unknown terminal retirement mutation')
      const [from, to] = mutations[name as keyof typeof mutations]
      assert.equal(code.split(from).length - 1, 1, 'Mutation requires one original owner')
      code = code.replace(from, to)
    }
    if (process.env.AGENTMUX_TERMINAL_RETIREMENT_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_RETIREMENT_LOADED,
      JSON.stringify({ path, mutation: path === product ? name ?? null : null,
        sourceSHA256: createHash('sha256').update(source).digest('hex'),
        effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}] }
