import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, root } from '../settings-resource-library/environment.mjs'

const mutationFile = process.env.AGENTMUX_SETTINGS_ACCESS_MUTATION
const mutation = mutationFile ? JSON.parse(readFileSync(mutationFile, 'utf8')) : null
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const localReact = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-dom/server']
  .map(name => ({ find: new RegExp('^' + name + '$'), replacement: require.resolve(name) }))

export default defineConfig({ root, resolve: { alias: [...localReact, ...aliases], dedupe: ['react', 'react-dom'] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{ name: 'settings-access-actual-owner', enforce: 'pre',
    transform(source, id) {
      if (!mutation || id !== resolve(root, mutation.file)) return
      assert.equal(source, readFileSync(id, 'utf8'))
      assert.equal(source.split(mutation.before).length, 2, 'One original owner mutation anchor')
      const consumed = source.replace(mutation.before, mutation.after)
      appendFileSync(mutation.receipt, JSON.stringify({ file: mutation.file, original: sha(source), consumed: sha(consumed) }) + '\n')
      return { code: consumed, map: null }
    } }],
  test: { include: ['apps/desktop/test/settings-connectivity-presentation.test.tsx'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], server: { deps: { inline: true } },
    maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
