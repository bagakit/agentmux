import { copyFile, cp, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The extension cannot resolve workspace imports. Copy the shared, dependency-free build verbatim. */
export async function prepareBrowserExtensionIdentity(directory = resolve(import.meta.dirname, '../browser-extension')) {
  const source = new URL(import.meta.resolve('@agentmux/identity/runtime'))
  const bytes = await readFile(source, 'utf8')
  if (/\b(?:import\s|require\s*\()/.test(bytes)) throw new Error('The extension identity runtime must be self-contained.')
  await mkdir(directory, { recursive: true })
  const destination = resolve(directory, 'identity-runtime.js')
  await copyFile(source, destination)
  return destination
}

export async function copyBrowserExtension(destination) {
  await cp(resolve(import.meta.dirname, '../browser-extension'), destination, { recursive: true })
  await prepareBrowserExtensionIdentity(destination)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await prepareBrowserExtensionIdentity()
