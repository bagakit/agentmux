import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.CHANNEL_OWNER_MUTANT
const variants: Record<string, { path: string; before: string; after: string }> = {
  'duplicate-owner': { path: 'packages/connectors/src/connection-services.ts', before: 'if (!native.tryLock(fd))', after: 'if (false)' },
  'no-recovery': { path: 'packages/connectors/src/connection-services.ts', before: 'if (!closed && !live) void ensure()', after: 'if (false) void ensure()' },
  'no-release': { path: 'packages/connectors/src/connection-services.ts', before: 'if (live?.lease !== undefined) closeSync(live.lease)', after: 'if (false && live?.lease !== undefined) closeSync(live.lease)' },
  'drop-administration-authority': { path: 'packages/connectors/src/connection-services.ts', before: '.secrets.store(input, assertCurrent)', after: '.secrets.store(input)' }
}
if (mutation && !variants[mutation]) throw Error('Unknown Host owner mutation')
export default defineConfig({ root, resolve: { alias: [
  { find: /^@agentmux\/core$/u, replacement: resolve(root, 'packages/core/src/index.ts') },
  { find: /^@agentmux\/core\/(.+)$/u, replacement: resolve(root, 'packages/core/src/$1.ts') },
  { find: /^@agentmux\/connectors$/u, replacement: resolve(root, 'packages/connectors/src/index.ts') }
] }, plugins: [{ name: 'loaded-connection-owner', enforce: 'pre', transform(input, id) {
  const path = relative(root, id.split('?')[0]!), selected = mutation ? variants[mutation] : undefined
  let code = input
  if (selected?.path === path) {
    if (code.split(selected.before).length !== 2) throw Error('Owner mutation anchor must load exactly once')
    code = code.replace(selected.before, selected.after)
  }
  if (process.env.CHANNEL_OWNER_TRACE && path === 'packages/connectors/src/connection-services.ts') {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.CHANNEL_OWNER_TRACE, JSON.stringify({ path, sourceSHA: hash(readFileSync(id.split('?')[0]!, 'utf8')), inputSHA: hash(input), loadedSHA: hash(code), mutation: selected?.path === path ? mutation : null }) + '\n')
  }
  if (code !== input) return code
} }], test: { include: ['packages/connectors/test/connection-services-owner.test.ts'], passWithNoTests: false, fileParallelism: false } })
