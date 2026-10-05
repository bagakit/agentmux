import { createRequire, findPackageJSON, isBuiltin } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

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
export async function sourceMoteDiagnosticsCli(directory: string) {
  const root = resolve(import.meta.dirname, '../../../..'), deps = dirname(realpathSync(join(root, 'node_modules')))
  const vitestRequire = createRequire(realpathSync(join(root, 'node_modules/vitest/package.json')))
  const viteRequire = createRequire(vitestRequire.resolve('vite/package.json'))
  const { build } = viteRequire('esbuild') as typeof import('esbuild')
  const changed: Record<string, string> = process.env.AGENTMUX_MOTE_DIAGNOSTICS_MUTATIONS
    ? JSON.parse(readFileSync(process.env.AGENTMUX_MOTE_DIAGNOSTICS_MUTATIONS, 'utf8')) : {}
  const cli = join(directory, 'mote-diagnostics-cli.mjs')
  const built = await build({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: cli,
    platform: 'node', target: 'node24', format: 'esm', bundle: true, metafile: true, logLevel: 'silent',
    plugins: [{ name: 'current-workspace-public-source', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\// }, args => {
        const [, name] = /^@agentmux\/([^/]+)/.exec(args.path)!
        const directory = join(root, 'packages', name!)
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        const entry = args.path === `@agentmux/${name}` ? '.' : '.' + args.path.slice(`@agentmux/${name}`.length)
        const target = manifest.exports[entry]?.import
        if (!target) throw new Error('Unmapped current public CLI import: ' + args.path)
        const source = target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts')
        const path = resolve(directory, source)
        if (!existsSync(path)) throw new Error('Missing current public CLI source: ' + path)
        return { path }
      })
      builder.onResolve({ filter: /^[^./]/ }, args => {
        if (isBuiltin(args.path)) return { path: args.path, external: true }
        const original = join(deps, relative(root, args.importer || join(root, 'packages/core/src/agentmux.ts')))
        try { return { path: createRequire(original).resolve(args.path), external: true } }
        catch (error) {
          // Import-only installed packages still use their actual declared ESM export.
          const manifestPath = findPackageJSON(args.path, pathToFileURL(original).href)
          if (!manifestPath) throw error
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
          const packageName = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0]
          const entry = args.path === packageName ? '.' : '.' + args.path.slice(packageName!.length)
          let target = Object.hasOwn(manifest.exports, entry) ? manifest.exports[entry] : entry === '.' ? manifest.exports : undefined
          while (target && typeof target === 'object') target = target.import ?? target.node ?? target.default
          if (typeof target !== 'string') throw error
          return { path: resolve(dirname(manifestPath), target), external: true }
        }
      })
      builder.onLoad({ filter: /\.[cm]?tsx?$/ }, args => changed[args.path] === undefined ? undefined : {
        contents: changed[args.path], loader: args.path.endsWith('tsx') ? 'tsx' : 'ts', resolveDir: dirname(args.path)
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
