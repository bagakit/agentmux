import { builtinModules } from 'node:module'
import { relative, resolve } from 'node:path'
import { installedRoot, root } from '../settings-resource-library/environment.mjs'
export { aliases, desktopRequire, installedDependency, root } from '../settings-resource-library/environment.mjs'

/** Keep production browser/module export conditions while resolving the installed dependency tree. */
export function browserInstalledDependency(source, importer) {
  if (source.startsWith('.') || source.startsWith('/') || source.startsWith('\0') || source.startsWith('@agentmux/') || source.startsWith('node:') || builtinModules.includes(source)) return
  const installedImporter = importer?.startsWith(root + '/') ? resolve(installedRoot, relative(root, importer)) : importer
  return this.resolve(source, installedImporter, { skipSelf: true })
}
