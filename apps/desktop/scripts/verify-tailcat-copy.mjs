import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const listener = 'apps/desktop/src/renderer/src/components/settings/HostTailcatListenerFields.tsx'
const copyAction = 'packages/client-ui/src/lib/use-content-copy-action.ts'
await verifyRendererSourceMutations({
  name: 'tailcat-copy-' + randomUUID(),
  tests: ['apps/desktop/test/host-tailcat-settings.test.tsx'],
  sources: [listener, copyAction],
  owningConfig: 'apps/desktop/test/settings-form-rows.config.mts',
  mutations: [
    { label: 'copy-does-not-write-the-shown-original', file: listener, before: 'void copy.copy(address)', after: 'void address' },
    { label: 'copy-feedback-can-be-adopted-by-a-later-owner', file: copyAction,
      before: 'copy?.owner === owner ? copy.state', after: 'copy ? copy.state' }
  ]
})
