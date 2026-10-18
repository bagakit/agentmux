import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../terminal-restart-memory/vitest.config.mts'

const product = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const helper = 'apps/desktop/src/renderer/src/lib/terminal-attachment-observation.ts'
const consumers = ['apps/desktop/test/terminal-incident-product.test.tsx', 'apps/desktop/test/terminal-attachment-observation.test.ts']
const mutations = {
  retirement: [product, "observationLifetime.abort(Symbol('retired-terminal-observation'))", 'void observationLifetime /* mutation: retired reader remains pending */'],
  'late-lease': [helper, 'void releaseLateAttachment(result.attachmentId)', 'void result.attachmentId /* mutation: original late lease is lost */'],
  'retirement-stack': [product, "Symbol('retired-terminal-observation')", "new Error('retired-terminal-observation')"]
} as const
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'terminal-pending-retirement', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (path !== product && path !== helper && !consumers.includes(path)) return
    let code = source, applied: string | null = null
    const mutation = process.env.AGENTMUX_TERMINAL_PENDING_MUTATION
    if (mutation) {
      assert.ok(Object.hasOwn(mutations, mutation), 'Unknown terminal pending retirement mutation')
      const [target, from, to] = mutations[mutation as keyof typeof mutations]
      if (path === target) {
        assert.equal(code.split(from).length - 1, 1, 'Mutation requires exactly one original owner')
        code = code.replace(from, to); applied = mutation
      }
    }
    if (process.env.AGENTMUX_TERMINAL_PENDING_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_PENDING_LOADED,
      JSON.stringify({ path, mutation: applied, sourceSHA256: createHash('sha256').update(source).digest('hex'),
        effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: consumers, passWithNoTests: false, testTimeout: 20_000 } }
