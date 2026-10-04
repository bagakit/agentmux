import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const artifacts = join(root, '.tmp/daemon-diagnostic-lifetime-mutations')
await mkdir(artifacts, { recursive: true })
const scratch = await mkdtemp(join(artifacts, 'source-'))
const core = join(scratch, 'packages/core')
await mkdir(core, { recursive: true })
for (const name of ['src', 'vendor']) {
  execFileSync('cp', ['-cR', join(root, 'packages/core', name), join(core, name)])
}
await mkdir(join(core, 'test'), { recursive: true })
await cp(join(root, 'packages/core/test/ctxmux-daemon-diagnostic-lifetime.test.ts'),
  join(core, 'test/ctxmux-daemon-diagnostic-lifetime.test.ts'))
await cp(join(root, 'packages/core/package.json'), join(core, 'package.json'))
await symlink(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
await symlink(join(root, 'packages/core/node_modules'), join(core, 'node_modules'), 'dir')
const configuration = join(scratch, 'vitest.config.mts')
await writeFile(configuration, `import { defineConfig } from 'vitest/config'; export default defineConfig({test:{include:['packages/core/test/ctxmux-daemon-diagnostic-lifetime.test.ts'],environment:'node',maxWorkers:1,passWithNoTests:false}})\n`)
const file = join(core, 'src/ctxmux-run-adapter.ts')
const original = await readFile(file, 'utf8')
const caller = 'async connect(): Promise<void>'
if (!original.includes(caller) || !original.includes('stderrStream?.on(\'data\'')) throw new Error('actual production connect/drain caller absent')
const mutants = [
  { id: 'destroy-after-readiness', needle: '    const client = new CtxmuxClient({\n      socketPath: this.socketPath,', replacement: '    childDiagnosticLifetimeMutant()\n    const client = new CtxmuxClient({\n      socketPath: this.socketPath,' },
  { id: 'omit-unref', needle: '      if (stderrStream instanceof Socket) stderrStream.unref()', replacement: '      // mutant: leave diagnostic channel referenced' },
  { id: 'diagnostic-error-disconnects', needle: '      stderrStream?.on(\'error\', (error) => {', replacement: '      stderrStream?.on(\'error\', (error) => {\n        this.markConnectionLost()' }
]
// Inject at the precise successful-readiness seam while the real child pipe is still in scope.
mutants[0] = { id: 'destroy-after-readiness',
  needle: '        this.runtimeOwnership = \'unverified\'\n        }\n      } catch (error) {',
  replacement: '        this.runtimeOwnership = \'unverified\'\n        }\n        stderrStream?.destroy()\n      } catch (error) {' }
function run(id, expectedPass) {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configuration],
    { cwd: scratch, encoding: 'utf8', timeout: 30_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return writeFile(join(artifacts, `${id}.log`), output).then(() => {
    if (expectedPass ? result.status !== 0 : result.status === 0 || !/AssertionError/.test(output)) {
      throw new Error(`${id} did not prove ${expectedPass ? 'restored GREEN' : 'loaded assertion RED'}; inspect its log`)
    }
    if (!/ctxmux-daemon-diagnostic-lifetime\.test\.ts/.test(output)) throw new Error('owning production test was not loaded')
    return { id, status: result.status, assertionRed: !expectedPass }
  })
}
const results = [await run('baseline', true)]
for (const mutant of mutants) {
  if (original.split(mutant.needle).length !== 2) throw new Error(`${mutant.id}: expected one exact seam`)
  await writeFile(file, original.replace(mutant.needle, mutant.replacement))
  try { results.push(await run(mutant.id, false)) }
  finally { await writeFile(file, original) }
  results.push(await run(`${mutant.id}-restored`, true))
}
await writeFile(join(artifacts, 'receipt.json'), JSON.stringify({
  sourceSha256: createHash('sha256').update(original).digest('hex'), productionCaller: caller,
  test: 'packages/core/test/ctxmux-daemon-diagnostic-lifetime.test.ts', results
}, null, 2) + '\n')
console.log(JSON.stringify({ mutations: mutants.length, assertionsRed: mutants.length, restoredGreen: mutants.length }))
