import { readFileSync } from 'node:fs'
import { exactReplace, verifyWorkfaceMutations } from './lib/workface-mutation-proof.mjs'

const agent = 'apps/desktop/src/renderer/src/lib/workface-agent-view.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const helper = 'apps/desktop/src/renderer/src/lib/session-presentation.ts'
const read = path => readFileSync(path, 'utf8')
verifyWorkfaceMutations({ operation: 'agent-view', testPath: 'apps/desktop/test/workface-agent-view-control.test.tsx',
  sourcePaths: [agent, store, helper, 'apps/desktop/src/renderer/src/components/SessionPane.tsx',
    'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/lib/desktop-presentation.ts'],
  callers: [ { symbol: 'executeWorkfaceAgentView', definition: agent }, { symbol: 'setViewMode', definition: store },
    { symbol: 'effectiveSessionViewMode', definition: helper } ],
  variants: [
    { name: 'preference-owner-withdrawn', changes: { [agent]: exactReplace(read(agent),
      'ports.setViewMode(id, request.mode, { focus: false })', 'void request.mode') } },
    { name: 'presentation-only-strategy-withdrawn', changes: { [store]: exactReplace(read(store),
      '...(options?.focus === false ? {} : { agentFocus: focusSessionContext(state, sessionId) })',
      'agentFocus: focusSessionContext(state, sessionId)') } },
    { name: 'valid-own-mode-withdrawn', changes: { [helper]: exactReplace(read(helper),
      "  const mode = Object.hasOwn(viewModes, sessionId) ? viewModes[sessionId] : undefined\n  return mode === 'terminal' || mode === 'activity' ? mode : null",
      '  return viewModes[sessionId] ?? null') } },
    { name: 'input-loss-report-withdrawn', changes: { [agent]: exactReplace(read(agent),
      'if (desktopInputPreserved(input, input) && !desktopInputPreserved(input, captureDesktopInput(ports.get().tabs)))',
      'if (false)') } }
  ] })
