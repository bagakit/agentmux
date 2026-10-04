import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import moteConfig from '../mote-navigation-footer/vitest.owning.config.mts'

// The Launcher UI consumes current package Source, with no native Run or dist claim.
export default defineConfig({
  ...moteConfig,
  esbuild: { jsx: 'automatic' },
  plugins: [{
    name: 'launcher-mote-proof-inputs', enforce: 'pre',
    transform(_code, id) {
      const trace = process.env.AGENTMUX_LAUNCHER_PROOF_INPUTS
      if (!trace || id.startsWith('\0')) return
      const path = id.split('?')[0]!
      const repository = realpathSync(resolve(moteConfig.root!, '../..'))
      const source = relative(repository, realpathSync(path))
      if (!source.startsWith('apps/desktop/src/') && !source.startsWith('packages/')) return
      if (source.includes('/node_modules/')) return
      appendFileSync(trace, JSON.stringify({ path: source, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }) + '\n')
    }
  }],
  test: {
    ...moteConfig.test,
    include: ['test/launcher-mote-create.test.tsx', 'test/launcher-launchpad.test.tsx', 'test/mote-archive-interaction.test.tsx'],
    passWithNoTests: false
  }
})
