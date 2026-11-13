import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const within = (root, path) => { const offset = relative(root, path); return offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset) }

/** The packaging resolver follows the installed package's own Node ancestor lookup. */
export async function resolvePackageRoot(sourcePackage, packageName, stopDirectory) {
  let current = sourcePackage
  while (true) {
    const candidate = join(current, 'node_modules', ...packageName.split('/'))
    if (await lstat(candidate).then(() => true, () => false)) return await realpath(candidate)
    if (current === stopDirectory) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw Object.assign(new Error(`Could not resolve package root for ${packageName} from ${sourcePackage}.`), { code: 'PACKAGE_DEPENDENCY_UNAVAILABLE' })
}

/** Local inventory only: no copying, install, lifecycle scripts or archive construction. */
export async function inspectPackageClosure(packageRoot) {
  const packages = [], visited = new Map()
  const visit = async directory => {
    const sourceDirectory = await realpath(directory)
    if (visited.has(sourceDirectory)) return visited.get(sourceDirectory)
    const bytes = await readFile(join(sourceDirectory, 'package.json')), manifest = JSON.parse(bytes)
    const id = packages.length
    visited.set(sourceDirectory, id)
    const entry = { id, name: manifest.name, version: manifest.version,
      manifestSha256: createHash('sha256').update(bytes).digest('hex'), sourceDirectory, dependencies: [] }
    packages.push(entry)
    const required = manifest.dependencies ?? {}, optional = manifest.optionalDependencies ?? {}, peers = manifest.peerDependencies ?? {}
    for (const name of [...new Set([...Object.keys(required), ...Object.keys(optional), ...Object.keys(peers)])].sort()) {
      // Peers use this installed package's physical Node lookup context, including
      // pnpm peer-specific siblings. Never flatten them to the publication root.
      const requiredPeer = Object.hasOwn(peers, name) && manifest.peerDependenciesMeta?.[name]?.optional !== true
      const canBeAbsent = !requiredPeer && (Object.hasOwn(optional, name) || !Object.hasOwn(required, name) && manifest.peerDependenciesMeta?.[name]?.optional === true)
      let dependency
      try { dependency = await resolvePackageRoot(sourceDirectory, name) }
      catch (error) { if (!canBeAbsent || error.code !== 'PACKAGE_DEPENDENCY_UNAVAILABLE') throw error }
      entry.dependencies.push({ name, optional: canBeAbsent, packageId: dependency ? await visit(dependency) : null })
    }
    return id
  }
  return { root: await visit(packageRoot), packages }
}

/** Read the original npm publication selection without copying its packages. */
export async function inspectPackagePublication(closure) {
  const cache = await mkdtemp(join(tmpdir(), 'amux-package-files-'))
  let packed
  try {
    const result = await exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline', '--workspaces=false',
      ...closure.packages.map(value => value.sourceDirectory)], {
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: cache, pnpm_config_verify_deps_before_run: 'false' }
    })
    packed = JSON.parse(result.stdout)
  } finally { await rm(cache, { recursive: true, force: true }) }
  if (!Array.isArray(packed) || packed.length !== closure.packages.length) throw new Error('npm did not describe the complete original package closure.')
  const publications = []
  for (const original of closure.packages) {
    const publication = packed[original.id]
    if (publication.name !== original.name || publication.version !== original.version || !publication.files?.length) throw new Error('npm described a different original package.')
    const files = []
    for (const file of publication.files) {
      const source = resolve(original.sourceDirectory, file.path)
      if (isAbsolute(file.path) || !within(original.sourceDirectory, source) ||
          !within(original.sourceDirectory, await realpath(source))) throw new Error('A published package file escapes its original package.')
      const info = await lstat(source)
      if (!info.isFile()) throw new Error('A published package entry is not a regular file.')
      files.push({ path: file.path, source, mode: info.mode & 0o777 })
    }
    publications.push({ id: original.id, files })
  }
  const packagePath = id => join('node_modules', '.packages', String(id)), links = []
  for (const original of closure.packages) for (const dependency of original.dependencies) {
    if (dependency.packageId === null) continue
    const path = join(packagePath(original.id), 'node_modules', ...dependency.name.split('/'))
    links.push({ path, target: relative(dirname(path), packagePath(dependency.packageId)) })
  }
  const original = closure.packages[closure.root], entry = join('node_modules', ...original.name.split('/'))
  links.push({ path: entry, target: relative(dirname(entry), packagePath(original.id)) })
  return { packages: publications.map(value => ({ ...value, path: packagePath(value.id) })), links,
    report: closure.packages.map(({ sourceDirectory: _source, ...value }) => ({ ...value, path: packagePath(value.id).split(sep).join('/') })) }
}

/** Materialize the installed graph once; npm owns files/ignore publication semantics. */
export async function materializePackageClosure(closure, directory, publications) {
  publications ??= await inspectPackagePublication(closure)
  await mkdir(directory)
  for (const original of closure.packages) {
    const publication = publications.packages[original.id]
    for (const file of publication.files) {
      const packageRoot = resolve(directory, publication.path), target = resolve(packageRoot, file.path)
      if (isAbsolute(file.path) || !within(packageRoot, target)) throw new Error('A published package file escapes its original package.')
      await mkdir(dirname(target), { recursive: true })
      await copyFile(file.source, target, constants.COPYFILE_EXCL)
      await chmod(target, file.mode)
    }
    const manifest = await readFile(join(directory, publication.path, 'package.json'))
    if (createHash('sha256').update(manifest).digest('hex') !== original.manifestSha256) throw new Error('The original package manifest changed during materialization.')
  }
  for (const value of publications.links) {
    const link = join(directory, value.path)
    await mkdir(dirname(link), { recursive: true })
    await symlink(value.target, link)
  }
  return publications.report
}

// Type declarations and source maps describe sources; an installed runtime never reads them.
export const DEVELOPMENT_FILE = /\.(?:js\.map|d\.ts|d\.ts\.map)$/u

/**
 * The files a runtime dependency ships: an installed package (inside node_modules) ships
 * as installed; a workspace checkout ships npm's own publication of it. Development files
 * are dropped from both. Paths are relative to the package root. One owner decides this
 * for the App bundle, the portable remote Core and the Linux release.
 *
 * `workspaceRoots` lists every workspace checkout the caller will ask about, so their
 * publications are read with one npm call instead of one per package.
 */
export async function runtimePackageSelection(workspaceRoots = []) {
  const roots = [...new Set(await Promise.all(workspaceRoots.map(root => realpath(root))))]
  const workspaces = roots.length ? await workspacePublications(roots) : new Map()
  return async function files(packageRoot) {
    const root = await realpath(packageRoot)
    if (root.split(sep).includes('node_modules')) return await installedFiles(root)
    const selected = workspaces.get(root) ?? (await workspacePublications([root])).get(root)
    workspaces.set(root, selected)
    return selected
  }
}

async function installedFiles(root) {
  const files = []
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') await visit(path) }
      else if (!DEVELOPMENT_FILE.test(entry.name)) files.push(relative(root, path))
    }
  }
  await visit(root)
  return files.sort()
}

async function workspacePublications(roots) {
  const cache = await mkdtemp(join(tmpdir(), 'amux-package-files-'))
  try {
    const result = await exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline', '--workspaces=false', ...roots],
      { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, npm_config_cache: cache, pnpm_config_verify_deps_before_run: 'false' } })
    const packed = JSON.parse(result.stdout)
    if (!Array.isArray(packed) || packed.length !== roots.length) throw new Error('npm did not describe every workspace package.')
    const selected = new Map()
    for (const [index, root] of roots.entries()) {
      const publication = packed[index]
      if (!publication?.files?.length) throw new Error(`npm described no published files for ${root}.`)
      const files = []
      for (const { path } of publication.files) {
        const source = resolve(root, path)
        if (isAbsolute(path) || !within(root, source) || !within(root, await realpath(source))) throw new Error('A published package file escapes its original package.')
        if (!DEVELOPMENT_FILE.test(path)) files.push(path)
      }
      selected.set(root, files.sort())
    }
    return selected
  } finally { await rm(cache, { recursive: true, force: true }) }
}

/**
 * A runtime Core assembled exactly as the App bundles it: Core's own runtime entries, a
 * dependency-free manifest, release identity, and every dependency's runtime files under
 * nested node_modules. The portable remote Core and the Linux release are built from it.
 */
export async function materializeRuntimeCore(repositoryRoot, destination, release) {
  const core = join(repositoryRoot, 'packages/core')
  const manifest = JSON.parse(await readFile(join(core, 'package.json'), 'utf8'))
  const files = await runtimePackageSelection(['capsule', 'demand', 'diagnostic-evidence', 'git', 'identity', 'relay']
    .map(name => join(repositoryRoot, 'packages', name)))
  const copyTree = async (source, target) => {
    const info = await lstat(source)
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true })
      for (const entry of await readdir(source)) await copyTree(join(source, entry), join(target, entry))
    } else if (!DEVELOPMENT_FILE.test(source)) { await mkdir(dirname(target), { recursive: true }); await copyFile(source, target); await chmod(target, info.mode & 0o777) }
  }
  for (const name of ['dist', 'vendor', 'bin']) await copyTree(join(core, name), join(destination, name))
  await copyTree(join(core, 'src/ctxmux-artifact-contract.json'), join(destination, 'src/ctxmux-artifact-contract.json'))
  const { name, version, type, main, exports, engines, os, cpu, license, repository, bin } = manifest
  await writeFile(join(destination, 'package.json'), JSON.stringify({ name, version, type, main, exports, engines, os, cpu, license, repository, bin }, null, 2) + '\n')
  await writeFile(join(destination, 'release.json'), JSON.stringify(release) + '\n')
  const dependency = async (owner, packageName, target) => {
    const source = await resolvePackageRoot(owner, packageName, repositoryRoot)
    for (const file of await files(source)) await copyTree(join(source, file), join(target, file))
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    for (const child of Object.keys(pkg.dependencies ?? {}).sort()) await dependency(source, child, join(target, 'node_modules', ...child.split('/')))
  }
  for (const child of Object.keys(manifest.dependencies ?? {}).sort()) await dependency(core, child, join(destination, 'node_modules', ...child.split('/')))
  return destination
}
