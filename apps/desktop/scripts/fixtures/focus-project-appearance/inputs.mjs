const renderer = 'apps/desktop/src/renderer/src/'
export const productInputs = ['components/FocusZoneFooter.tsx', 'components/settings/FocusSettingsPreview.tsx', 'components/FocusSearchLocations.tsx', 'components/LocalRetainedInputs.tsx', 'styles/focus.css', 'components/FocusProjectLanes.tsx', 'components/FocusProjectPreferences.tsx', 'components/ProjectIcon.tsx',
  'components/GlobalFocusSurface.tsx', 'components/FocusContextCards.tsx', 'components/FocusScanLaneContent.tsx',
  'styles/focus-context.css', 'lib/use-focus-project-order.ts', 'lib/focus-project-lanes.ts', 'lib/focus-preferences.ts'].map(file => renderer + file)
productInputs.push('apps/desktop/src/main/project-appearance.ts', 'apps/desktop/src/main/project-icon-image.ts', 'apps/host/src/object-avatar-files.ts', 'apps/desktop/src/shared/focus-project-preferences.ts')
export const captureInputs = ['apps/desktop/scripts/capture-focus-project-appearance.mjs',
  ...['entry.mjs','main.cjs','reading-scene.cjs','organization-scene.cjs','inputs.mjs'].map(file => 'apps/desktop/scripts/fixtures/focus-project-appearance/' + file),
  'apps/desktop/scripts/fixtures/focus-composable-filters/entry.mjs', 'apps/desktop/resources/icon.png']
