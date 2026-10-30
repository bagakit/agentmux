import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolvePackageRoot } from '../../../scripts/package-dependencies.mjs'

export async function browserExtensionIdentity(repositoryRoot = resolve(import.meta.dirname, '../../..')) {
  const owner = await resolvePackageRoot(join(repositoryRoot, 'apps/desktop'), '@agentmux/identity', repositoryRoot)
  const manifest = JSON.parse(await readFile(join(owner, 'package.json'), 'utf8'))
  const source = join(owner, manifest.exports['./runtime'].import), bytes = await readFile(source, 'utf8')
  if (/\b(?:import\s|require\s*\()/.test(bytes)) throw new Error('The extension identity runtime must be self-contained.')
  return bytes
}

export async function inspectBrowserExtension(repositoryRoot) {
  return { source: join(repositoryRoot, 'apps/desktop/browser-extension'),
    runtime: { path: 'identity-runtime.js', contents: await browserExtensionIdentity(repositoryRoot) } }
}

export async function copyBrowserExtension(directory) {
  const original = await inspectBrowserExtension(resolve(import.meta.dirname, '../../..'))
  await cp(original.source, directory, { recursive: true })
  await writeFile(join(directory, original.runtime.path), original.runtime.contents)
}

/** The extension cannot resolve workspace imports. Copy the shared, dependency-free build verbatim. */
export async function prepareBrowserExtensionIdentity(directory = resolve(import.meta.dirname, '../browser-extension')) {
  const bytes = await browserExtensionIdentity()
  await mkdir(directory, { recursive: true })
  const destination = resolve(directory, 'identity-runtime.js')
  await writeFile(destination, bytes)
  return destination
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await prepareBrowserExtensionIdentity()
