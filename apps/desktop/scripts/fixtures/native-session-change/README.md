# Native target selection: private product scene

This scene exercises the existing Agent Region menu against the actual Desktop/Core call chain. The owning behavior is [same-Run native sessions](../../../../../docs/design/behavior/agent-capabilities-and-messaging.md#同一-run-内的原生会话切换); presentation follows [in-place native source information](../../../../../docs/design/presentation/agent-capabilities-and-messaging.md#原生会话变化的就地提示). Independent visual judgment follows the [visual review guide](../../../../../docs/guides/agent-visual-e2e-review.md).

## Execution

From the repository root, use a task-owned evidence directory:

```sh
node apps/desktop/scripts/verify-native-session-change.mjs <evidence-directory> --controls-only
node apps/desktop/scripts/verify-native-session-change.mjs <evidence-directory>
```

The first command runs the mounted menu/projection/forwarding tests and two source mutations: replacing the chosen candidate with the retained target, and disconnecting confirmation. It records nonempty business assertions and actual implementation hashes. The second reuses those controls only when source and test hashes still match, compiles the current product once, and starts two private Electron processes sequentially. Without an existing controls receipt it runs those controls first. It does not package or install the app.

The capture uses one private semantic owner and one original Run. Only the Electron client restarts; it reconnects to the same Run and original target. All test-created processes and runtime directories are cleaned up; evidence is retained. Run this bounded scene after its product source settles, separately from other expensive builds.

## Actual operations and pictures

The Renderer is the current `App → SessionPane → AgentRegionHeader → AgentNativeSourceControls`, with product CSS and theme runtime. CDP mouse/keyboard input operates **More → Session details**, then the original candidate and confirmation menu items. No replacement menu is rendered by this fixture.

At both 1280 and 760 viewport widths, in Graphite dark and light appearances, capture full-frame PNGs for:

| Scene | Operation and observation |
| --- | --- |
| `unknown` | The private native actor holds no main record; explicitly recheck and inspect the source service window. The original terminal still accepts raw input. |
| `candidates` | The same actor holds both A and B. Inspect the two exact choices and the frontend-selection limitation. |
| `review` | Choose B, inspect From/To and the action consequences, then cancel. Cancellation must send no confirmation. |
| `selected-b` | Choose and confirm B through Core. Inspect the selected marker and the separate terminal-selection explanation. |
| `selected-a` | Explicitly choose the retained A again. The original Region, terminal node, draft, Session, Run and PID remain. Finally select B for restoration. |
| `selected-restored` | Start an independent Electron process with the same private profile. The selected B, confirmation receipt, original workface and Run/PID survive; no new Session is launched. |

The long B identity exercises wrapping in the actual details submenu. Geometry checks ensure the submenu remains within the viewport; they are behavior checks, not an aesthetic score. The receipt records theme, viewport, original terminal identity, confirmation calls, raw-input ACK and each screenshot. `review.md` links the complete pictures. `aestheticReview: not-performed` remains until an independent Agent actually opens and assesses them.

## Evidence boundary

The chain is real product Renderer/API → private IPC bridge → production RuntimeController → production Hosted connector/public RPC → actual Core/File and Spatial stores → private ctxmux Run and writable OS file descriptors. The private bridge does not boot the unrelated full product IPC registrar. Existing mounted tests check the exact Main forwarding boundary.

`native-cli.mjs` is an explicit protocol fixture, not a stock Codex binary. It holds actual writable transcript files and supplies controlled native records and read responses. It does not claim to report the TUI's current selection, authenticate upstream, execute model work, or verify upstream `/new`/`resume`/`fork` navigation. The separate T002 stock-native proof establishes the unchanged Provider provenance behavior. The UI continues to state that terminal selection is not reported.

Managed configuration installation and history-watch subscription are isolated at their existing seams. The user App, user profile, native credentials and user Sessions are not opened. Raw input goes only to the fixture's original private echo Run; the unsent draft is preserved. This scene does not rerun the old full historical-reader, lost-ACK or multi-Provider lifecycle matrices, and it does not replace installed-app or stock-native acceptance.
