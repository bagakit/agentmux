import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const root = new URL('../', import.meta.url)
const source = new URL('src/http.ts', root)
const original = await readFile(source, 'utf8')
const needle = "this.server.listen(this.record.port, '127.0.0.1')"
if (original.split(needle).length !== 2)
  throw new Error('Stable-origin mutation anchor must match exactly once.')
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}
const baseline = run('pnpm', ['build'])
if (baseline.status !== 0) throw new Error(baseline.stdout + baseline.stderr)
try {
  await writeFile(source, original.replace(needle, "this.server.listen(0, '127.0.0.1')"))
  const build = run('pnpm', ['build'])
  if (build.status !== 0) throw new Error(build.stdout + build.stderr)
  const mutant = run(process.execPath, [
    '--test',
    '--test-name-pattern=real process death',
    'test/owner.test.mjs',
  ])
  if (
    mutant.status === 0 ||
    !mutant.stdout.includes('real process death') ||
    !mutant.stdout.includes('fail 1')
  )
    throw new Error(
      'The source mutation was not killed by the cross-process origin test.\n' +
        mutant.stdout +
        mutant.stderr,
    )
  process.stdout.write(
    'Killed source mutation: choosing a new loopback port on recovery breaks the original origin after process death.\n',
  )
} finally {
  await writeFile(source, original)
  const restored = run('pnpm', ['build'])
  if (restored.status !== 0) throw new Error(restored.stdout + restored.stderr)
}
