import { readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '../../..'), directory = resolve(repository, 'apps/desktop/scripts')
// These additional scripts belong to this Feature; the eight Goal entry points are discovered.
const additional = ['verify-goals-surface.mjs', 'package-runtime-upgrade.mjs', 'lib/verify-renderer-source-mutations.mjs']
const forbidden = /(?:^|[^\w])\.(?:bagakit|tmp|local)(?:[\\/]|(?=['"`]))/mu
function assertPortable(source: string, file: string) {
  if (file === 'lib/verify-renderer-source-mutations.mjs') {
    // The shared library retains its pre-existing non-Goal output default. Goal
    // summary supplies evidenceRoot explicitly; no process input selects this branch.
    const originalOutput = "evidenceRoot ? join(evidenceRoot, name) : join(root, '.tmp', name)"
    expect(source.split(originalOutput)).toHaveLength(2)
    source = source.replace(originalOutput, 'join(evidenceRoot, name)')
  }
  expect(source, 'A durable runner must not select a process-directory input or output.').not.toMatch(forbidden)
  if (/['"]git['"]/u.test(source)) expect(source, 'Current source cannot be substituted by a historical Git blob.').not.toMatch(/['"]show['"]/u)
}
const fixtureFiles = (await Promise.all(['goals-surface', 'goal-responsibility', 'goal-responsibility-native'].map(async fixture =>
  (await readdir(resolve(directory, 'fixtures', fixture), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(?:c|m)?[jt]sx?$/u.test(entry.name))
    .map(entry => relative(directory, resolve(entry.parentPath, entry.name)))))).flat()
const files = [...(await readdir(directory)).filter(file => /^verify-goal-.+\.mjs$/u.test(file)), ...additional, ...fixtureFiles].sort()
describe('current Goal verification source boundaries', () => {
  it('discovers the nonempty Goal runner set and includes the Feature script owners', async () => {
    expect(files.filter(file => file.startsWith('verify-goal-')).length).toBeGreaterThan(0)
    expect(new Set(files).size).toBe(files.length)
    for (const file of files) assertPortable(await readFile(resolve(directory, file), 'utf8'), file)
    expect(await readFile(resolve(directory, 'verify-goal-summary.mjs'), 'utf8')).toMatch(/evidenceRoot: evidence/u)
  })
  it.each(['.bagakit/private.json', '.tmp/private.json', '.local/private.json'])('refuses a process-directory read reintroduced into every actual Goal runner: %s', async path => {
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = await readFile(resolve(directory, file), 'utf8')
      expect(() => assertPortable(source + '\nawait readFile(' + JSON.stringify(path) + ', "utf8")', file)).toThrow()
    }
  })
  it('refuses a historical blob read in an actual current runner', async () => {
    const source = await readFile(resolve(directory, files[0]!), 'utf8')
    expect(() => assertPortable(source + '\nspawnSync("git", ["show", "old:path"])', files[0]!)).toThrow()
  })
})
