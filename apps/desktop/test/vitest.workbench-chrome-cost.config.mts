import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

const chromeGate = 'surfaceVisible && !conversationChrome && <TopRowLeadingChrome />'
const mutations = {
  parked: '!conversationChrome && <TopRowLeadingChrome />',
  conversation: 'surfaceVisible && <TopRowLeadingChrome />'
}
const mutation = process.env.AGENTMUX_WORKBENCH_CHROME_MUTANT as keyof typeof mutations | undefined
if (mutation) assert(Object.hasOwn(mutations, mutation), 'Known Workbench chrome mutation')

export default defineConfig({
  ...base, cacheDir: resolve(base.root!, '.tmp/workbench-chrome-cost-vitest'),
  plugins: [...(base.plugins ?? []), {
    name: 'observe-original-workbench-chrome', enforce: 'pre',
    transform(original, id) {
      if (!id.includes('/apps/desktop/src/renderer/src/components/')) return
      if (mutation && id.endsWith('/WorkspaceWorkbench.tsx')) {
        assert.equal(original.split(chromeGate).length, 2, 'Unique original Pane chrome mount')
        process.stderr.write(`MUTATION_APPLIED=${mutation}\n`)
        return { code: original.replace(chromeGate, mutations[mutation]), map: null }
      }
      if (!id.endsWith('/TopRowChrome.tsx')) return
      const selector = 'export function TopRowLeadingChrome() {\n  const preferredProjects = useAppStore((state) => state.projectRailOpen)'
      assert.equal(original.split(selector).length, 2, 'Observe the actual window chrome subscriber')
      return { code: original.replace(selector, `export function TopRowLeadingChrome() {
  const preferredProjects = useAppStore((state) => {
    globalThis.__agentmuxCountWorkbenchChromeRead?.()
    return state.projectRailOpen
  })`), map: null }
    }
  }],
  test: { ...base.test, include: ['apps/desktop/test/workbench-chrome-cost.test.tsx'], setupFiles: [],
    globalSetup: [], passWithNoTests: false, testTimeout: 30000 }
})
