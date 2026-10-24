import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './mote-default-join-consumer.config.mts'

const mutation = process.env.T040_MUTANT
if (mutation && mutation !== 'forget-watch-failure') throw Error('Unknown publication watch mutation')
export default defineConfig({ ...original, plugins: [{ name: 'publication-watch-consumer', enforce: 'pre', transform(source, id) {
  const path = relative(original.root!, id.split('?')[0]!)
  if (!/^(?:packages\/(?:core|connectors)|apps\/host)\/(?:src|test)\/.*\.(?:ts|mts)$/u.test(path)) return
  let code = source
  if (mutation && path === 'packages/connectors/src/publication-host.ts') {
    const before = 'watch.failure = { ...(code ? { code } : {}) }'
    if (code.split(before).length !== 2) throw Error('The exact publication watch failure must load once')
    code = code.replace(before, 'delete watch.failure')
  }
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const trace = process.env.T040_LOADED
  const row = { path, originalSHA256: hash(source), loadedSHA256: hash(code), ...(source !== code ? { mutation } : {}) }
  if (trace) code = `import { appendFileSync as __t040Loaded } from 'node:fs'; __t040Loaded(${JSON.stringify(trace)}, ${JSON.stringify(JSON.stringify(row) + '\n')});\n` + code
  if (source !== code) return { code, map: null }
} }, ...original.plugins!], test: { ...original.test, include: ['apps/host/test/publication-watch-consumer.test.ts'], testTimeout: 25_000 } })
