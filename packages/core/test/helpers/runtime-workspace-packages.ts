import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'

export type RuntimeWorkspacePackage = {
  directory: string
  source: string
  manifest: { name: string; version: string; files: string[]; scripts?: Record<string, string>; dependencies?: Record<string, string> }
}

/** The private publish workspace contains the declared runtime workspace closure. */
export async function runtimeWorkspacePackages(packageRoot: string): Promise<RuntimeWorkspacePackage[]> {
  const visited = new Set<string>(), packages: RuntimeWorkspacePackage[] = []
  async function visit(source: string): Promise<void> {
    source = await realpath(source)
    if (visited.has(source)) return
    visited.add(source)
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as RuntimeWorkspacePackage['manifest']
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!version.startsWith('workspace:')) continue
      const resolver = createRequire(join(source, 'package.json'))
      let dependency: string | undefined
      for (const directory of resolver.resolve.paths(name) ?? []) {
        try { dependency = await realpath(join(directory, name)); break }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
      }
      if (!dependency) throw new Error(`Runtime workspace dependency ${name} of ${source} is missing`)
      await visit(dependency)
    }
    packages.push({ directory: basename(source), source, manifest })
  }
  await visit(packageRoot)
  if (!packages.length) throw new Error('Runtime workspace package closure is empty')
  return packages
}
