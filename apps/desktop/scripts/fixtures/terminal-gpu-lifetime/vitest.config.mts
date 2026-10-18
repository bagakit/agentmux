import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../terminal-live-spans/vitest.config.mts'
const product = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const consumer = 'apps/desktop/test/terminal-webgl-visibility.test.tsx'
const mutations = {
  listener: ['catch (error) { failure = { error } }', 'catch (error) { throw error /* mutation: skip the independent GPU owner */ }'],
  first: ['catch (error) { failure ??= { error } }', 'catch (error) { failure = { error } /* mutation: overwrite the original listener failure */ }'],
  stale: ['if (webgl !== addon) return', 'undefined /* mutation: let an old callback release the new GPU */']
} as const
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'terminal-independent-gpu-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (path !== product && path !== consumer) return
    const name = process.env.AGENTMUX_TERMINAL_GPU_MUTATION
    let code = source
    if (path === product && name) {
      assert.ok(Object.hasOwn(mutations, name), 'Unknown terminal GPU mutation')
      const [from, to] = mutations[name as keyof typeof mutations]
      assert.equal(code.split(from).length - 1, 1, 'Mutation requires exactly one original source anchor')
      code = code.replace(from, to)
    }
    if (process.env.AGENTMUX_TERMINAL_GPU_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_GPU_LOADED,
      JSON.stringify({ path, mutation: path === product ? name ?? null : null,
        sourceSHA256: createHash('sha256').update(source).digest('hex'), effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}] }
