import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const mutations = [
  {
    name: 'callback consumes only the original pending operation',
    source: 'src/runtime-client.ts',
    needle: 'assertCallbackBinding(message.method, message.input, call.method, call.params)',
    replacement: 'void call.params',
    test: 'callback wire cannot redirect original client authority',
  },
  {
    name: 'runtime domain identity survives a serving process replacement',
    source: 'src/runtime-server.ts',
    needle: 'runtimeId = (saved as { runtimeId: string }).runtimeId',
    replacement: 'runtimeId = mintObjectId()',
    test: 'process death keeps domain page origin',
  },
]
const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-runtime-mutation-'))
const require = createRequire(import.meta.url)
function run(command, args) {
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', timeout: 30000 })
  if (result.error) throw result.error
  return result
}
try {
  // Compile exact production inputs in a separate package; concurrent consumers
  // never observe a temporary mutant in the checkout or shared dist artifacts.
  await cp(new URL('src', root), join(directory, 'src'), { recursive: true })
  await cp(new URL('test', root), join(directory, 'test'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
  await symlink(
    fileURLToPath(new URL('node_modules', root)),
    join(directory, 'node_modules'),
    'dir',
  )
  await writeFile(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      extends: fileURLToPath(new URL('tsconfig.json', root)),
      compilerOptions: { rootDir: './src', outDir: './dist', incremental: false, composite: false },
      include: ['src/**/*.ts'],
      exclude: [],
    }),
  )
  const originals = new Map()
  for (const mutation of mutations) {
    const original = await readFile(join(directory, mutation.source), 'utf8')
    if (original.split(mutation.needle).length !== 2)
      throw new Error(`Mutation anchor must match once: ${mutation.name}`)
    originals.set(mutation.source, original)
  }
  const build = () =>
    run(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      '--project',
      join(directory, 'tsconfig.json'),
    ])
  const baseline = build()
  if (baseline.status !== 0) throw new Error(baseline.stdout + baseline.stderr)
  const green = run(process.execPath, [
    '--test',
    `--test-name-pattern=${mutations.map(({ test }) => test).join('|')}`,
    'test/runtime.test.mjs',
  ])
  if (green.status !== 0 || !green.stdout.includes('pass 2'))
    throw new Error(green.stdout + green.stderr)
  for (const mutation of mutations) {
    const source = join(directory, mutation.source)
    const original = originals.get(mutation.source)
    await writeFile(source, original.replace(mutation.needle, mutation.replacement))
    const compiled = build()
    if (compiled.status !== 0) throw new Error(compiled.stdout + compiled.stderr)
    const mutant = run(process.execPath, [
      '--test',
      `--test-name-pattern=${mutation.test}`,
      'test/runtime.test.mjs',
    ])
    if (
      mutant.status === 0 ||
      !mutant.stdout.includes(mutation.test) ||
      !mutant.stdout.includes('fail 1')
    ) {
      throw new Error(
        `Production mutation survived: ${mutation.name}.\n${mutant.stdout}${mutant.stderr}`,
      )
    }
    process.stdout.write(`Killed production mutation: ${mutation.name}.\n`)
    await writeFile(source, original)
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
