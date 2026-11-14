import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, realpath, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, URL as SourceURL } from 'node:url'
import { promisify } from 'node:util'
import { candidateResolve } from '../../scripts/candidate-package-resolve.mjs'
import { bundleIdentityRuntime } from '../../../../packages/identity/scripts/runtime-bundle.mjs'

const moduleFile = fileURLToPath(import.meta.url)
const sourceRoot = fileURLToPath(new SourceURL('../../../../', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')

/** Fixed current Core entry and original identity recipe; the caller owns this private output. */
export async function buildSourceCoreCli(root, temporary) {
  const cliPath = join(temporary, 'cli.mjs'), identityRuntime = join(temporary, 'identity.ts')
  const { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
  await symlink(join(root, 'packages/core/node_modules'), join(temporary, 'node_modules'), 'dir')
  const identity = await bundleIdentityRuntime()
  await writeFile(identityRuntime, `export const identityRuntimeSource = ${JSON.stringify(identity.source)};\n`)
  const compiled = await build({ absWorkingDir: root, entryPoints: ['packages/core/src/agentmux.ts'], outfile: cliPath,
    platform: 'node', target: 'node24', format: 'esm', bundle: true, metafile: true, logLevel: 'error',
    banner: { js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);" },
    plugins: [{ name: 'current-source-core-cli', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, async args => {
        if (args.pluginData?.sourceCliDependency) return
        if (args.path === '@agentmux/identity/runtime-source') return { path: identityRuntime }
        if (args.path.startsWith('@agentmux/')) return { path: candidateResolve(root, args.path, { source: true }) }
        if (isBuiltin(args.path)) return { path: args.path, external: true }
        const dependency = await builder.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir,
          kind: args.kind, namespace: args.namespace, pluginData: { sourceCliDependency: true } })
        return dependency.errors.length ? { errors: dependency.errors } : { path: dependency.path, external: true }
      })
    } }] })
  const inputs = Object.keys(compiled.metafile.inputs)
  assert.ok(inputs.includes(relative(root, identityRuntime)), 'The CLI must consume the fresh original identity module')
  assert.ok(!inputs.some(file => /^packages\/[^/]+\/dist\//u.test(file)), 'The CLI must consume first-party Source')
  return { sourceRoot: root, cliPath, identityRuntime,
    identity: { recipe: 'packages/identity/scripts/runtime-bundle.mjs', sha256: hash(await readFile(identityRuntime)) },
    cli: { sha256: hash(await readFile(cliPath)), inputs: Object.fromEntries(inputs.filter(file => file.startsWith('packages/')).map(file => [file, hash(readFileSync(join(root, file)))])) } }
}

/** Ordinary Vitest needs no environment bootstrap; build outside Vite and clean only our own temp. */
export async function prepareSourceCoreCli() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'amux-source-cli-')))
  try {
    await promisify(execFile)(process.execPath, [moduleFile, '--build', temporary], { cwd: sourceRoot, timeout: 60_000 })
    const receipt = JSON.parse(await readFile(join(temporary, 'source-cli-receipt.json'), 'utf8'))
    return { ...receipt, cleanup: () => rm(temporary, { recursive: true, force: true }) }
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
}

if (process.argv[1] && resolve(process.argv[1]) === moduleFile) {
  assert.ok(process.argv.length === 4 && process.argv[2] === '--build', 'Use --build PRIVATE_TEMP_DIRECTORY')
  const receipt = await buildSourceCoreCli(sourceRoot, process.argv[3])
  await writeFile(join(process.argv[3], 'source-cli-receipt.json'), JSON.stringify(receipt) + '\n')
}
