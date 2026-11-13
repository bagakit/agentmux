import { defineConfig } from 'vitest/config'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'
import { bundlePrivateNodeSource } from '../../../packages/core/test/helpers/private-node-source-bundle.mjs'
import { workspaceSourceExport } from '../../../packages/core/test/helpers/workspace-source-export.mjs'

const root = resolve(import.meta.dirname, '../../..')
const directory = process.env.HOST_OUTPUT_GENERATED ?? await mkdtemp(resolve(tmpdir(), 'host-output-source-'))
await mkdir(directory, { recursive: true })
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const variant = process.env.HOST_OUTPUT_MUTANT
if (variant && variant !== 'restore-unsafe-output') throw Error('Unknown Host output mutation')
const identity = await bundleIdentityRuntime(), identitySource = resolve(directory, 'identity-runtime-source.mjs')
await writeFile(identitySource, 'export const identityRuntimeSource = ' + JSON.stringify(identity.source) + ';\n')
const sourceExport = (specifier: string) => specifier === '@agentmux/identity/runtime-source'
  ? identitySource : workspaceSourceExport(root, specifier)

// Reuse the original Native I/O collaborator, not its compiled Host or public dispatch.
const nativeFixture = await readFile(resolve(root, 'apps/host/test/fixtures/host-index-native.mjs'), 'utf8')
const from = nativeFixture.indexOf('const factsPath = process.env.HOST_INDEX_NATIVE_FACTS')
const to = nativeFixture.indexOf('if (process.env.HOST_INDEX_PLATFORM_ORIGIN)')
if (from < 0 || to <= from) throw Error('The original private Native I/O collaborator is unavailable')
const nativeIo = nativeFixture.slice(from, to)
const originalHelperCommit = 'e9d81feecc7ab3980fc7bad59c1cacd7dd592df1'
const oldHelper = execFileSync('git', ['show', originalHelperCommit + ':apps/host/src/output-retention.ts'], { cwd: root, encoding: 'utf8' })
const oldHelperPath = resolve(directory, 'original-output-retention.ts')
await writeFile(oldHelperPath, oldHelper)
const witnessed = new Set(['apps/host/src/index.ts', 'apps/host/src/host.ts', 'packages/core/src/client.ts',
  'packages/core/src/agent-session-store.ts', 'packages/core/src/public-rpc-service.ts'])
function instrument(source: string, path: string, surface: string): string {
  const originalSHA256 = sha(source)
  if (surface === 'host' && path === 'packages/core/src/client.ts') {
    source += `\nimport * as __outputNativeFs from 'node:fs';\nimport { createHash as __outputNativeHash } from 'node:crypto';\n;(function(AgentMuxClient) {\nconst { existsSync, readFileSync, writeFileSync } = __outputNativeFs;\nconst sha = value => __outputNativeHash('sha256').update(value).digest('hex');\n${nativeIo}\n})(AgentMuxClient);\n`
  }
  if (surface === 'host' && path === 'apps/host/src/index.ts' && variant) {
    const boundary = 'const storePath = process.env.AGENTMUX_AGENT_SESSION_STORE'
    if (source.split(boundary).length !== 2 || source.includes('boundInheritedOutput')) throw Error('Inverse must restore one original startup call')
    source = source.replace(boundary, `import { boundInheritedOutput } from ${JSON.stringify(oldHelperPath)};\nboundInheritedOutput();\n\n${boundary}`)
  }
  if (witnessed.has(path)) {
    const row = JSON.stringify({ path, surface, originalSHA256, loadedSHA256: sha(source), nativeIoControlled: surface === 'host' && path === 'packages/core/src/client.ts', mutant: variant ?? null })
    const witness = `import { appendFileSync as __outputLoaded } from 'node:fs'; if (process.env.HOST_OUTPUT_LOADED) __outputLoaded(process.env.HOST_OUTPUT_LOADED, ${JSON.stringify(row + '\n')});\n`
    const offset = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0
    source = source.slice(0, offset) + witness + source.slice(offset)
  }
  return source
}
const cliSource = resolve(root, 'packages/core/src/agentmux.ts'), cliWrapper = resolve(directory, 'source-cli.mjs')
await writeFile(cliWrapper, 'process.argv[1] = ' + JSON.stringify(cliSource) + ';\nawait import(' + JSON.stringify(cliSource) + ');\n')
const bundles = []
for (const [name, entry] of [['host', resolve(root, 'apps/host/src/index.ts')],
  ['listener', resolve(root, 'packages/core/src/control-endpoint-listener-worker.ts')], ['cli', cliWrapper]] as const) {
  const result = await bundlePrivateNodeSource({ root, entry, file: resolve(directory, name + '.mjs'), sourceExport,
    instrument: (source: string, path: string) => instrument(source, path, name) })
  process.env['HOST_OUTPUT_' + name.toUpperCase() + '_ENTRY'] = result.file
  bundles.push({ name, file: result.file, provenance: result.provenance })
}
const loader = resolve(directory, 'listener-loader.mjs')
await writeFile(loader, `import { registerHooks } from 'node:module';\nimport { fileURLToPath, pathToFileURL } from 'node:url';\nregisterHooks({ resolve(specifier, context, next) {\nconst path = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier;\nif (path === ${JSON.stringify(resolve(root, 'packages/core/dist/control-endpoint-listener-worker.js'))}) return next(pathToFileURL(process.env.HOST_OUTPUT_LISTENER_ENTRY).href, context);\nreturn next(specifier, context);\n} });\n`)
process.env.HOST_OUTPUT_LOADER = loader
await writeFile(resolve(directory, 'inputs.json'), JSON.stringify({ root, variant: variant ?? null, bundles,
  nativeFixtureSHA256: sha(nativeFixture), reusedNativeIoSHA256: sha(nativeIo), originalHelperCommit, originalHelperSHA256: sha(oldHelper), identitySourceSHA256: sha(identity.source) }, null, 2) + '\n')
export default defineConfig({ root, plugins: [{ name: 'original-host-output-source', enforce: 'pre', resolveId(id) { return sourceExport(id) } }],
  test: { include: ['apps/host/test/output-retention.test.ts'], environment: 'node', fileParallelism: false,
    maxWorkers: 1, passWithNoTests: false, testTimeout: 25_000, hookTimeout: 10_000 } })
