import { createRequire, findPackageJSON, isBuiltin } from 'node:module'
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** The identity package deliberately generates this string asset; it has no TS source counterpart. */
function publicSourceEntry(directory: string, specifier: string, target: string): string {
  if (specifier === '@agentmux/identity/runtime-source') return resolve(directory, target)
  if (specifier === '@agentmux/identity/runtime') return resolve(directory, 'src/runtime-entry.ts')
  return resolve(directory, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
}

/** The original listener worker is a shipped asset; stage only that current Source asset for this WT. */
export async function stageMoteSourceListener() {
  const root = resolve(import.meta.dirname, '../../../..')
  const ts = createRequire(join(root, 'node_modules/typescript/package.json'))('./lib/typescript.js') as typeof import('typescript')
  const source = readFileSync(join(root, 'packages/core/src/control-endpoint-listener-worker.ts'), 'utf8')
  const path = join(root, 'packages/core/dist/control-endpoint-listener-worker.js')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
}

export async function moteRendererImportGraph() {
  const root = resolve(import.meta.dirname, '../../../..')
  const deps = dirname(realpathSync(join(root, 'node_modules')))
  const vitestRequire = createRequire(realpathSync(join(root, 'node_modules/vitest/package.json')))
  const { build } = createRequire(vitestRequire.resolve('vite/package.json'))('esbuild') as typeof import('esbuild')
  const result = await build({ entryPoints: [join(root, 'apps/desktop/src/renderer/src/lib/mote-context-observation.ts')],
    bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent', external: ['zod'],
    nodePaths: [join(deps, 'packages/core/node_modules'), join(deps, 'packages/identity/node_modules')],
    plugins: [{ name: 'actual-browser-control-source', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\/core\/control$/ }, () => ({ path: join(root, 'packages/core/src/control.ts') }))
      builder.onResolve({ filter: /^@agentmux\/identity$/ }, () => ({ path: join(root, 'packages/identity/src/index.ts') }))
    } }] })
  return result.metafile!
}

/** Build and invoke the actual CLI entry, with the same Source variants as the Vite consumer. */
export async function sourceMoteDiagnosticsCli(directory: string, options: { mutations?: string; loaded?: string; ssr?: boolean } = {}) {
  const root = resolve(import.meta.dirname, '../../../..'), deps = dirname(realpathSync(join(root, 'node_modules')))
  const vitestRequire = createRequire(realpathSync(join(root, 'node_modules/vitest/package.json')))
  const viteRequire = createRequire(vitestRequire.resolve('vite/package.json'))
  const { build } = viteRequire('esbuild') as typeof import('esbuild')
  const mutations = options.mutations ?? process.env.AGENTMUX_MOTE_DIAGNOSTICS_MUTATIONS
  const changed: Record<string, string> = mutations ? JSON.parse(readFileSync(mutations, 'utf8')) : {}
  const cli = join(directory, 'mote-diagnostics-cli.mjs')
  const dependency = (specifier: string, original: string): string => {
    try { return createRequire(original).resolve(specifier) }
    catch (error) {
      // Import-only installed packages still use their actual declared ESM export.
      const manifestPath = findPackageJSON(specifier, pathToFileURL(original).href)
      if (!manifestPath) throw error
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      const entry = specifier === packageName ? '.' : '.' + specifier.slice(packageName!.length)
      let target = Object.hasOwn(manifest.exports, entry) ? manifest.exports[entry] : entry === '.' ? manifest.exports : undefined
      while (target && typeof target === 'object') target = target.import ?? target.node ?? target.default
      if (typeof target !== 'string') throw error
      return resolve(dirname(manifestPath), target)
    }
  }
  const ssrInputs: string[] = []
  const built = options.ssr ? await (async () => {
    // Dynamic native dependencies retain the original Core dependency root.
    await symlink(join(deps, 'packages/core/node_modules'), join(directory, 'node_modules'))
    const vite = await import(pathToFileURL(viteRequire.resolve('vite')).href) as typeof import('vite')
    await vite.build({ configFile: false, root, logLevel: 'silent', plugins: [{ name: 'original-public-diagnostic-cli', enforce: 'pre',
      resolveId(specifier, importer) {
        if (specifier.startsWith('@agentmux/')) {
          const [, name] = /^@agentmux\/([^/]+)/.exec(specifier)!
          const directory = join(root, 'packages', name!), manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
          const entry = specifier === `@agentmux/${name}` ? '.' : '.' + specifier.slice(`@agentmux/${name}`.length)
          const target = manifest.exports[entry]?.import
          if (!target) throw new Error('Missing current public CLI export: ' + specifier)
          const path = publicSourceEntry(directory, specifier, target)
          if (!existsSync(path)) throw new Error('Missing current public CLI source: ' + path)
          return path
        }
        if (!/^[^./]/.test(specifier) || specifier.startsWith('\0')) return
        if (isBuiltin(specifier)) return { id: specifier, external: true }
        const original = join(deps, relative(root, importer || join(root, 'packages/core/src/agentmux.ts')))
        return { id: dependency(specifier, original), external: true }
      },
      transform(source, id) {
        const absolute = id.split('?')[0]!, path = relative(root, absolute)
        if (!/\.[cm]?tsx?$/.test(absolute) || id.includes('?') || !(path.startsWith('packages/') || path.startsWith('apps/')) || path.includes('node_modules/')) return
        ssrInputs.push(path)
        const code = changed[absolute] ?? changed[path] ?? source
        if (options.loaded) appendFileSync(options.loaded, JSON.stringify({ consumer: 'actual-source-cli', path,
          originalSha256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
        return code === source ? undefined : { code, map: null }
      }
    }], build: { ssr: true, minify: false, emptyOutDir: false, outDir: directory, target: 'node24',
      rollupOptions: { input: join(root, 'packages/core/src/agentmux.ts'), output: { format: 'es', entryFileNames: 'mote-diagnostics-cli.mjs' } } } })
    return { metafile: { inputs: Object.fromEntries(ssrInputs.map(path => [path, {}])) } }
  })() : await build({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: cli,
    platform: 'node', target: 'node24', format: 'esm', bundle: true, metafile: true, logLevel: 'silent',
    plugins: [{ name: 'current-workspace-public-source', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\// }, args => {
        const [, name] = /^@agentmux\/([^/]+)/.exec(args.path)!
        const directory = join(root, 'packages', name!)
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        const entry = args.path === `@agentmux/${name}` ? '.' : '.' + args.path.slice(`@agentmux/${name}`.length)
        const target = manifest.exports[entry]?.import
        if (!target) throw new Error('Unmapped current public CLI import: ' + args.path)
        const path = publicSourceEntry(directory, args.path, target)
        if (!existsSync(path)) throw new Error('Missing current public CLI source: ' + path)
        return { path }
      })
      builder.onResolve({ filter: /^[^./]/ }, args => {
        if (isBuiltin(args.path)) return { path: args.path, external: true }
        const original = join(deps, relative(root, args.importer || join(root, 'packages/core/src/agentmux.ts')))
        return { path: dependency(args.path, original), external: true }
      })
      builder.onLoad({ filter: /\.[cm]?tsx?$/ }, args => {
        const source = readFileSync(args.path, 'utf8'), path = relative(root, args.path)
        const contents = changed[args.path] ?? changed[path] ?? source
        if (options.loaded && !path.startsWith('..') && !path.includes('node_modules/')) appendFileSync(options.loaded,
          JSON.stringify({ consumer: 'actual-source-cli', path, originalSha256: createHash('sha256').update(source).digest('hex'),
            sha256: createHash('sha256').update(contents).digest('hex') }) + '\n')
        return contents === source ? undefined : { contents, loader: args.path.endsWith('tsx') ? 'tsx' : 'ts', resolveDir: dirname(args.path) }
      })
    } }] })
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  const env = { ...clean, AGENTMUX_RUNTIME_DIRECTORY: directory, AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') }
  const run = (argv: string[], stdin = '') => new Promise<{ code: number | null; stdout: string; stderr: string }>((finish, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Actual diagnostic CLI exceeded its finite test deadline.')) }, 15_000)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); finish({ code, stdout, stderr }) })
    child.stdin.end(stdin)
  })
  return { run, inputs: Object.keys(built.metafile!.inputs), cli }
}
