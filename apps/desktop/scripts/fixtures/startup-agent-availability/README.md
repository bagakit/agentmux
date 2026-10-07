# Startup Agent availability product proof

Run from the repository root:

```sh
node apps/desktop/scripts/verify-startup-agent-availability-product.mjs
```

This finite fixture mounts the complete production `App` and its styles in private Electron windows. The App runs the production `useAppStore.initialize`, startup stage, General settings, and Workbench. The fixture does not replace those components or their algorithms.

Four independent Electron processes share one temporary root:

1. `control` confirms the effective unchecked default, enters the workspace through the real Continue button, and uses production store actions to create a Tab with two Regions and two unsent drafts. `prepareRendererUpdate` saves the state through the existing persistence owners.
2. `failure-restart` reads the original files and settles two original Executor requests through distinct failure shapes: an exact-input `check-failed` result and a rejected API request. The completed startup automatically yields to the original workface. Real pointer input opens System notifications and its Details, observes the original codes/messages, and triggers `Check Agents again`. The same Host/Executor inputs are checked; the cause stays visible while the retry is pending, and clears only after successful results. A complete normal-width screenshot records the actual notification and original workface.
3. `restart` starts with the original Core spatial file, Chromium localStorage, and configuration file. It does not recreate the workface. During unresolved Agent checks it captures the startup screen, clicks Continue, and compares the original Tab, Regions, layouts, focus, and drafts. It opens General, captures the unchecked setting, then changes and saves it through the production form and configuration owners.
4. `skip-restart` reads that saved preference and the same original workface. It verifies that the App is visible while Agent checks remain unresolved, then completes the checks.

The production `ConfigStore.save` / `ConfigOwner` and Core `AgentMuxSpatialStateStore` own the private files. Configuration reload reads the original JSON through `ConfigStore.validate`; it deliberately does not invoke unrelated Notes/Scratch bootstrap in `ConfigStore.get`. Chromium retains and flushes the real localStorage. IPC transport registration is private to the fixture.

Executor detection promises, their matching protocol results, and the empty Runtime snapshot are controlled API inputs. This proves the Desktop startup and persistence path, not real executable discovery, native Session recovery, or Runtime health. No user App, Agent process, or Runtime is accessed.

The capture receipt binds the consumed source/CSS, dependency metadata, compiled artifacts, process receipts, and complete normal/narrow screenshots. It reports source drift and private process cleanup. Capturing images does not constitute the independent visual review.
