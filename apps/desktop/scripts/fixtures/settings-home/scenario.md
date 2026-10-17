# Settings Home and navigation review

The source contract is [Settings information architecture](../../../../../docs/design/behavior/settings-and-observation.md#设置页的信息架构) and [Overview, brand and composition](../../../../../docs/design/presentation/settings-and-observation.md#overview品牌与阅读构图).

Run `node apps/desktop/scripts/verify-settings-home.mjs`. `--visual-only` captures a changed visual candidate without repeating completed behavioral mutation tests.

The fixture mounts the production App, SettingsPanel, module catalog, editors and CSS over the existing public Preview API in an isolated Electron profile. Setup provides valid controlled directories and three authored Prompt samples through the original configuration API, then selects an existing matching Preview Agent through the original Store. The actual Settings button, sidebar, compact picker, search, editor and Avatar action are then operated through trusted Electron input. Config saves and original work-surface references remain observable. The fixture does not use a real user Session or claim Runtime, persistence, external-service or installation qualification.

The capture covers the Home in wide, short, compact and narrow windows in both themes; real search with a retained draft; every page in the production catalog in both themes; continued reading of overflowing pages; compact versions of the complex configuration pages; and the exact Executor entry from the original Avatar. No hand-maintained page list establishes completeness.

The runner falsifies the actual owning source for the ordinary App entry, retained editor lifetime, exact-object route forwarding and Home destination callback, then restores the same source. `--navigation-mutation` removes the local selection-surface rebind and must fail the actual Electron geometry check after a group disclosure changes. A load failure or timeout is not a passing mutation result. The generated receipt records the loaded source identity, product callers and native interaction boundary. Screenshots are evidence for an independent reviewer; successful capture does not claim aesthetic approval.
