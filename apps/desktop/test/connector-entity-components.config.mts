import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import base from './renderer-hosting-continuation.config.mts'

// Existing mounted consumers retain real Core/Host/RPC/IPC ownership. Only native
// platform I/O, Runtime leaves and the OS clipboard sink are controlled by fixtures.
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/connector-entity-components'),
  test: { ...base.test, fileParallelism: false, passWithNoTests: false,
    include: [
      'apps/desktop/test/application-member-access.test.tsx',
      'apps/desktop/test/connector-details-modern.test.tsx',
      'apps/desktop/test/mote-private-chat-profile.test.tsx',
      'apps/desktop/test/connector-management-authentication.test.tsx',
      'apps/desktop/test/connector-identity-cards.test.tsx',
      'apps/desktop/test/bot-enrollment-pane.test.tsx',
      'apps/desktop/test/channel-profile-consumer.test.tsx',
      'apps/desktop/test/channel-room-name-review.test.tsx',
      'apps/desktop/test/channel-metadata-watch.test.tsx',
      'apps/desktop/test/channel-metadata-bridge.test.tsx'
    ],
    testNamePattern: /copies the observed original person name|keeps late entity profile observations|preselects only a confirmed absent creator|preserves later application choices|shows source failure together|shows the original cached profile for an authorized person outside|starts with compact saved member rows|shows creator unlimited access|the real Settings task follows native scan|one contextual action creates with the exact saved Mote name|explicitly recovers an unknown private handoff|mounted cache management refreshes|the actual saved-profile panel cannot show a late person card|late local profile results cannot cross source Host|native rename changes only|a changed application cannot turn|a late original group read cannot replace|an unavailable preview subscription|keeps the original preview card|refreshes mounted names and actors|does not make a slow metadata opening|refuses a same-name foreign Runtime|rereads the visible original profiles|retains saved profiles on an unavailable watch|streams actual change hints|delivers original Host metadata/,
    testTimeout: 30_000, hookTimeout: 20_000
  }
})
