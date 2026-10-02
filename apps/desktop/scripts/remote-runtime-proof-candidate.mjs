import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()

/** Snapshot the actual compiled package and capture only modules consumed by Vite. The two
 * ordinary Electron generations then use this same private candidate, without freezing peers. */
export async function prepareRemoteProofCandidate({ root, privateRoot, proof }) {
  const { assertWorkspaceDistBuiltFromCurrentSource } = await import(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)
  await assertWorkspaceDistBuiltFromCurrentSource(root)
  const sourcePackage = path.join(root, 'packages/core'), core = path.join(privateRoot, 'core-candidate')
  const demandSource = path.join(root, 'packages/demand'), demand = path.join(privateRoot, 'demand-candidate')
  const packageFiles = async () => [path.join(sourcePackage, 'package.json'), ...await files(path.join(sourcePackage, 'dist')),
    ...await files(path.join(sourcePackage, 'bin')), ...await files(path.join(sourcePackage, 'vendor/ctxmux', `${process.platform}-${process.arch}`)),
    path.join(demandSource, 'package.json'), ...await files(path.join(demandSource, 'dist'))]
  const identify = async () => Object.fromEntries(await Promise.all((await packageFiles()).map(async file => [path.relative(root, file), digest(await fs.readFile(file))])))
  const before = await identify()
  await fs.mkdir(core); await fs.mkdir(demand)
  for (const directory of ['dist', 'bin', `vendor/ctxmux/${process.platform}-${process.arch}`]) {
    await fs.cp(path.join(sourcePackage, directory), path.join(core, directory), { recursive: true })
  }
  await fs.copyFile(path.join(sourcePackage, 'package.json'), path.join(core, 'package.json'))
  await fs.cp(path.join(demandSource, 'dist'), path.join(demand, 'dist'), { recursive: true })
  await fs.copyFile(path.join(demandSource, 'package.json'), path.join(demand, 'package.json'))
  await fs.mkdir(path.join(core, 'node_modules/@agentmux'), { recursive: true })
  await fs.symlink(demand, path.join(core, 'node_modules/@agentmux/demand'))
  const dependencies = {}
  for (const entry of await fs.readdir(path.join(sourcePackage, 'node_modules'), { withFileTypes: true })) {
    if (entry.name === '@agentmux') continue
    const source = await fs.realpath(path.join(sourcePackage, 'node_modules', entry.name))
    dependencies[entry.name] = source
    await fs.symlink(source, path.join(core, 'node_modules', entry.name))
  }
  await fs.symlink(await fs.realpath(path.join(demandSource, 'node_modules')), path.join(demand, 'node_modules'))
  assert.deepEqual(await identify(), before, 'The package changed while its private candidate was being copied')
  proof.coreCandidate = { sourcePackageHashes: before, dependencies, copiedPlatform: `${process.platform}-${process.arch}` }
  const manifests = {
    '@agentmux/core': { directory: core, manifest: JSON.parse(await fs.readFile(path.join(core, 'package.json'), 'utf8')) },
    '@agentmux/demand': { directory: demand, manifest: JSON.parse(await fs.readFile(path.join(demand, 'package.json'), 'utf8')) }
  }
  const consumed = new Map()
  const capture = { name: 'immutable-consumed-native-candidate', enforce: 'pre',
    resolveId(source) {
      for (const [name, item] of Object.entries(manifests)) {
        if (source !== name && !source.startsWith(name + '/')) continue
        const key = source === name ? '.' : '.' + source.slice(name.length)
        const exported = item.manifest.exports[key]
        const entry = typeof exported === 'string' ? exported : exported?.import
        assert.ok(typeof entry === 'string', `The actual package export must exist: ${source}`)
        return path.join(item.directory, entry)
      }
    },
    async transform(code, id) {
      const file = id.split('?')[0]
      if (file.includes('\0') || !/\.(?:[cm]?[jt]sx?|css|json)$/.test(file) ||
        !(file.startsWith(path.join(root, 'apps/desktop/')) || file.startsWith(path.join(root, 'apps/host/')) ||
          file.startsWith(path.join(root, 'packages/layout/')) ||
          file.startsWith(path.join(root, 'packages/client-ui/')) ||
          file.startsWith(core + '/') || file.startsWith(demand + '/'))) return
      const sourceSHA256 = digest(await fs.readFile(file))
      const previous = consumed.get(file)
      if (previous) assert.equal(previous.sourceSHA256, sourceSHA256, 'A consumed module changed between the two candidate builds')
      consumed.set(file, { sourceSHA256, consumedCodeSHA256: digest(code) })
    }
  }
  return { core, capture,
    async buildHost(build) {
      // Match the production ESM Host entry next to the Main bundle. Its lifetime is
      // independent of either ordinary Electron generation that consumes it.
      await fs.writeFile(path.join(privateRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n')
      await build({ configFile: false, root: path.join(root, 'apps/host'), logLevel: 'error', plugins: [capture],
        build: { ssr: path.join(root, 'apps/host/src/index.ts'), target: 'node22',
          outDir: path.join(privateRoot, 'main'), emptyOutDir: false,
          rollupOptions: { external: id => id === '@agentmux/core' || id.startsWith('@agentmux/core/'),
            output: { format: 'es', entryFileNames: 'agentmux-host.js', chunkFileNames: 'host-[name]-[hash].js' } } } })
    },
    async connectLocalHost() {
      const { connectAgentMuxRpc, defaultAgentMuxControlSocketPath } = await import(pathToFileURL(path.join(core, 'dist/index.js')).href)
      const { connectHostedAgentMux } = await import(pathToFileURL(path.join(core, 'dist/hosted.js')).href)
      const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix',
        path: defaultAgentMuxControlSocketPath({ AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime') }) } })
      try {
        const client = await connectHostedAgentMux({ rpc, expectedStorePath: path.join(privateRoot, 'agent-sessions.json') })
        const dispose = client.dispose.bind(client)
        client.dispose = async () => { try { await dispose() } finally { await rpc.dispose() } }
        return client
      } catch (error) { await rpc.dispose(); throw error }
    },
    async stopHost() {
      // The Host argv contains its exact private Store. The separate native Runtime
      // directory belongs to this same proof; the remote owner has another scope.
      const scopes = [path.join(privateRoot, 'agent-sessions.json'), path.join(privateRoot, 'runtime')]
      for (const scope of scopes) await stopProbeProcesses(process.pid + 1_000_000_000, scope)
      return [...new Set((await Promise.all(scopes.map(scope => listProbeProcesses(-1, scope)))).flat())]
    },
    async seal() {
      assert.ok(consumed.size > 0, 'The immutable candidate must consume actual product modules')
      assert.ok(consumed.has(path.join(root, 'apps/host/src/index.ts')),
        'The actual independent semantic Host entry must be consumed by this candidate')
      for (const [file, fact] of consumed) assert.equal(digest(await fs.readFile(file)), fact.sourceSHA256, 'A consumed module changed during candidate compilation')
      proof.consumedModules = Object.fromEntries([...consumed].map(([file, fact]) => [file.startsWith(privateRoot + '/')
        ? `private/${path.relative(privateRoot, file)}` : path.relative(root, file), fact]))
    },
    async identity() {
      return Object.fromEntries(await Promise.all([path.join(privateRoot, 'package.json'), ...await files(core), ...await files(demand)]
        .filter(file => !file.split(path.sep).includes('node_modules')).map(async file => [path.relative(privateRoot, file), digest(await fs.readFile(file))])))
    }
  }
}
