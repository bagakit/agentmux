import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const root = new URL('../', import.meta.url)
const source = new URL('src/node.ts', root)
const original = await readFile(source, 'utf8')
const needle = 'this.options.replies!.inspect(structuredClone(prepared), ctx)'
if (original.split(needle).length !== 2)
  throw new Error('Original-input observation mutation anchor must match exactly once.')
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}
const baseline = run('pnpm', ['build'])
if (baseline.status !== 0) throw new Error(baseline.stdout + baseline.stderr)
try {
  await writeFile(
    source,
    original.replace(needle, 'this.options.replies!.submit(structuredClone(prepared), ctx)'),
  )
  const build = run('pnpm', ['build'])
  if (build.status !== 0) throw new Error(build.stdout + build.stderr)
  const mutant = run(process.execPath, [
    '--test',
    '--test-name-pattern=unknown reply submission',
    'test/reply.test.mjs',
  ])
  if (
    mutant.status === 0 ||
    !mutant.stdout.includes('unknown reply submission') ||
    !mutant.stdout.includes('fail 1')
  )
    throw new Error(
      'The source mutation was not killed by the original-input replay test.\n' +
        mutant.stdout +
        mutant.stderr,
    )
  process.stdout.write(
    'Killed source mutation: replaying submit during original-input inspection duplicates the saved Human reply.\n',
  )
} finally {
  await writeFile(source, original)
  const restored = run('pnpm', ['build'])
  if (restored.status !== 0) throw new Error(restored.stdout + restored.stderr)
}
