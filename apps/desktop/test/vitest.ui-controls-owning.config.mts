import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import owning from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'

// These Renderer consumers also use the Host's public projection exports.
// Follow the exact manifest to the current source, as the existing owning config does for packages.
const host = resolve(import.meta.dirname, '../../host')
const manifest = JSON.parse(readFileSync(resolve(host, 'package.json'), 'utf8'))
const aliases = Object.entries(manifest.exports).map(([key, value]) => ({
  find: '@agentmux/host' + key.slice(1),
  replacement: resolve(host, (value as { import: string }).import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
}))
export default defineConfig({ ...owning, resolve: { ...owning.resolve, alias: [...aliases, ...owning.resolve!.alias as []] } })
