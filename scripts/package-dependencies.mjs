import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const exec = promisify(execFile)

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

/** Materialize the installed graph once; npm owns files/ignore publication semantics. */
export async function materializePackageClosure(closure, directory) {
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
  await mkdir(directory)
  const packagePath = id => join(directory, 'node_modules', '.packages', String(id))
  const within = (root, path) => { const offset = relative(root, path); return offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset) }
  for (const original of closure.packages) {
    const publication = packed[original.id]
    if (publication.name !== original.name || publication.version !== original.version || !publication.files?.length) throw new Error('npm described a different original package.')
    for (const file of publication.files) {
      const source = resolve(original.sourceDirectory, file.path), target = resolve(packagePath(original.id), file.path)
      if (isAbsolute(file.path) || !within(original.sourceDirectory, source) || !within(packagePath(original.id), target) ||
          !within(original.sourceDirectory, await realpath(source))) throw new Error('A published package file escapes its original package.')
      const info = await lstat(source)
      if (!info.isFile()) throw new Error('A published package entry is not a regular file.')
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target, constants.COPYFILE_EXCL)
      await chmod(target, info.mode & 0o777)
    }
    const manifest = await readFile(join(packagePath(original.id), 'package.json'))
    if (createHash('sha256').update(manifest).digest('hex') !== original.manifestSha256) throw new Error('The original package manifest changed during materialization.')
  }
  for (const original of closure.packages) for (const dependency of original.dependencies) {
    if (dependency.packageId === null) continue
    const link = join(packagePath(original.id), 'node_modules', ...dependency.name.split('/'))
    await mkdir(dirname(link), { recursive: true })
    await symlink(relative(dirname(link), packagePath(dependency.packageId)), link)
  }
  const original = closure.packages[closure.root], entry = join(directory, 'node_modules', ...original.name.split('/'))
  await mkdir(dirname(entry), { recursive: true })
  await symlink(relative(dirname(entry), packagePath(original.id)), entry)
  return closure.packages.map(({ sourceDirectory: _source, ...value }) => ({ ...value, path: relative(directory, packagePath(value.id)).split(sep).join('/') }))
}
