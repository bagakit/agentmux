import { readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const appPath = join(desktopRoot, 'release', 'mac', 'AgentMux.app')
const contents = join(appPath, 'Contents')
const frameworkRoot = join(contents, 'Frameworks')
const appResources = join(contents, 'Resources', 'app')
const rendererAssets = join(appResources, 'out', 'renderer', 'assets')

async function pathSize(path) {
  const entry = await stat(path)
  if (entry.isFile()) return entry.size
  let total = 0
  for (const child of await readdir(path, { withFileTypes: true })) {
    if (child.isSymbolicLink()) continue
    total += await pathSize(join(path, child.name))
  }
  return total
}

async function directories(path) {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

const productionDependencies = ['@dnd-kit', '@monaco-editor', '@radix-ui', '@xterm', 'lucide-react', 'monaco-editor', 'react', 'react-dom', 'react-resizable-panels', 'zustand']
const packagedNodeModules = join(appResources, 'node_modules')
const shippedUiDependencyTrees = []
for (const dependency of productionDependencies) {
  const path = join(packagedNodeModules, ...dependency.split('/'))
  if (await stat(path).then(() => true, () => false)) shippedUiDependencyTrees.push(dependency)
}
if (shippedUiDependencyTrees.length > 0) {
  throw new Error(`Packaged app duplicates Renderer UI dependency trees: ${shippedUiDependencyTrees.join(', ')}`)
}

const chunks = await Promise.all((await readdir(rendererAssets, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map(async (entry) => ({ name: entry.name, bytes: (await stat(join(rendererAssets, entry.name))).size })))
chunks.sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))

const nodePtyRoot = await realpath(join(appResources, 'node_modules', '@agentmux', 'core', 'node_modules', 'node-pty'))
const prebuildRoot = join(nodePtyRoot, 'prebuilds')
const nativeArtifacts = await Promise.all((await directories(prebuildRoot)).map(async (platform) => ({
  platform,
  files: await Promise.all((await readdir(join(prebuildRoot, platform), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map(async (entry) => ({ name: entry.name, bytes: (await stat(join(prebuildRoot, platform, entry.name))).size })))
})))

const report = {
  app: { path: relative(desktopRoot, appPath), bytes: await pathSize(appPath) },
  frameworks: await Promise.all((await directories(frameworkRoot))
    .filter((name) => name.endsWith('.framework'))
    .map(async (name) => ({ name, bytes: await pathSize(join(frameworkRoot, name)) }))),
  appResources: {
    totalBytes: await pathSize(appResources),
    outBytes: await pathSize(join(appResources, 'out')),
    nodeModulesBytes: await pathSize(packagedNodeModules),
    resourcesBytes: await pathSize(join(appResources, 'resources'))
  },
  rendererChunks: chunks,
  nativeArtifacts,
  shippedUiDependencyTrees
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
