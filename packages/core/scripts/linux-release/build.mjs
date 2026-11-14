// Builds the self-contained Linux x64 headless Core release:
//   agentmux-core-<version>-linux-x64.tar.gz
// It bundles the official Node.js runtime (checksum-verified), the same portable
// Core artifact that the App's Core upgrade pushes to a remote Host, and
// install.sh. The target needs no Node, npm, compiler or network access.
//
//   node scripts/linux-release/build.mjs --out DIR [--node-archive FILE]
//
// --node-archive supplies an already downloaded node-v<ver>-linux-x64.tar.gz; its
// checksum is still verified against the pinned value below.
import { publishPackageArtifact } from '../../../../scripts/package-artifact-publisher.mjs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
// The pinned Node.js has one owner in Core; the App's first install uses the same pin.
const { LINUX_NODE_VERSION: NODE_VERSION, LINUX_NODE_X64_SHA256: NODE_LINUX_X64_SHA256, LINUX_NODE_ARCHIVE: NODE_ARCHIVE } =
  await import(new URL('../../dist/linux-node.js', import.meta.url).href)
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}`

const here = fileURLToPath(new URL('.', import.meta.url))
const packageRoot = resolve(here, '../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

function parse(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1]
    if (!['--out', '--node-archive'].includes(name) || !value) throw new Error('Usage: build.mjs --out DIR [--node-archive FILE]')
    options[name.slice(2).replace('-a', 'A')] = resolve(value)
  }
  if (!options.out) throw new Error('Usage: build.mjs --out DIR [--node-archive FILE]')
  return options
}

/** Release identity of a clean checkout; an edited tree has no commit to name. */
async function sourceRelease() {
  const git = async args => (await exec('git', args, { cwd: packageRoot })).stdout.trim()
  const dirty = await git(['status', '--porcelain', '--untracked-files=normal'])
  return dirty ? { sourceCommit: null } : { sourceCommit: await git(['rev-parse', 'HEAD']), sourceTree: await git(['rev-parse', 'HEAD^{tree}']) }
}

async function nodeArchive(supplied, scratch) {
  let bytes
  if (supplied) bytes = await readFile(supplied)
  else {
    const response = await fetch(NODE_URL)
    if (!response.ok) throw new Error(`Downloading ${NODE_URL} failed: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (sha(bytes) !== NODE_LINUX_X64_SHA256) throw new Error(`${NODE_ARCHIVE} does not match its pinned SHA-256; refusing to bundle it.`)
  const path = join(scratch, NODE_ARCHIVE)
  await writeFile(path, bytes)
  return path
}

/** The Core release, its bundled Node and installer, as one directory tree. */
export async function buildLinuxRelease({ out, nodeArchive: supplied, release = null }) {
  const { createPortableCoreArtifact } = await import(new URL('../../dist/portable-core-artifact.js', import.meta.url).href)
  const programs = await import(new URL('../../dist/remote-core-upgrade-programs.js', import.meta.url).href)
  const { materializeRuntimeCore } = await import(new URL('../../../../scripts/package-dependencies.mjs', import.meta.url).href)
  const version = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version
  const name = `agentmux-core-${version}-linux-x64`
  // Assemble beside the output: one filesystem, and outside per-user temp folders
  // that endpoint scanners inspect file by file.
  await mkdir(out, { recursive: true })
  const scratch = await mkdtemp(join(out, '.assembling-'))
  try {
    // The same runtime Core the App bundles: one owner decides which dependency files ship.
    const runtime = await materializeRuntimeCore(resolve(packageRoot, '../..'), join(scratch, 'runtime-core'), release ?? await sourceRelease(), { target: { os: 'linux', cpu: 'x64' } })
    const artifact = await createPortableCoreArtifact(join(scratch, 'artifact'), runtime)
    const root = join(scratch, name)
    await mkdir(join(root, 'core'), { recursive: true })
    await rename(artifact.archivePath, join(root, 'core', 'core.tar.gz'))
    // The staging program checks every file against this inventory, then writes
    // deployment.json {digest, files} that the in-app upgrade later verifies.
    await writeFile(join(root, 'core', 'deployment.json'), JSON.stringify({
      digest: artifact.digest, archiveDigest: artifact.archiveDigest, files: artifact.files,
      sourceCommit: artifact.sourceCommit, version: artifact.version,
      ownerProtocolVersion: artifact.ownerProtocolVersion, requiredNativeProtocolVersion: artifact.requiredNativeProtocolVersion
    }, null, 2) + '\n')
    await writeFile(join(root, 'stage-core.cjs'), programs.STAGE_CORE)
    await writeFile(join(root, 'select-core.cjs'), programs.SELECT_CORE_RELEASE)
    for (const file of ['install.sh', 'stage.mjs']) await cp(join(here, file), join(root, file))
    await chmod(join(root, 'install.sh'), 0o755)

    const node = await nodeArchive(supplied, scratch)
    // Extract as published, then move the single top directory into place.
    await mkdir(join(root, 'node'), { recursive: true })
    await exec('tar', ['-xzf', node, '-C', join(root, 'node')])
    await rename(join(root, 'node', `node-${NODE_VERSION}-linux-x64`), join(root, 'node', 'dist'))
    await writeFile(join(root, 'node', 'VERSION'), NODE_VERSION + '\n')
    // Node's own headers and npm are not needed to run Core.
    for (const unused of ['include', 'share', 'lib/node_modules', 'bin/npm', 'bin/npx', 'bin/corepack']) {
      await rm(join(root, 'node', 'dist', unused), { recursive: true, force: true })
    }
    await writeFile(join(root, 'README.txt'), [
      `AgentMux headless Core ${version} for Linux x64 (glibc 2.34 or newer).`,
      `Bundled Node.js ${NODE_VERSION}; no Node, npm or network access is needed on this machine.`,
      '', 'Install and start:', '  ./install.sh', '',
      'It prints the Service command and Service socket path to save on the client Host.',
      'Run ./install.sh --help for options.', ''
    ].join('\n'))

    const archive = join(out, `${name}.tar.gz`)
    // A Linux tar warns about macOS extended attributes and AppleDouble files; omit them.
    const metadata = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : []
    const partial = join(scratch, `${name}.tar.gz.partial`)
    await exec('tar', [...metadata, '-czf', partial, '-C', scratch, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    await rename(partial, archive)
    const archiveSha256 = sha(await readFile(archive))
    await writeFile(archive + '.sha256', `${archiveSha256}  ${name}.tar.gz\n`)
    return { archive, archiveSha256, version, node: NODE_VERSION, coreDigest: artifact.digest, sourceCommit: artifact.sourceCommit, files: artifact.files.length }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parse(process.argv.slice(2))
  if (!isAbsolute(options.out)) throw new Error('--out must resolve to an absolute directory')
  const result = await buildLinuxRelease(options)
  const artifacts = await publishPackageArtifact({ repositoryRoot: resolve(packageRoot, '../..'), target: 'linux-x64', archive: result.archive, sha256: result.archiveSha256 })
  process.stdout.write(JSON.stringify({ ...result, artifacts }, null, 2) + '\n')
}
