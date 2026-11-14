import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const pane = 'apps/desktop/src/renderer/src/components/settings/RemoteExecutionSettingsPane.tsx'
const test = 'apps/desktop/test/remote-execution-tabs.test.tsx'
const tabs = 'packages/client-ui/src/components/Tabs.tsx'
await verifyRendererSourceMutations({
  name: 'remote-execution-tabs-' + randomUUID(),
  tests: [test],
  sources: [pane, tabs, 'apps/desktop/src/renderer/src/components/SettingsPanel.tsx'],
  owningConfig: 'apps/desktop/test/remote-execution-tabs.config.mts',
  mutations: [
    { label: 'remote-tab-does-not-activate-original-panel', file: pane,
      before: 'onValueChange={changeTask}', after: 'onValueChange={() => {}}' }
  ]
})
