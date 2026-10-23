import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const root = new URL('../', import.meta.url)
const source = new URL('src/node.ts', root)
const original = await readFile(source, 'utf8')
const mutations = [
  {
    name: 'observe the original input without replay',
    needle: 'this.options.replies!.inspect(structuredClone(prepared), ctx)',
    replacement: 'this.options.replies!.submit(structuredClone(prepared), ctx)',
    test: 'unknown reply submission',
  },
  {
    name: 'inspect the original reserved input before prepare',
    needle: 'return parseCapsuleOperation({ ...operation, inputOperationId: saved.effect.inputOperationId })',
    replacement: 'return parseCapsuleOperation(operation)',
    test: 'trusted reply saves exact answer',
  },
]
for (const mutation of mutations) {
  if (original.split(mutation.needle).length !== 2)
    throw new Error(`${mutation.name} mutation anchor must match exactly once.`)
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}
const baseline = run('pnpm', ['build'])
if (baseline.status !== 0) throw new Error(baseline.stdout + baseline.stderr)
try {
  for (const mutation of mutations) {
    await writeFile(source, original.replace(mutation.needle, mutation.replacement))
    const build = run('pnpm', ['build'])
    if (build.status !== 0) throw new Error(build.stdout + build.stderr)
    const mutant = run(process.execPath, [
      '--test',
      `--test-name-pattern=${mutation.test}`,
      'test/reply.test.mjs',
    ])
    if (
      mutant.status === 0 ||
      !mutant.stdout.includes(mutation.test) ||
      !mutant.stdout.includes('fail 1')
    )
      throw new Error(`The source mutation was not killed: ${mutation.name}.\n` + mutant.stdout + mutant.stderr)
    process.stdout.write(`Killed source mutation: ${mutation.name}.\n`)
  }
} finally {
  await writeFile(source, original)
  const restored = run('pnpm', ['build'])
  if (restored.status !== 0) throw new Error(restored.stdout + restored.stderr)
}
