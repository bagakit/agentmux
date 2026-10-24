import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './mote-default-join-consumer.config.mts'

const baseline = process.env.T042_CORE_REF
// Pin only changed Core modules once. Preserve their module ids and all peer files on disk.
const committed = new Map<string, string>()
if (baseline) {
  const changed = execFileSync('git', ['diff', '--name-only', baseline, '--', 'packages/core/src'], { cwd: original.root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  for (const path of changed) committed.set(path, execFileSync('git', ['show', `${baseline}:${path}`], { cwd: original.root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
}
const mutation = process.env.T042_MUTANT
if (mutation && mutation !== 'checkpoint-before-observe') throw Error('Unknown publication origin mutation')
export default defineConfig({ ...original, plugins: [{ name: 'publication-origin-consumer', enforce: 'pre', transform(source, id) {
  const path = relative(original.root!, id.split('?')[0]!)
  if (!/^(?:packages\/(?:core|connectors)|apps\/host)\/(?:src|test)\/.*\.(?:ts|mts)$/u.test(path)) return
  let code = committed.get(path) ?? source
  if (mutation && path === 'packages/connectors/src/publication-host.ts') {
    const before = 'if (!after && binding.publicationOrigin) await this.observeLane(lane)'
    if (code.split(before).length !== 2) throw Error('The exact original-source bootstrap must load once')
    code = code.replace(before, 'if (!after && binding.publicationOrigin) void 0')
  }
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const trace = process.env.T042_LOADED
  const row = { path, diskSHA256: hash(source), loadedSHA256: hash(code), ...(committed.has(path) ? { coreBaseline: baseline } : {}), ...(mutation && path === 'packages/connectors/src/publication-host.ts' ? { mutation } : {}) }
  if (trace) code = `import { appendFileSync as __t042Loaded } from 'node:fs'; __t042Loaded(${JSON.stringify(trace)}, ${JSON.stringify(JSON.stringify(row) + '\n')});\n` + code
  return { code, map: null }
} }, ...original.plugins!], test: { ...original.test, include: ['apps/host/test/publication-origin-consumer.test.ts'], testTimeout: 40_000 } })
