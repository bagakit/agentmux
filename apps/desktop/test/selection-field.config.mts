import { radixOverlayAliases } from '../scripts/radix-overlay-aliases'
import type { Alias } from 'vite'
import { defineConfig } from 'vitest/config'
import owning from '../scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts'
export default defineConfig({ ...owning, resolve: { alias: [...(owning.resolve!.alias as Alias[]), ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement }))] }, test: { ...owning.test, server: { deps: { inline: [/@radix-ui\//] } }, include: ['test/selection-field.test.tsx', 'test/mote-quick-mode.test.tsx', 'test/mote-daily-work.test.tsx', 'test/mote-details-cost.test.tsx', 'test/mote-session-cost.test.tsx'], passWithNoTests: false } })
