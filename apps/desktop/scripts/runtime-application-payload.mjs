import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { resolvePackageRoot, visitRuntimePackageClosure, materializePackageClosure, runtimePackageSelection } from '../../../scripts/package-dependencies.mjs'
import { inspectBrowserExtension } from './prepare-browser-extension-identity.mjs'
import { inspectStaticAvatarRuntime } from './static-avatar-runtime.mjs'
import { embeddedCoreCli } from './embedded-core-cli.mjs'
import { PRODUCT_NAME } from './macos-application-brand.mjs'
import { createPackageIdentity, packageCompatibilityIdentity, PACKAGE_IDENTITY_FILENAME } from './package-identity.mjs'

export const PACKAGED_CTXMUX_ROOT = 'node_modules/@agentmux/core/vendor/ctxmux'

/** The existing App payload selection. Copy and identity consume these same finite facts. */
export async function inspectRuntimeApplicationPayload(repositoryRoot) {
  const desktop = join(repositoryRoot, 'apps/desktop'), core = join(repositoryRoot, 'packages/core')
  const demand = join(repositoryRoot, 'packages/demand'), connectors = join(repositoryRoot, 'packages/connectors')
  const manifest = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
  const copies = [], generated = [], links = [], modes = []
  // Every workspace package is read with one npm call; installed packages ship as installed.
  const packageFiles = await runtimePackageSelection(['capsule', 'demand', 'diagnostic-evidence', 'git', 'identity', 'providers', 'relay']
    .map(name => join(repositoryRoot, 'packages', name)))
  const clone = (source, target) => copies.push({ source, target, clone: true })
  const copy = (source, target, recursive = false) => copies.push({ source, target, recursive })
  const json = (target, value) => generated.push({ target, contents: JSON.stringify(value, null, 2) + '\n' })
  clone(join(desktop, 'out'), 'out'); clone(join(desktop, 'resources'), 'resources')
  const extension = await inspectBrowserExtension(repositoryRoot)
  copy(extension.source, 'browser-extension', true)
  generated.push({ target: join('browser-extension', extension.runtime.path), contents: extension.runtime.contents })
  copy(join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md')
  json('package.json', { name: 'agentmux-desktop', productName: PRODUCT_NAME, version: manifest.version,
    private: true, type: 'module', main: 'out/main/index.js' })
  const coreTarget = 'node_modules/@agentmux/core', demandTarget = 'node_modules/@agentmux/demand'
  for (const name of ['dist', 'vendor', 'bin']) clone(join(core, name), join(coreTarget, name))
  copy(join(core, 'src/ctxmux-artifact-contract.json'), join(coreTarget, 'src/ctxmux-artifact-contract.json'))
  const coreManifest = JSON.parse(await readFile(join(core, 'package.json'), 'utf8'))
  json(join(coreTarget, 'package.json'), {
    name: coreManifest.name, version: coreManifest.version, type: coreManifest.type, main: coreManifest.main,
    exports: coreManifest.exports, engines: coreManifest.engines, os: coreManifest.os, cpu: coreManifest.cpu,
    license: coreManifest.license, repository: coreManifest.repository, bin: coreManifest.bin
  })
  // Core is also extracted verbatim for remote distribution. Its stripped
  // manifest requires a complete independent subtree, separate from Main roots.
  const coreRoots = [{ sourceDirectory: core, target: coreTarget, includeRoot: false }], roots = []
  function dependencies(sourceDirectory, target, includeRoot = false) {
    roots.push({ sourceDirectory, target, includeRoot })
  }
  async function copyDependencies(selections, options) {
    // One owner decides which files of a dependency ship; workspace sources, tests and
    // development files never enter the App or the remote Core taken from it.
    await visitRuntimePackageClosure(selections, async (source, destination) => {
      if (selections.find(value => value.target === destination)?.includeRoot !== false) {
        for (const file of await packageFiles(source)) {
          const fileSource = join(source, file), target = join(destination, file)
          // Downloaded optionals belong to this inspection. Keep their
          // bytes in the same copy/hash plan after removing the scratch tree.
          if (options && source.startsWith(options.optionalCache + sep)) {
            generated.push({ target, contents: await readFile(fileSource), mode: (await stat(fileSource)).mode & 0o777 })
          } else copy(fileSource, target)
        }
      }
    }, options)
  }
  async function dependency(owner, name, target) {
    await dependencies(await resolvePackageRoot(owner, name, repositoryRoot), target, true)
  }
  const demandManifest = JSON.parse(await readFile(join(demand, 'package.json'), 'utf8'))
  clone(join(demand, 'dist'), join(demandTarget, 'dist'))
  json(join(demandTarget, 'package.json'), { name: demandManifest.name, version: demandManifest.version, type: demandManifest.type,
    main: demandManifest.main, exports: demandManifest.exports, bin: demandManifest.bin })
  await dependencies(demand, demandTarget)
  for (const name of ['@agentmux/git', '@agentmux/capsule', '@agentmux/identity', '@bufbuild/protobuf', '@noble/hashes', 'react', 'react-dom', 'fflate',
    'parse5', '@xmldom/xmldom', 'tldts', 'luxon', 'zod', 'ws', 'yaml']) await dependency(desktop, name, join('node_modules', ...name.split('/')))
  for (const name of ['fs-native-extensions', '@larksuiteoapi/node-sdk', '@discordjs/ws', '@discordjs/rest', 'discord-api-types']) {
    await dependency(connectors, name, join('node_modules', ...name.split('/')))
  }
  await dependency(core, '@agentmux/relay', 'node_modules/@agentmux/relay')
  const optionalCache = await realpath(await mkdtemp(join(tmpdir(), 'amux-app-target-')))
  try {
    await copyDependencies(coreRoots, {
      additionalTarget: { os: 'linux', cpu: 'x64' }, lockfilePath: join(repositoryRoot, 'pnpm-lock.yaml'), optionalCache,
    })
  } finally { await rm(optionalCache, { recursive: true, force: true }) }
  await copyDependencies(roots)
  const avatar = await inspectStaticAvatarRuntime(repositoryRoot)
  copy(avatar.manifest.source, avatar.manifest.target); copy(avatar.icons.source, avatar.icons.target, true)
  links.push({ target: avatar.entry, link: avatar.link })
  clone(join(core, 'bin'), 'out/bin')
  for (const target of [join(coreTarget, 'bin'), 'out/bin']) {
    // A fixed App anchor makes relative launcher bytes independent of process.cwd().
    const app = '/AgentMux.app/Contents', resources = join(app, 'Resources/app')
    generated.push({ target: join(target, 'amux'), contents: embeddedCoreCli(join(resources, target, 'amux'),
      join(app, 'MacOS', PRODUCT_NAME), join(resources, coreTarget, 'dist/agentmux.js')), mode: 0o755 })
    links.push({ target: join(target, 'agentmux'), link: 'amux' })
  }
  for (const name of ['ctxmux', 'ctxmuxd']) modes.push({ target: join(PACKAGED_CTXMUX_ROOT, 'darwin-arm64/bin', name), mode: 0o755 })
  return { copies, generated, links, modes, avatar,
    packageIdentity: { target: PACKAGE_IDENTITY_FILENAME, compatibility: packageCompatibilityIdentity({ appVersion: manifest.version, platform: process.platform, arch: process.arch }) },
    coreRelease: join(coreTarget, 'release.json') }
}

export async function copyDirectoryContents(source, destination) {
  // macOS cp uses clonefile; the trailing slash merges contents even when destination exists.
  await promisify(execFile)('cp', ['-cR', `${source}${sep}`, destination])
}

export async function copyRuntimeFiles(copies, appResources) {
  await mkdir(appResources, { recursive: true })
  for (const item of copies) {
    const destination = join(appResources, item.target)
    await mkdir(dirname(destination), { recursive: true })
    if (item.clone) await copyDirectoryContents(item.source, destination)
    else await cp(item.source, destination, { recursive: item.recursive })
  }
}

export async function copyRuntimePayload(payload, appResources, source) {
  await materializeRuntimePayload(payload, appResources)
  await writeRuntimeProvenance(payload, appResources, source)
}

/** Stage the same executable payload for release assembly and private product probes. */
export async function materializeRuntimePayload(payload, appResources) {
  await copyRuntimeFiles(payload.copies, appResources)
  const avatar = payload.avatar, avatarDestination = join(appResources, avatar.destination)
  await mkdir(dirname(avatarDestination), { recursive: true })
  await materializePackageClosure(avatar.closure, avatarDestination, avatar.publication)
  for (const item of payload.generated) {
    const destination = join(appResources, item.target)
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, item.contents)
    if (item.mode !== undefined) await chmod(destination, item.mode)
  }
  for (const item of payload.links) {
    const destination = join(appResources, item.target)
    await mkdir(dirname(destination), { recursive: true }); await symlink(item.link, destination)
  }
  for (const item of payload.modes) await chmod(join(appResources, item.target), item.mode)
}

export async function writeRuntimeProvenance(payload, appResources, source) {
  const identity = createPackageIdentity({ ...payload.packageIdentity.compatibility, sourceCommit: source.commit, sourceTree: source.tree })
  await writeFile(join(appResources, payload.packageIdentity.target), JSON.stringify(identity, null, 2) + '\n')
  await writeFile(join(appResources, payload.coreRelease), JSON.stringify({ sourceCommit: source.commit, sourceTree: source.tree }) + '\n')
}

/** Hash the final effective leaves selected above, including overwritten files and link semantics. */
export async function hashRuntimePayload(payload) {
  const leaves = new Map()
  const excluded = path => path === 'out/renderer' || path.startsWith('out/renderer/') ||
    path === PACKAGED_CTXMUX_ROOT || path.startsWith(PACKAGED_CTXMUX_ROOT + '/')
  async function visit(source, target, clone, root = false) {
    if (excluded(target)) return
    const info = clone && root ? await stat(source) : await lstat(source)
    if (info.isDirectory()) {
      for (const entry of await readdir(source)) await visit(join(source, entry), join(target, entry), clone)
    } else if (info.isSymbolicLink()) {
      const link = await readlink(source)
      // cp -cR preserves links; Node cp's default resolves their source-relative target.
      leaves.set(target, { link: clone ? link : resolve(dirname(source), link) })
    } else {
      leaves.set(target, { source, mode: info.mode & 0o777 })
    }
  }
  for (const item of payload.copies) await visit(item.source, item.target, item.clone, true)
  const avatar = payload.avatar
  for (const pkg of avatar.publication.packages) for (const file of pkg.files) {
    leaves.set(join(avatar.destination, pkg.path, file.path), { source: file.source, mode: file.mode })
  }
  for (const item of avatar.publication.links) leaves.set(join(avatar.destination, item.path), { link: item.target })
  for (const item of payload.generated) {
    if (!excluded(item.target)) leaves.set(item.target, { contents: item.contents,
      mode: item.mode ?? leaves.get(item.target)?.mode ?? (0o666 & ~process.umask()) })
  }
  for (const item of payload.links) leaves.set(item.target, { link: item.link })
  for (const item of payload.modes) if (!excluded(item.target)) leaves.get(item.target).mode = item.mode
  // The two report records retain their original paths; only provenance is projected out.
  leaves.set(payload.packageIdentity.target, { contents: JSON.stringify(payload.packageIdentity.compatibility), mode: 0o666 & ~process.umask() })
  leaves.set(payload.coreRelease, { contents: '{}', mode: 0o666 & ~process.umask() })
  const hash = createHash('sha256')
  for (const [target, value] of [...leaves].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([target, value.link ?? null, value.mode ?? null])); hash.update('\0')
    if (value.source) for await (const bytes of createReadStream(value.source)) hash.update(bytes)
    else if (value.contents !== undefined) hash.update(value.contents)
    hash.update('\0')
  }
  return hash.digest('hex')
}
