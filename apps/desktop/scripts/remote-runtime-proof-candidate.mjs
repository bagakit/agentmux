import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()

// CSS @imports are expanded inside PostCSS, outside Rollup's transform hooks. Record
// the compiler's actual input objects, including imports whose nodes survived expansion.
export function capturePostcssInputs(record) {
  return { postcssPlugin: 'immutable-consumed-native-css-candidate', async OnceExit(stylesheet) {
    const inputs = new Map()
    const observe = node => {
      const input = node.source?.input
      if (input?.file && typeof input.css === 'string') inputs.set(input.file, input.css)
    }
    observe(stylesheet); stylesheet.walk(observe)
    for (const [file, code] of inputs) await record(file, code, 'postcss-input')
  } }
}

/** Snapshot the actual compiled package and capture only modules consumed by Vite. The two
 * ordinary Electron generations then use this same private candidate, without freezing peers. */
export async function prepareRemoteProofCandidate({ root, privateRoot, proof }) {
  const { assertWorkspaceDistBuiltFromCurrentSource } = await import(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)
  await assertWorkspaceDistBuiltFromCurrentSource(root)
  const workspace = new Map(), pending = ['@agentmux/core']
  while (pending.length) {
    const name = pending.shift()
    if (workspace.has(name)) continue
    const source = path.join(root, 'packages', name.slice('@agentmux/'.length))
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'))
    assert.equal(manifest.name, name, 'The copied workspace dependency must have its declared identity')
    workspace.set(name, { source, directory: path.join(privateRoot, `${name.slice('@agentmux/'.length)}-candidate`), manifest })
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      if (version.startsWith('workspace:')) pending.push(dependency)
    }
  }
  const core = workspace.get('@agentmux/core').directory
  const packageFiles = async () => (await Promise.all([...workspace].map(async ([name, item]) => [
    path.join(item.source, 'package.json'), ...await files(path.join(item.source, 'dist')),
    ...(name === '@agentmux/core' ? [...await files(path.join(item.source, 'bin')),
      ...await files(path.join(item.source, 'vendor/ctxmux', `${process.platform}-${process.arch}`))] : [])
  ]))).flat()
  const identify = async () => Object.fromEntries(await Promise.all((await packageFiles()).map(async file => [path.relative(root, file), digest(await fs.readFile(file))])))
  const before = await identify()
  const dependencies = {}
  for (const [name, item] of workspace) {
    await fs.mkdir(item.directory)
    for (const directory of ['dist', ...(name === '@agentmux/core' ? ['bin', `vendor/ctxmux/${process.platform}-${process.arch}`] : [])]) {
      await fs.cp(path.join(item.source, directory), path.join(item.directory, directory), { recursive: true })
    }
    await fs.copyFile(path.join(item.source, 'package.json'), path.join(item.directory, 'package.json'))
    await fs.mkdir(path.join(item.directory, 'node_modules/@agentmux'), { recursive: true })
    for (const dependency of Object.keys(item.manifest.dependencies ?? {})) {
      if (workspace.has(dependency)) {
        await fs.symlink(workspace.get(dependency).directory, path.join(item.directory, 'node_modules', dependency))
      }
    }
    let entries = []
    try { entries = await fs.readdir(path.join(item.source, 'node_modules'), { withFileTypes: true }) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const entry of entries) {
      if (entry.name === '@agentmux') continue
      const source = await fs.realpath(path.join(item.source, 'node_modules', entry.name))
      dependencies[`${name}/${entry.name}`] = source
      await fs.symlink(source, path.join(item.directory, 'node_modules', entry.name))
    }
  }
  assert.deepEqual(await identify(), before, 'The package changed while its private candidate was being copied')
  proof.coreCandidate = { sourcePackageHashes: before, dependencies, copiedPlatform: `${process.platform}-${process.arch}` }
  const manifests = Object.fromEntries(workspace)
  const consumed = new Map()
  const record = async (id, code, consumedVia) => {
    const file = id.split('?')[0]
    if (file.includes('\0') || !/\.(?:[cm]?[jt]sx?|css|json)$/.test(file) ||
      !(file.startsWith(path.join(root, 'apps/desktop/')) || file.startsWith(path.join(root, 'apps/host/')) ||
        file.startsWith(path.join(root, 'packages/layout/')) ||
        file.startsWith(path.join(root, 'packages/client-ui/')) ||
        [...workspace.values()].some(item => file.startsWith(item.directory + '/')))) return
    const sourceSHA256 = digest(await fs.readFile(file))
    const previous = consumed.get(file)
    if (previous) assert.equal(previous.sourceSHA256, sourceSHA256, 'A consumed module changed between the two candidate builds')
    consumed.set(file, { sourceSHA256, consumedCodeSHA256: digest(code), consumedVia })
  }
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
    async transform(code, id) { await record(id, code, 'vite-transform-input') }
  }
  return { core, capture, captureCss: capturePostcssInputs(record),
    async buildHost(build) {
      // Match the production ESM Host entry next to the Main bundle. Its lifetime is
      // independent of either ordinary Electron generation that consumes it.
      await fs.writeFile(path.join(privateRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n')
      await build({ configFile: false, root: path.join(root, 'apps/host'), logLevel: 'error', plugins: [capture], ssr: { noExternal: true },
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
      return Object.fromEntries(await Promise.all([path.join(privateRoot, 'package.json'), ...(await Promise.all([...workspace.values()].map(item => files(item.directory)))).flat()]
        .filter(file => !file.split(path.sep).includes('node_modules')).map(async file => [path.relative(privateRoot, file), digest(await fs.readFile(file))])))
    }
  }
}
