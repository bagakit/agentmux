import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { canonicalInstallPath, readPackageIdentity } from './package-identity.mjs'

const desktopRoot = resolve(import.meta.dirname, '..')
const appPath = join(desktopRoot, 'release', 'mac', 'AgentMux.app')
const desktopManifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
const dmgPath = join(
  desktopRoot,
  'release',
  'mac',
  `AgentMux-${desktopManifest.version}-${process.platform}-${process.arch}.dmg`
)
const installedAppPath = canonicalInstallPath(homedir())
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

async function sha256(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolvePromise)
  })
  return hash.digest('hex')
}

async function codesignStatus(path) {
  return await new Promise((resolvePromise) => {
    const child = spawn('codesign', ['--verify', '--deep', '--strict', path], {
      stdio: 'ignore'
    })
    child.once('error', () => resolvePromise('unavailable'))
    child.once('exit', (code) => resolvePromise(code === 0 ? 'verified' : 'failed'))
  })
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

const ctxmuxRoot = join(
  appResources,
  'node_modules',
  '@agentmux',
  'core',
  'vendor',
  'ctxmux',
  'darwin-arm64'
)
const nativeArtifacts = [{
  platform: 'darwin-arm64',
  files: await Promise.all(['bin/ctxmux', 'bin/ctxmuxd', 'ctxmux-sdk-0.0.0.tgz', 'manifest.json']
    .map(async (name) => ({ name, bytes: (await stat(join(ctxmuxRoot, name))).size })))
}]

const packageIdentity = await readPackageIdentity(appPath)
const installedIdentity = await stat(installedAppPath)
  .then(() => readPackageIdentity(installedAppPath))
  .catch(() => null)
const mainExecutablePath = join(contents, 'MacOS', 'AgentMux')
const installedMainExecutablePath = join(installedAppPath, 'Contents', 'MacOS', 'AgentMux')
const [candidateMainHash, candidateDmgHash, candidateSignature, installedMainHash, installedSignature] = await Promise.all([
  sha256(mainExecutablePath),
  sha256(dmgPath),
  codesignStatus(appPath),
  installedIdentity ? sha256(installedMainExecutablePath) : Promise.resolve(null),
  installedIdentity ? codesignStatus(installedAppPath) : Promise.resolve(null)
])

const report = {
  app: {
    path: relative(desktopRoot, appPath),
    bytes: await pathSize(appPath),
    mainExecutableSha256: candidateMainHash,
    dmg: {
      path: relative(desktopRoot, dmgPath),
      sha256: candidateDmgHash
    },
    signature: candidateSignature
  },
  packageIdentity,
  canonicalInstall: {
    path: installedAppPath,
    identity: installedIdentity,
    mainExecutableSha256: installedMainHash,
    signature: installedSignature
  },
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
