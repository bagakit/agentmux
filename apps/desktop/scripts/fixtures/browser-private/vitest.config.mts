import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../../../vitest.config.ts'
import { radixOverlayAliases } from '../../radix-overlay-aliases.ts'

// Match the actual Desktop Renderer dismissal and focus primitives.
export default mergeConfig(base, defineConfig({ resolve: { alias: radixOverlayAliases } }))
