import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const require = createRequire(import.meta.url)
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** Compile actual package inputs privately; mutations never reach shared consumers. */
export async function runIsolatedCapsuleMutations(sourcePath, testFile, mutations) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-mutation-'))
  // Existing child fixtures bind the real package's storage load by this suffix.
  const capsule = join(directory, 'capsule')
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: capsule, encoding: 'utf8', timeout: 30000 })
    if (result.error) throw result.error
    return result
  }
  const build = () =>
    run(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      '--project',
      join(capsule, 'tsconfig.json'),
    ])
  const test = (pattern) =>
    run(process.execPath, [
      '--test',
      '--test-reporter=tap',
      `--test-name-pattern=${pattern}`,
      testFile,
    ])
  try {
    await mkdir(capsule)
    await cp(new URL('src', root), join(capsule, 'src'), { recursive: true })
    await cp(new URL('test', root), join(capsule, 'test'), { recursive: true })
    await writeFile(join(capsule, 'package.json'), JSON.stringify({ type: 'module' }))
    await symlink(
      fileURLToPath(new URL('node_modules', root)),
      join(capsule, 'node_modules'),
      'dir',
    )
    await writeFile(
      join(capsule, 'tsconfig.json'),
      JSON.stringify({
        extends: fileURLToPath(new URL('tsconfig.json', root)),
        compilerOptions: {
          rootDir: './src',
          outDir: './dist',
          incremental: false,
          composite: false,
        },
        include: ['src/**/*.ts'],
        exclude: [],
      }),
    )
    const source = join(capsule, sourcePath)
    const original = await readFile(source, 'utf8')
    assert.ok(mutations.length, 'An empty mutation set cannot prove these boundaries.')
    for (const mutation of mutations) {
      assert.equal(
        original.split(mutation.needle).length,
        2,
        `Mutation anchor must match exactly once: ${mutation.name}`,
      )
    }
    const compiled = build()
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
    const baseline = test(mutations.map(({ test }) => test).join('|'))
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
    assert.match(baseline.stdout, new RegExp(`^# pass ${mutations.length}$`, 'mu'))
    assert.match(baseline.stdout, /^# fail 0$/mu)
    for (const mutation of mutations) {
      await writeFile(source, original.replace(mutation.needle, mutation.replacement))
      const compiledMutant = build()
      assert.equal(compiledMutant.status, 0, compiledMutant.stdout + compiledMutant.stderr)
      const mutant = test(mutation.test)
      assert.equal(
        mutant.status,
        1,
        `Production mutation survived: ${mutation.name}.\n${mutant.stdout}${mutant.stderr}`,
      )
      // Collection errors, empty suites and killed/timed-out processes cannot sign semantic RED.
      assert.match(
        mutant.stdout,
        new RegExp(`^not ok \\d+ - .*${escapePattern(mutation.test)}`, 'mu'),
      )
      assert.match(mutant.stdout, /^# fail 1$/mu)
      assert.match(mutant.stdout, /^# cancelled 0$/mu)
      process.stdout.write(`Killed isolated production mutation: ${mutation.name}.\n`)
      await writeFile(source, original)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
