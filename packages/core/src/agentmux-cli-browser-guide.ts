import { guideText } from './guide-text.js'
import { browserPageCapabilityNames } from './browser-page-capability.js'

const capabilityExamples = () => (['observe', 'act', 'wait'] as const)
  .flatMap(effect => browserPageCapabilityNames(effect).slice(0, 1)).map(name => `\`${name}\``).join(', ')

export const AGENTMUX_BROWSER_TARGET_GUIDE = guideText("actions/browser-targets")

export const AGENTMUX_BROWSER_TASK_GUIDE = guideText("actions/browser-task")

/** Original Browser program contract; command spelling follows the object surface. */
export const AGENTMUX_BROWSER_PROGRAM_GUIDE = guideText('actions/browser-run', {
  'browser-capability-examples': capabilityExamples(),
  'browser-capability-directory': (['observe', 'act', 'wait', 'navigate'] as const).map(effect =>
    `${effect}: ${browserPageCapabilityNames(effect).map(name => `\`${name}\``).join(', ')}`).join('\n')
})
