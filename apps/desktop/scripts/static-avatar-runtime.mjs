import { copyFile, cp, mkdir, readdir, readFile, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { inspectPackageClosure, inspectPackagePublication, materializePackageClosure, resolvePackageRoot } from '../../../scripts/package-dependencies.mjs'

/** The small native renderer closure includes its installed platform optional dependency. */
export async function inspectStaticAvatarRuntime(repositoryRoot) {
  const source = await resolvePackageRoot(join(repositoryRoot, 'apps/host'), '@resvg/resvg-js', repositoryRoot)
  const closure = await inspectPackageClosure(source), publication = await inspectPackagePublication(closure)
  const destination = 'runtime-dependencies/static-avatar', entry = 'node_modules/@resvg/resvg-js'
  const owner = join(repositoryRoot, 'packages/client-ui'), resources = 'node_modules/@agentmux/client-ui', icons = 'src/assets/agent-icons'
  return { closure, publication, destination, entry,
    link: relative(dirname(entry), join(destination, 'node_modules/@resvg/resvg-js')),
    manifest: { source: join(owner, 'package.json'), target: join(resources, 'package.json') },
    icons: { source: join(owner, icons), target: join(resources, icons) } }
}

export async function materializeStaticAvatarRuntime(repositoryRoot, appResources) {
  const original = await inspectStaticAvatarRuntime(repositoryRoot), destination = join(appResources, original.destination)
  await mkdir(dirname(destination), { recursive: true })
  const packages = await materializePackageClosure(original.closure, destination, original.publication)
  const entry = join(appResources, original.entry)
  await mkdir(dirname(entry), { recursive: true }); await symlink(original.link, entry)
  const manifest = join(appResources, original.manifest.target), icons = join(appResources, original.icons.target)
  await mkdir(dirname(manifest), { recursive: true }); await copyFile(original.manifest.source, manifest)
  await cp(original.icons.source, icons, { recursive: true })
  const assets = Object.fromEntries(await Promise.all((await readdir(original.icons.source)).map(async file => [file,
    createHash('sha256').update(await readFile(join(icons, file))).digest('hex')])))
  return { packages, assets }
}
