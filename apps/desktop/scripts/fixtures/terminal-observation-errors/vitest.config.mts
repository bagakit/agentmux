import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../terminal-frame-lifetime/vitest.config.mts'

const terminal = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const classifier = 'apps/desktop/src/renderer/src/lib/terminal-initial-observation-recovery.ts'
const tracked = new Set([terminal, classifier, 'apps/desktop/test/terminal-incident-product.test.tsx',
  'apps/desktop/test/terminal-observation-error.test.ts', 'apps/desktop/src/renderer/src/lib/client-incident-recorder.ts'])
const mutations = {
  accessor: [classifier,
    "const code = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined",
    'const code = (error as { code?: unknown } | null)?.code'],
  cause: [terminal, 'automatic ? initialFailureOccurrence : undefined) : undefined',
    'automatic ? initialFailureOccurrence : null) : undefined']
} as const
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'terminal-observation-errors', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!tracked.has(path)) return
    const name = process.env.AGENTMUX_TERMINAL_ERROR_MUTATION
    let code = source
    if (name) {
      assert.ok(Object.hasOwn(mutations, name), 'Unknown terminal error mutation')
      const [target, from, to] = mutations[name as keyof typeof mutations]
      if (target === path) {
        assert.equal(code.split(from).length - 1, 1, 'Mutation requires exactly one original anchor')
        code = code.replace(from, to)
      }
    }
    if (process.env.AGENTMUX_TERMINAL_ERROR_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_ERROR_LOADED,
      JSON.stringify({ path, mutation: name ?? null, sourceSHA256: createHash('sha256').update(source).digest('hex'),
        effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: [...base.test!.include!, 'apps/desktop/test/terminal-observation-error.test.ts'] } }
