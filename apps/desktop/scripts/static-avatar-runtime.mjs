import { copyFile, cp, mkdir, readdir, readFile, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { inspectPackageClosure, materializePackageClosure, resolvePackageRoot } from '../../../scripts/package-dependencies.mjs'

/** The small native renderer closure includes its installed platform optional dependency. */
export async function materializeStaticAvatarRuntime(repositoryRoot, appResources) {
  const source = await resolvePackageRoot(join(repositoryRoot, 'apps/host'), '@resvg/resvg-js', repositoryRoot)
  const closure = await inspectPackageClosure(source), destination = join(appResources, 'runtime-dependencies', 'static-avatar')
  await mkdir(dirname(destination), { recursive: true })
  const packages = await materializePackageClosure(closure, destination)
  const entry = join(appResources, 'node_modules', '@resvg', 'resvg-js')
  await mkdir(dirname(entry), { recursive: true })
  await symlink(relative(dirname(entry), join(destination, 'node_modules', '@resvg', 'resvg-js')), entry)
  const owner = join(repositoryRoot, 'packages/client-ui'), resources = join(appResources, 'node_modules/@agentmux/client-ui')
  await mkdir(resources, { recursive: true }); await copyFile(join(owner, 'package.json'), join(resources, 'package.json'))
  const icons = 'src/assets/agent-icons'
  await cp(join(owner, icons), join(resources, icons), { recursive: true })
  const assets = Object.fromEntries(await Promise.all((await readdir(join(owner, icons))).map(async file => [file,
    createHash('sha256').update(await readFile(join(resources, icons, file))).digest('hex')])))
  return { packages, assets }
}
