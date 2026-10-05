import { fixturePath } from './helpers/fixture-values.js'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const mutations = {
  'no-padding': [".padStart(12, '1')", ".padStart(0, '1')"],
  'accept-overflow': ['id.length <= 12', 'id.length <= 13'],
  'truncate-entropy': ['base58.encode(bytes)', 'base58.encode(bytes.slice(0, 8))'],
  'ignore-operation': ['${key}', 'same-operation'],
  'ignore-domain': ['${domain}', 'same-domain'],
  'accept-invalid-domain': ["if (!domain || domain.includes(':'))", 'if (false)']
} as const
export default defineConfig({
  resolve: { alias: { '@agentmux/identity': new URL('../../identity/src/index.ts', import.meta.url).pathname } },
  plugins: [{ name: 'agent-id-mutations', enforce: 'pre', transform(source, id) {
    if (!id.split('?')[0]?.endsWith("/packages/identity/src/index.ts")) return
    const mutation = process.env.AGENT_ID_MUTATION as keyof typeof mutations | undefined
    let code = source
    if (mutation) {
      const [before, after] = mutations[mutation]
      if (!code.includes(before)) throw new Error('Mutation did not load its production target: ' + mutation)
      code = code.replace(before, after)
    }
    if (process.env.AGENT_ID_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENT_ID_LOADED, JSON.stringify({ id, mutation: mutation ?? null, sourceSHA: hash(source), loadedSHA: hash(code) }) + '\n')
    }
    return { code, map: null }
  } }],
  test: { include: ['packages/core/test/agent-session-id.test.ts', 'packages/core/test/object-id.test.ts'], maxWorkers: 1 }
})
