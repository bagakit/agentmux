import { captureQuickSwitch } from './capture-quick-switch-craft.mjs'

const renderer = 'apps/desktop/src/renderer/src/'
const pattern = 'packages/client-ui/src/patterns/agent-work-location'
await captureQuickSwitch({
  scene: 'agent-location-pattern',
  requiredSources: [
    'components/FocusContextRow.tsx', 'components/AgentInformationPreview.tsx', 'components/AgentInformationReader.tsx',
    'components/AgentLocationsButton.tsx', 'components/QuickSwitcher.tsx', 'components/WorkspaceWorkbench.tsx',
    'lib/desktop-focus-navigation.ts', 'lib/quick-switch.ts', 'store.ts'
  ].map(file => renderer + file).concat(pattern + '.tsx'),
  requiredStyles: [renderer + 'styles/overlays.css', pattern + '.css']
})
