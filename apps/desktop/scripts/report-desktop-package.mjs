import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  canonicalInstallPath,
  knownApplicationPaths,
  readPackageIdentity
} from './package-identity.mjs'
import {
  formatPackageReportPreflightError,
  inspectPackageReportPaths
} from './package-report-preflight.mjs'

const desktopRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(desktopRoot, '../..')
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
const mainExecutablePath = join(contents, 'MacOS', 'AgentMux')

const preflight = await inspectPackageReportPaths({
  appPath,
  rendererAssets,
  mainExecutablePath,
  dmgPath
})
if (!preflight.ok) {
  process.stderr.write(`${formatPackageReportPreflightError(preflight.missing)}\n`)
  process.exit(1)
}

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

async function runningAgentMuxProcesses() {
  const result = await new Promise((resolvePromise) => {
    const child = spawn('ps', ['-axo', 'pid=,command='], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.once('error', () => resolvePromise(''))
    child.once('exit', () => resolvePromise(stdout))
  })
  return String(result).split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match || !match[2].includes('AgentMux.app/Contents/')) return []
    return [{ pid: Number(match[1]), command: match[2] }]
  })
}

function checkoutIdentity() {
  const runGit = (args) => execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8'
  }).trim()
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    sourceCommit: runGit(['rev-parse', 'HEAD']),
    sourceTree: runGit(['write-tree']),
    sourceStatus: status
  }
}

async function inspectKnownCopy(entry) {
  const exists = await stat(entry.path).then(() => true, () => false)
  if (!exists) return { ...entry, exists: false, identity: null }
  const [realPath, identity] = await Promise.all([
    realpath(entry.path).catch(() => null),
    readPackageIdentity(entry.path).catch((error) => ({
      error: error instanceof Error ? error.message : String(error)
    }))
  ])
  return { ...entry, exists: true, realPath, identity }
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
const sourceIdentity = checkoutIdentity()
const installedIdentity = await stat(installedAppPath)
  .then(() => readPackageIdentity(installedAppPath))
  .catch(() => null)
const installedMainExecutablePath = join(installedAppPath, 'Contents', 'MacOS', 'AgentMux')
const [candidateMainHash, candidateDmgHash, candidateSignature, installedMainHash, installedSignature] = await Promise.all([
  sha256(mainExecutablePath),
  sha256(dmgPath),
  codesignStatus(appPath),
  installedIdentity ? sha256(installedMainExecutablePath) : Promise.resolve(null),
  installedIdentity ? codesignStatus(installedAppPath) : Promise.resolve(null)
])

const knownCopies = await Promise.all(knownApplicationPaths({
  homeDirectory: homedir(),
  repositoryRoot
}).map(inspectKnownCopy))
const identityFields = ['schema', 'sourceCommit', 'sourceTree', 'appVersion', 'platform', 'arch']
const sameIdentity = (left, right) => (
  left && right && identityFields.every((field) => left[field] === right[field])
)
for (const copy of knownCopies) {
  copy.identityMatch = copy.identity && sameIdentity(copy.identity, packageIdentity)
  copy.stale = copy.exists && copy.identityMatch !== true
}
const runningProcesses = await runningAgentMuxProcesses()
const canonicalIdentity = knownCopies.find((entry) => entry.id === 'canonical-user' && entry.exists)?.identity
const runningPathMismatches = runningProcesses.map((processInfo) => {
  const matchingCopy = knownCopies.find((entry) => (
    entry.exists && entry.realPath && processInfo.command.startsWith(`${entry.realPath}/Contents/`)
  ))
  return {
    ...processInfo,
    copyId: matchingCopy?.id ?? null,
    canonical: matchingCopy?.id === 'canonical-user'
  }
})

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
  knownCopies,
  runningProcesses: runningPathMismatches,
  launchSource: {
    sourceIdentity,
    candidateMatchesCheckout: sameIdentity(packageIdentity, {
      schema: packageIdentity.schema,
      ...sourceIdentity,
      appVersion: desktopManifest.version,
      platform: process.platform,
      arch: process.arch
    }),
    canonicalIdentity,
    canonicalMatchesCandidate: sameIdentity(canonicalIdentity, packageIdentity),
    canonicalMatchesCheckout: sameIdentity(canonicalIdentity, {
      schema: packageIdentity.schema,
      ...sourceIdentity,
      appVersion: desktopManifest.version,
      platform: process.platform,
      arch: process.arch
    }),
    staleCopies: knownCopies.filter((entry) => entry.stale).map(({ id, path }) => ({ id, path })),
    runningCanonical: runningPathMismatches.every((entry) => entry.canonical),
    mismatchCount: runningPathMismatches.filter((entry) => !entry.canonical).length
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
