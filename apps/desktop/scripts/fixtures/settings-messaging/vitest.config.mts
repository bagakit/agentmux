import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'
import base from '../settings-policy-polish/vitest.config.mts'
import { aliases } from '../settings-resource-library/environment.mjs'

const require = createRequire(new URL('../../../package.json', import.meta.url))
const reactAliases = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => ({ find: new RegExp('^' + name + '$'), replacement: require.resolve(name) }))

export default defineConfig({ ...base,
  resolve: { alias: [...reactAliases, ...aliases] },
  test: { ...base.test, include: ['apps/desktop/test/settings-messaging-expression.test.tsx'] }
})
