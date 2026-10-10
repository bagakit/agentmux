import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../../../vitest.config.ts'
import { radixOverlayAliases } from '../../radix-overlay-aliases.ts'

const coreDist = dirname(realpathSync(fileURLToPath(import.meta.resolve('@agentmux/core')))).replaceAll('\\', '/')
const compiledCore = new RegExp('^' + coreDist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:/|$)')

// Match the actual Desktop Renderer dismissal and focus primitives.
export default mergeConfig(base, defineConfig({
  resolve: { alias: radixOverlayAliases },
  // Core is a compiled Node consumer even when its caller uses happy-dom.
  // Resolve its compiled entry after workspace symlinks; Core source tests stay transformed.
  test: { server: { deps: { external: [compiledCore] } } }
}))
