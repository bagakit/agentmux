import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const mutations = {
  'no-padding': [".padStart(17, '1')", ".padStart(0, '1')"],
  'truncate-entropy': ['base58.encode(bytes)', 'base58.encode(bytes.slice(0, 11))'],
  'ignore-operation': ['${operationId}', 'same-operation']
} as const
export default defineConfig({
  plugins: [{ name: 'agent-id-mutations', enforce: 'pre', transform(source, id) {
    if (!id.split('?')[0]?.endsWith('/packages/core/src/agent-session-id.ts')) return
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
  test: { include: ['packages/core/test/agent-session-id.test.ts'], maxWorkers: 1 }
})
