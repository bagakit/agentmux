import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const mutation = process.env.AGENTMUX_HOST_IDENTITY_MUTANT ? JSON.parse(readFileSync(process.env.AGENTMUX_HOST_IDENTITY_MUTANT, 'utf8')) as { target: string; before: string; after: string } : null
export default defineConfig({
  define: { __AGENTMUX_WEB_PREVIEW__: true },
  resolve: { alias: ['notebook-catalog', 'prompt-reaction'].map(name => ({ find: `@agentmux/core/${name}`, replacement: `${root}packages/core/src/${name}.ts` })) },
  plugins: mutation ? [{ name: 'loaded-host-identity-mutant', enforce: 'pre' as const, transform(source: string, id: string) {
    if (id.split('?')[0] !== `${root}${mutation.target}`) return
    if (!source.includes(mutation.before)) throw new Error('The owning implementation mutation point changed')
    return source.replace(mutation.before, mutation.after)
  } }] : [],
  test: { include: ['apps/desktop/test/host-identity.test.tsx'], environment: 'happy-dom' }, esbuild: { jsx: 'automatic' }
})
