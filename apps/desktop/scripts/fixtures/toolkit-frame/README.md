# Toolkit frame presentation probe

This probe consumes the production Result, Popover, WindowUtilityBar and compact
TUI components with the production style cascade. It checks the shared framing
contract in [Toolkit presentation](../../../../../docs/design/presentation/settings-and-observation.md#toolkit-的入口结果与配置).

Use one private Electron window at a time. The configuration, results and API
replies are controlled inputs; callbacks are recorded rather than executing a
script. The App status-bar markup follows the App's inline footer and consumes
its actual CSS. This is a selected-component qualification, not a full App,
semantic Host, running terminal, persistence, Browser overlap or installation test.

The Native scenario preserves an original draft while hovering, opens the real
popover, and compares each footer's border-box height with that window's status
bar. It opens long action labels, checks every menu item's actual hit target and
the More anchor, invokes the original callback, then exercises the two Escape
owners. It also visits an unconfirmed original request, Performance and its
source reader, Phone connection, idle TUI and compact TUI. Dark and light frames
include the entire window so density can be judged in context.

The capture entry point is `captureFrame` in [capture.mjs](capture.mjs). From the
repository root, with the destination prepared and any previous evidence
preserved, a baseline can be produced with:

```sh
node --input-type=module -e '
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { captureFrame } from "./apps/desktop/scripts/fixtures/toolkit-frame/capture.mjs";
const root = process.cwd();
const evidence = resolve(root, ".local/toolkit-frame/baseline");
await mkdir(evidence, { recursive: true });
await captureFrame({ root, evidence });
'
```

Use separate `height`, `wrap` and `action` destinations with the matching
`mutation` argument to exercise the actual loaded production CSS or callback
wiring. Their expected result is a specific behavioral assertion failure;
compile, setup and process failures do not count as killed mutants. The receipts
retain source and compiled hashes, actual input, geometry, images and cleanup.

The focused component suite uses `apps/desktop/test/toolkit-frame.config.mts`.
The final consumer is `node apps/desktop/scripts/verify-toolkit-frame.mjs`; it
checks current capture and component evidence together with the independent code
and image reviews. It does not launch another Native window or turn capture
success into aesthetic approval. Review every final full PNG according to the
[independent visual review guide](../../../../../docs/guides/agent-visual-e2e-review.md).

For a correction limited to Phone connection, call the same capture with
`scope: "phone-only"` and a fresh evidence directory. It captures only the
actual Phone Toolkit popover at 320/640 widths in both themes, after the
original QR is current and its finite reveal finishes. Original Copy and
Survey use the same controlled display URL; the Survey port records an
unconfirmed request without creating a user Browser. The named Phone settings
control records its original `mobile` target. Controlled online-device facts
and full images need independent review; this proves no live Host or OS
clipboard result and does not rerun unrelated Toolkit frame mutants.

## TUI pending launch

```sh
node apps/desktop/scripts/capture-toolkit-pending-launch.mjs --evidence "$PWD/.local/toolkit-pending-launch/gui"
node apps/desktop/scripts/capture-toolkit-pending-launch.mjs --evidence "$PWD/.local/toolkit-pending-launch/gui-mutation" --mutation stop-options
node apps/desktop/scripts/capture-toolkit-pending-launch.mjs --evidence "$PWD/.local/toolkit-pending-launch/gui-release-mutation" --mutation release-options
```

The [TUI Toolkit recovery contract](../../../../../docs/design/behavior/settings-and-observation.md#tui-toolkit)
is exercised through the real status-bar popover, production TUI Result, preload,
and Toolkit Main IPC. An isolated in-memory port supplies a dispatched launch
without a terminal. It rejects the first end request. The second one reaches
the owner but the retirement remains unconfirmed until the user checks again.
The port validates both stop requests against the original execution.
Trusted Chromium pointer events open, check, and end the launch. The receipt
checks action hit targets and confirms that opening, checking, ending and
reopening the popover never call run, action, or evaluate. The saved command
becomes available after confirmed retirement and the original draft is checked
on reopening.

The legacy scenario starts from a launch whose terminal and exact retirement
cannot be confirmed, with an older successful result. Its original launch stays
unknown after allowing a new one. Only a separate trusted click calls run, and
the call uses the released launch as its baseline rather than the older result.

The ten whole-window PNGs include wide dark and narrow light pending and ended
states, both unconfirmed retirement states, the original failure details
expanded by a trusted click, the legacy fallback, and the result after allowing
a new launch. The fixture starts no Runtime and the port only
projects a pending DTO for the single explicit run. Each negative case compiles
a preload that omits either all stop options or the legacy release option and
requires the corresponding exact IPC argument assertion to fail. Core
retirement and durable recovery require separate verification.
