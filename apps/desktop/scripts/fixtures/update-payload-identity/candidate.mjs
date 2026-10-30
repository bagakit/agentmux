import { cp, mkdir, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { copyDirectoryContents } from '../../runtime-application-payload.mjs'

/** One private candidate using current sources and explicitly identified existing dependencies. */
export async function prepareCandidate(repository, candidate) {
  const borrowed = []
  async function link(path, source) {
    const target = join(candidate, path)
    await mkdir(dirname(target), { recursive: true }); await symlink(source, target)
    borrowed.push({ path, source, rebuilt: false })
  }
  async function copy(path) {
    await mkdir(dirname(join(candidate, path)), { recursive: true })
    await cp(join(repository, path), join(candidate, path), { recursive: true })
  }
  for (const path of ['package.json', 'tsconfig.base.json', 'THIRD_PARTY_NOTICES.md', 'scripts/package-dependencies.mjs',
    'apps/desktop/scripts', 'apps/desktop/package.json', 'apps/desktop/electron.vite.config.ts',
    'apps/desktop/src/shared', 'apps/desktop/browser-extension', 'apps/host/src', 'apps/host/package.json',
    'packages/git/src', 'packages/git/package.json', 'packages/git/tsconfig.json', 'packages/git/tsconfig.build.json',
    'packages/core/package.json', 'packages/core/bin', 'packages/core/src', 'packages/core/scripts', 'packages/core/guides',
    'packages/core/native', 'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json',
    'packages/demand/package.json', 'packages/connectors/package.json']) await copy(path)
  for (const path of ['apps/desktop/src/main', 'apps/desktop/resources', 'apps/host/node_modules', 'apps/host/dist',
    'packages/client-ui', 'packages/git/node_modules', 'packages/core/node_modules',
    'packages/demand/node_modules', 'packages/demand/dist', 'packages/connectors/node_modules']) await link(path, await realpath(join(repository, path)))
  // Clone the already built unaffected outputs; Main/Host and Git are rebuilt below.
  for (const path of ['apps/desktop/out', 'packages/core/vendor']) {
    await mkdir(dirname(join(candidate, path)), { recursive: true })
    await copyDirectoryContents(join(repository, path), join(candidate, path))
    borrowed.push({ path, source: await realpath(join(repository, path)), rebuilt: false })
  }
  // Vite writes beside its config under node_modules/.vite-temp. Link dependencies,
  // not the parent or its tool caches, so every config/build cache stays private.
  for (const directory of ['node_modules', 'apps/desktop/node_modules']) {
    const modules = join(repository, directory)
    await mkdir(join(candidate, directory), { recursive: true })
    for (const entry of await readdir(modules)) {
      if (entry.startsWith('.') && entry !== '.bin') continue
      const names = entry.startsWith('@') ? (await readdir(join(modules, entry))).map(name => join(entry, name)) : [entry]
      for (const name of names) {
        const target = join(directory, name)
        if (name === '@agentmux/git') {
          await mkdir(dirname(join(candidate, target)), { recursive: true })
          await symlink(join(candidate, 'packages/git'), join(candidate, target))
        } else await link(target, join(modules, name)) // Preserve the original entry, including an unused dangling link.
      }
    }
  }
  // Only the original main recipe is selected; electron-vite still owns resolution and its build plugins.
  const host = join(candidate, 'apps/host/src/index.ts'), observations = join(candidate, 'main-build-observation.json')
  await writeFile(join(candidate, 'apps/desktop/payload-proof.config.mjs'), `import actual from './electron.vite.config.ts';
import {createHash} from 'node:crypto';import{writeFile}from'node:fs/promises';
const seen={};const observe={name:'payload-original-host-source',transform(code,id){if(id===${JSON.stringify(host)})seen[id]=createHash('sha256').update(code).digest('hex')},async closeBundle(){await writeFile(${JSON.stringify(observations)},JSON.stringify(seen))}};
export default {main:{...actual.main,plugins:[...(actual.main.plugins??[]),observe]}};\n`)
  return borrowed
}
