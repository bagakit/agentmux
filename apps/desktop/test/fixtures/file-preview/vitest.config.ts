import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import base from '../../../../../vitest.config'

// The current checkout itself lives under .worktrees. Keep all other normal guards and exclusions.
export default defineConfig({ ...base, resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } }, root: fileURLToPath(new URL('../../../../../', import.meta.url)),
  test: { ...base.test, exclude: base.test!.exclude!.filter(pattern => pattern !== '.worktrees/**') } })
