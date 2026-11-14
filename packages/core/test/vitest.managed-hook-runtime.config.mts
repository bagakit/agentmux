import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'

export const managedHookRuntimeMutants = {
  'source-paths': {
    from: '    return { nodePath, runnerPath }',
    to: '    return { nodePath: source!.executablePath, runnerPath: source!.workerPath }',
    test: 'runs the real bundled worker'
  },
  'unretained-worker': {
    from: "    const runnerPath = await publishWorker(join(root, 'workers'), value)",
    to: '    const runnerPath = source!.workerPath',
    test: 'runs the real bundled worker'
  },
  'framework-omitted': {
    from: "['MacOS', 'Frameworks', 'Info.plist', 'PkgInfo']",
    to: "['MacOS', 'Info.plist', 'PkgInfo']",
    test: 'retains the actual Electron Framework'
  },
  'interpreter-per-worker': {
    from: "publishInterpreter(join(root, 'interpreters'), value.interpreter)",
    to: "publishInterpreter(join(root, 'interpreters', value.workerIdentity), value.interpreter)",
    test: 'retains both immutable worker revisions'
  }
} as const

/** Both the Vitest owner and the independent publisher helper load this same edit. */
export function mutateManagedHookRuntime(source: string, path: string, stage: 'vitest-owner' | 'esbuild-owner'): string {
  const mutation = process.env.AGENTMUX_HOOK_RUNTIME_MUTATION
  let loaded = source
  if (mutation) {
    const edit = managedHookRuntimeMutants[mutation as keyof typeof managedHookRuntimeMutants]
    if (!edit) throw new Error(`Unknown managed Hook runtime mutation: ${mutation}`)
    if (source.split(edit.from).length !== 2) throw new Error(`Missing unique production mutation target: ${mutation}`)
    loaded = source.replace(edit.from, edit.to)
  }
  if (process.env.AGENTMUX_HOOK_RUNTIME_LOADED) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.AGENTMUX_HOOK_RUNTIME_LOADED, JSON.stringify({ path, stage,
      mutation: mutation ?? null, sourceSHA256: hash(source), loadedSHA256: hash(loaded), bytes: Buffer.byteLength(loaded) }) + '\n')
  }
  return loaded
}

const runtimeOwner = resolve(import.meta.dirname, '../src/managed-hook-runtime.ts')
export default defineConfig({
  root: resolve(import.meta.dirname, '../../..'),
  resolve: { alias: [{ find: /^@agentmux\/identity$/, replacement: resolve(import.meta.dirname, '../../identity/src/index.ts') }] },
  plugins: [{ name: 'managed-hook-runtime-owner', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]
    if (path !== runtimeOwner) return
    const code = mutateManagedHookRuntime(source, path, 'vitest-owner')
    return code === source ? undefined : { code, map: null }
  } }],
  test: {
    include: ['packages/core/test/managed-hook-runtime.test.ts'],
    exclude: [],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
