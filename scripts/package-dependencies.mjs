import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
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
    const required = manifest.dependencies ?? {}, optional = manifest.optionalDependencies ?? {}
    for (const name of [...new Set([...Object.keys(required), ...Object.keys(optional)])].sort()) {
      let dependency
      try { dependency = await resolvePackageRoot(sourceDirectory, name) }
      catch (error) { if (!(name in optional) || error.code !== 'PACKAGE_DEPENDENCY_UNAVAILABLE') throw error }
      entry.dependencies.push({ name, optional: name in optional, packageId: dependency ? await visit(dependency) : null })
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
