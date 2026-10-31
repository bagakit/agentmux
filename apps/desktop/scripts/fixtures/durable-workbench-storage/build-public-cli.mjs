import { createRequire, isBuiltin } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Compile the actual CLI and its current workspace sources for the private RPC proof. */
export async function buildStoragePublicCli(output) {
  const require = createRequire(resolve('packages/core/package.json'))
  const { build, transform } = require('esbuild')
  const out = resolve(output)
  await mkdir(dirname(out), { recursive: true })
  const { bundleIdentityRuntime } = await import(pathToFileURL(resolve('packages/identity/scripts/runtime-bundle.mjs')).href)
  const identity = await bundleIdentityRuntime()
  const generated = resolve(dirname(out), 'identity-runtime-source.mjs')
  await writeFile(generated, `export const identityRuntimeSource = ${JSON.stringify(identity.source)};`)
  await build({
    entryPoints: [resolve('packages/core/src/agentmux.ts')], outfile: out, bundle: true,
    platform: 'node', format: 'esm', target: 'node24', logLevel: 'error',
    banner: { js: 'import {createRequire as cliRequire} from "node:module";const require=cliRequire(import.meta.url);' },
    plugins: [{ name: 'current-public-cli', setup(build) {
      build.onResolve({ filter: /^[^./]|^@/ }, async args => {
        if (args.pluginData?.resolvedDependency) return
        if (isBuiltin(args.path)) return { path: args.path, external: true }
        if (args.path === '@agentmux/identity/runtime-source') return { path: generated }
        if (args.path === '@agentmux/identity/runtime') return { path: resolve('packages/identity/src/runtime-entry.ts') }
        if (args.path.startsWith('@agentmux/')) {
          const [, pkg, ...tail] = args.path.split('/')
          const dir = resolve(pkg === 'host' ? 'apps' : 'packages', pkg)
          const manifest = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'))
          const entry = tail.length ? './' + tail.join('/') : '.'
          const exp = manifest.exports[entry]
          if (!exp) throw Error('Missing current public export: ' + args.path)
          const file = exp.import.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts')
          return { path: resolve(dir, file) }
        }
        const result = await build.resolve(args.path, { resolveDir: dirname(args.importer),
          kind: 'import-statement', pluginData: { resolvedDependency: true } })
        return { path: result.path, external: true, errors: result.errors }
      })
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => ({
        contents: (await transform(await readFile(args.path, 'utf8'), {
          loader: args.path.endsWith('.ts') ? 'ts' : 'js', format: 'esm', target: 'node24',
          define: { 'import.meta.url': JSON.stringify(pathToFileURL(args.path).href),
            'import.meta.dirname': JSON.stringify(dirname(args.path)) }
        })).code,
        loader: 'js'
      }))
    } }]
  })
  return out
}
