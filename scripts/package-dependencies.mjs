import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

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
