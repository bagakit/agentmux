import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import overview from '../apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts'

const scope = process.env.AMUX_PROTOCOL_SCOPE ?? 'reader'
const tests = {
  reader: ['packages/core/test/amux-protocol-catalog.test.ts', 'packages/client-ui/test/amux-protocol-cards.test.tsx',
    'packages/core/test/agent-message-render.test.ts', 'packages/core/test/agent-message-leading-context.test.ts', 'packages/core/test/agent-message-reference-reading.test.ts'],
  cards: ['packages/client-ui/test/amux-protocol-reading.test.tsx'],
  settings: ['apps/desktop/test/amux-protocol-settings.test.tsx']
}
const mutations = {
  'drop-generic': ['packages/core/src/agent-message-render.ts', 'const protocol = parseStandaloneProtocol(text)', 'const protocol = null'],
  'allow-invalid-known': ['packages/core/src/agent-message-render.ts', 'if (Object.values(AMUX_PROTOCOL_DEFINITIONS).some(definition => definition.tag === tag)) return null', 'if (false) return null'],
  'lose-opaque-body': ['packages/core/src/agent-message-render.ts', 'const body = selfClosing ? null : text.slice(header[0].length, -closing.length)', 'const body = null']
} as Record<string, readonly [string, string, string]>

export default defineConfig({
  ...overview,
  resolve: { ...overview.resolve, conditions: ['browser'] },
  plugins: [{ name: 'amux-protocol-source-proof', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(overview.root!) || !/\/(packages|apps)\/.*\.(ts|tsx)$/u.test(file)) return
    const relative = file.slice(overview.root!.length + 1)
    const mutation = process.env.AMUX_PROTOCOL_MUTATION ? mutations[process.env.AMUX_PROTOCOL_MUTATION] : undefined
    const original = code
    if (mutation && relative === mutation[0]) {
      if (!code.includes(mutation[1])) throw new Error(`Mutation anchor missing: ${relative}`)
      code = code.replace(mutation[1], mutation[2])
    }
    if (process.env.AMUX_PROTOCOL_LOADED) appendFileSync(process.env.AMUX_PROTOCOL_LOADED, JSON.stringify({ file: relative,
      sourceSHA256: createHash('sha256').update(original).digest('hex'), compilerInputSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }],
  test: { ...overview.test, include: tests[scope as keyof typeof tests] ?? [], maxWorkers: 1 }
})
