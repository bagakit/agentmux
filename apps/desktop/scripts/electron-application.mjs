import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { resolvePackageRoot } from '../../../scripts/package-dependencies.mjs'

async function electronPackage(repositoryRoot) {
  const desktopRoot = join(repositoryRoot, 'apps/desktop')
  const desktop = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
  const packageRoot = await resolvePackageRoot(desktopRoot, 'electron', repositoryRoot)
  const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (desktop.devDependencies.electron !== installed.version) throw new Error('The installed Electron package does not match this candidate\'s exact declaration. Prepare its declared dependencies before building; the installed App is unchanged.')
  return { packageRoot, version: installed.version }
}

/** Read the same prepared artifact that the normal builder and macOS copier use. */
export async function inspectElectronApplication(repositoryRoot) {
  const { packageRoot, version } = await electronPackage(repositoryRoot), dist = join(packageRoot, 'dist')
  const actualVersion = (await readFile(join(dist, 'version'), 'utf8')).trim().replace(/^v/u, '')
  if (actualVersion !== version) throw new Error('The candidate Electron artifact does not match its installed package version. Rebuild the candidate; the installed App is unchanged.')
  const entry = (await readFile(join(packageRoot, 'path.txt'), 'utf8')).trim(), executable = resolve(dist, entry)
  const offset = relative(dist, executable)
  if (!entry || isAbsolute(entry) || offset === '..' || offset.startsWith('..' + sep) || !(await stat(executable)).isFile()) throw new Error('The candidate Electron package has no original executable entry.')
  const application = process.platform === 'darwin' ? join(dist, 'Electron.app') : null
  if (application && !(await stat(application)).isDirectory()) throw new Error('The candidate Electron application is missing.')
  return { packageRoot, version, executable, application, artifactRoot: application ?? dist }
}

/** Original Electron preparation belongs to the normal build, before publishing compatibility. */
export async function prepareElectronApplication(repositoryRoot) {
  const { packageRoot } = await electronPackage(repositoryRoot)
  await promisify(execFile)(process.execPath, [join(packageRoot, 'install.js')], { maxBuffer: 4 * 1024 * 1024 })
  return await inspectElectronApplication(repositoryRoot)
}

export async function hashElectronArtifact(artifactRoot) {
  const hash = createHash('sha256')
  async function visit(path) {
    const info = await lstat(path), target = relative(artifactRoot, path)
    const kind = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : 'file'
    hash.update(JSON.stringify([target, kind, info.mode & 0o777])); hash.update('\0')
    if (info.isSymbolicLink()) hash.update(await readlink(path))
    else if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    else for await (const bytes of createReadStream(path)) hash.update(bytes)
    hash.update('\0')
  }
  await visit(artifactRoot)
  return hash.digest('hex')
}
