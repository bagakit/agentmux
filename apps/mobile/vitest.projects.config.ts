import { readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { loadConfigFromFile } from 'vite'
import { configDefaults, defineConfig, type UserWorkspaceConfig } from 'vitest/config'
import base from './vitest.config'

// vitest.config.ts stays the shared base that dedicated, mutant and verifier configs
// extend or pass to --config; a `projects` field there would turn their single-suite
// runs into this full run and drop their instrumentation.
const app = import.meta.dirname
const dedicated = readdirSync(resolve(app, 'test'))
  .filter(file => /\.config\.m?ts$/u.test(file) && !file.endsWith('-mutant.config.ts')).sort()

const projects = await Promise.all(dedicated.map(async file => {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, resolve(app, 'test', file))
  if (!loaded) throw new Error('Dedicated Vitest config did not load: ' + file)
  const config = loaded.config as UserWorkspaceConfig
  const root = config.root ? resolve(app, config.root) : app
  const owned = (config.test?.include ?? []).map(pattern => relative(app, resolve(root, pattern)))
  return { owned, project: { ...config, test: { ...config.test, testNamePattern: undefined, name: file.replace(/\.config\.m?ts$/u, '') } } }
}))

export default defineConfig({
  test: {
    projects: [
      { ...base, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, test: { ...base.test, name: 'mobile', exclude: [...configDefaults.exclude, ...projects.flatMap(value => value.owned)] } },
      ...projects.map(value => value.project)
    ]
  }
})
