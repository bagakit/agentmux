import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

// Actual reducer and AST-extracted Store glue; set is a synchronous double.
// This proves projection identity scope, not GUI scheduling, Core health or asymptotic scanning cost.
await verifyRendererSourceMutations({
  "name": "browser-state-related-updates-source-mutations",
  "tests": [
    "apps/desktop/test/browser-state-related-updates.test.ts",
    "apps/desktop/test/renderer-state-owners.test.ts"
  ],
  "sources": [
    "apps/desktop/src/renderer/src/lib/browser-state.ts",
    "apps/desktop/src/renderer/src/store.ts",
    "apps/desktop/src/renderer/src/lib/workbench-tabs.ts",
    "apps/desktop/src/renderer/src/lib/display-name.ts",
    "apps/desktop/src/shared/contracts.ts",
    "apps/desktop/src/shared/scratch-topics.ts",
    "packages/layout/src/workbench-layout.ts",
    "packages/layout/src/workbench-view-layout.ts",
    "packages/layout/src/split-tree.ts",
    "packages/layout/src/split-direction.ts",
    "apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs",
    "apps/desktop/scripts/verify-browser-state-related-updates-mutations.mjs"
  ],
  "mutations": [
    {
      "label": "updated-whole-block-reverted-to-global-reconstruction",
      "file": "apps/desktop/src/renderer/src/lib/browser-state.ts",
      "before": "  if (event.type === 'updated') {\n    let tabs = state.tabs\n    for (const [tabId, tab] of Object.entries(state.tabs)) {\n      let regions = tab.regions\n      for (const surface of Object.values(tab.regions)) {\n        if (surface.kind !== 'browser' || surface.browserId !== event.browser.id) continue\n        if (Object.entries(event.browser).every(([key, value]) => Object.is(surface[key as keyof BrowserWorkbenchSurface], value))) continue\n        if (regions === tab.regions) regions = { ...regions }\n        regions[surface.regionId] = { ...surface, ...event.browser, regionId: surface.regionId }\n      }\n      if (regions === tab.regions) continue\n      if (tabs === state.tabs) tabs = { ...tabs }\n      tabs[tabId] = { ...tab, regions }\n    }\n    return tabs === state.tabs ? state : { ...state, tabs }\n  }\n",
      "after": "  if (event.type === 'updated') {\n    return {\n      ...state,\n      tabs: Object.fromEntries(Object.entries(state.tabs).map(([id, tab]) => [\n        id,\n        {\n          ...tab,\n          regions: Object.fromEntries(Object.entries(tab.regions).map(([regionId, surface]) => [\n            regionId,\n            surface.kind === 'browser' && surface.browserId === event.browser.id\n              ? { ...surface, ...event.browser, regionId: surface.regionId }\n              : surface\n          ]))\n        }\n      ]))\n    }\n  }\n"
    }
  ]
})
