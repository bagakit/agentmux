import { cp, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ToolkitPackageConfiguration } from '@agentmux/core/control'

type InitialPackage = { id: string; directory: string; args: string[] }
export type ToolkitPackageDeploymentIssue = { toolId: string; path: string; reason: string }

/** Seed assets are copied once; existing user source and partially copied files are preserved. */
export async function bootstrapToolkitPackages(args: { resourceRoot: string; packageRoot: string; workspacePath: string
  packages: readonly InitialPackage[]; reportIssue(issue: ToolkitPackageDeploymentIssue): void }): Promise<ToolkitPackageConfiguration[]> {
  const tools: ToolkitPackageConfiguration[] = []
  for (const seed of args.packages) {
    // The packaged seed table names one directory, never a filesystem escape.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(seed.directory)) {
      args.reportIssue({ toolId: seed.id, path: args.packageRoot, reason: 'Initial package directory is invalid.' })
      continue
    }
    const packagePath = join(args.packageRoot, seed.directory)
    tools.push({ kind: 'package', id: seed.id, revision: randomUUID(), packagePath, enabled: true,
      statusBar: 'icon', args: [...seed.args], workspacePath: args.workspacePath })
    try {
      await mkdir(args.packageRoot, { recursive: true })
      try { await mkdir(packagePath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      const source = join(args.resourceRoot, seed.directory)
      for (const file of await readdir(source)) {
        await cp(join(source, file), join(packagePath, file), { recursive: true, force: false, errorOnExist: true })
      }
    } catch (error) {
      // The ordinary reference exposes current source availability through Toolkit inspect/ls.
      args.reportIssue({ toolId: seed.id, path: packagePath,
        reason: `Package deployment is incomplete: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return tools
}
