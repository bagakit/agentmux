import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mutateDefaultShell } from './mutations.mjs'

const root = resolve(import.meta.dirname, '../../../../..')
const require = createRequire(resolve(root, 'packages/core/package.json'))
const { build } = require('esbuild')
const hash = (value) => createHash('sha256').update(value).digest('hex')

/** Compile only this real consumer graph, preserving each source module's asset base. */
export async function buildDefaultShellFixture(output, mutation) {
  await mkdir(output, { recursive: true })
  const inputs = {},
    consumed = []
  const plugins = [
    {
      name: 'current-toolkit-default-shell-consumers',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'private-app-paths',
        }))
        builder.onLoad(
          { filter: /.*/, namespace: 'private-app-paths' },
          () => ({
            loader: 'js',
            contents: `export const app = { isPackaged: false, getPath: () => process.argv[3], getAppPath: () => process.argv[3] };
       export const nativeImage = {}, shell = {}, clipboard = {}, dialog = {}, safeStorage = {};
       export const nativeTheme = { shouldUseDarkColors: false };`,
          }),
        )
        builder.onResolve({ filter: /^@agentmux\// }, async (args) => {
          const name = args.path.split('/')[1],
            base = resolve(root, 'packages', name)
          const manifestPath = resolve(base, 'package.json'),
            manifestSource = await readFile(manifestPath, 'utf8')
          inputs[relative(root, manifestPath)] = hash(manifestSource)
          const manifest = JSON.parse(manifestSource)
          const key =
            args.path === '@agentmux/' + name
              ? '.'
              : '.' + args.path.slice(('@agentmux/' + name).length)
          const pattern = Object.keys(manifest.exports).find(
            (value) =>
              value.includes('*') &&
              key.startsWith(value.split('*')[0]) &&
              key.endsWith(value.split('*')[1]),
          )
          const entry = manifest.exports[key] ?? manifest.exports[pattern]
          let target = typeof entry === 'string' ? entry : entry?.import
          assert.equal(
            typeof target,
            'string',
            'Fixture consumes a declared package import export: ' + args.path,
          )
          if (target.includes('*'))
            target = target.replace(
              '*',
              key.slice(
                pattern.split('*')[0].length,
                pattern.split('*')[1]
                  ? -pattern.split('*')[1].length
                  : undefined,
              ),
            )
          const source = ['core', 'demand', 'layout'].includes(name)
          const path = resolve(
            base,
            source
              ? target
                  .replace('./dist/src/', './src/')
                  .replace('./dist/', './src/')
                  .replace(/\.js$/u, '.ts')
              : target,
          )
          if (!source) inputs[relative(root, path)] = hash(await readFile(path))
          return { path, external: !source }
        })
        builder.onResolve({ filter: /^[^./]/ }, async (args) => {
          if (args.pluginData?.externalResolution) return
          if (isBuiltin(args.path)) return { path: args.path, external: true }
          const found = await builder.resolve(args.path, {
            resolveDir: args.resolveDir,
            kind: 'import-statement',
            pluginData: { externalResolution: true },
          })
          assert.equal(
            found.errors.length,
            0,
            'Existing dependency must resolve through its import contract: ' +
              args.path,
          )
          inputs[relative(root, found.path)] = hash(await readFile(found.path))
          return { path: found.path, external: true }
        })
        builder.onLoad({ filter: /\.(?:ts|js|mjs|json)$/ }, async (args) => {
          if (args.path.includes('/node_modules/')) return
          const original = await readFile(args.path, 'utf8'),
            path = relative(root, args.path)
          inputs[path] = hash(original)
          let source = mutateDefaultShell(original, path, mutation)
          consumed.push({
            path,
            originalSHA256: hash(original),
            consumedSHA256: hash(source),
          })
          // Bundling must not relocate Native artifacts, filesystem guides or createRequire.
          source = source
            .replaceAll(
              'import.meta.url',
              JSON.stringify(pathToFileURL(args.path).href),
            )
            .replaceAll(
              'import.meta.dirname',
              JSON.stringify(dirname(args.path)),
            )
          return {
            contents: source,
            loader: args.path.endsWith('.ts')
              ? 'ts'
              : args.path.endsWith('.json')
                ? 'json'
                : 'js',
            resolveDir: dirname(args.path),
          }
        })
      },
    },
  ]
  const files = {
    worker: 'apps/desktop/scripts/fixtures/toolkit-default-shell/worker.ts',
    cli: 'packages/core/src/agentmux.ts',
  }
  const compiled = {}
  for (const [name, entry] of Object.entries(files)) {
    const path = resolve(output, name + '.mjs')
    await build({
      entryPoints: [resolve(root, entry)],
      outfile: path,
      plugins,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      logLevel: 'silent',
    })
    compiled[relative(root, path)] = hash(await readFile(path))
  }
  for (const file of ['build.mjs', 'mutations.mjs']) {
    const path = relative(root, resolve(import.meta.dirname, file))
    inputs[path] = hash(await readFile(resolve(root, path)))
  }
  const receipt = { inputs, consumed, compiled, mutation: mutation ?? null }
  await writeFile(
    resolve(output, 'source.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  )
  return {
    worker: resolve(output, 'worker.mjs'),
    cli: resolve(output, 'cli.mjs'),
    ...receipt,
  }
}
