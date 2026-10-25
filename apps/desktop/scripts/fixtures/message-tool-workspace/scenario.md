# Message workspace production Renderer scene

```sh
pnpm exec vitest run --config apps/desktop/scripts/fixtures/message-tool-workspace/vitest.config.mts apps/desktop/test/message-tool-workspace.test.tsx
node apps/desktop/scripts/verify-message-tool-workspace.mjs --mutations
node apps/desktop/scripts/verify-message-tool-workspace.mjs
node apps/desktop/scripts/verify-message-tool-workspace.mjs --empty-mutation
```

The behavior contract is [Message Tools mailbox](../../../../../docs/design/behavior/conversation-input.md#message-tools-邮箱); visual hierarchy is owned by [the presentation contract](../../../../../docs/design/presentation/conversation-input.md#message-tools-邮箱).

The mounted tests consume the production `AgentSessionComposer → SessionMailbox` chain, its original history and journal hooks, shared records and queue store. The private transform removes one actual consumer at a time: journal query, either refresh reader, journal detail, retained earlier history, original journal edit selection, Automation form retention, reading selection or unfiltered queue adjacency. The unchanged candidate and restored input must pass; an assertion must reject each mutation. Suite discovery and executed tests must be nonempty. No shared product source or compiled package is rewritten.

The isolated Electron scene imports the existing preview Workbench and uses `WorkspaceWorkbench → SessionPane → AgentSessionComposer → SessionMailbox` with the product styles. Only original Desktop API ports supply bounded fixture records. It operates real Chromium pointer and keyboard input at 640, 380 and 320 Region widths in both themes, plus a short surface. The scene searches and clears Inputs, refreshes both readers, copies a complete journal record, returns from Automation to the same detail and reads the original A2A MID with bounded earlier paging. It visits Sent, Collaboration and Notices, edits and cancels a queued draft, retains an unsaved Automation interval, then closes with Escape. It verifies the original editor, draft, pending identities, terminal instance and geometry remain intact; no dispatch or Automation action is allowed.

The pointer checks read the actual computed styles and hit targets: a resting pending row keeps its Send footer visible and actionable, while a plain registered journal row keeps its time visible on hover. They do not dispatch the pending input.

The bounded `--empty-mutation` mode first changes only the imported owner stylesheet's empty-state padding in private PostCSS compilation. The actual Notices view must fail `EMPTY_STATE_HEIGHT` at the inflated height; compilation or unrelated failures cannot count. It then restores the unchanged source and captures Notices without a hint and Collaboration with its original necessary hint at 320, 380 and 440 Region widths in both themes. The original collaboration API returns an exact-participant empty page, and the private Session has no capability diagnostic. Assertions cover the 26px plain row, unchanged 12px title, complete natural hint wrapping, Automation return, Escape and original editor, draft, queue and terminal preservation. `--empty-states` runs only this restored six-scene capture when a separate visual check is needed.

The script prints a private receipt directory. `compilation.json` records the actual imported source and style hashes; `render.json` records runtime identity, nonempty operations and screenshot hashes. `review.md` links the complete images for an independent visual review. Capture and geometry success do not certify aesthetic quality. These controlled Renderer scenes do not certify a live Host, native CLI delivery, installed application or durable Session recovery, and never operate user Sessions.

The bounded Automation workface can be captured independently:

```sh
node apps/desktop/scripts/verify-message-tool-workspace.mjs --automation
```

It opens the original Mailbox and Automation entry in the same production workbench with a controlled paused continuous-progress loop and a minute-based schedule. At light 640, dark 320 and a short dark 320 Region it captures the unified list, hit-tests the original paused-loop control without activating it, fills a minute-form draft and hit-tests its Save without submitting. Back, reopening and Escape retain the same form nodes, unsent automation and manual drafts, pending input order, terminal instance and geometry. The original schedule and progress API ports are private fixture data; no live user Session or automatic operation is touched. The resulting twelve complete screenshots require independent visual review. Static screenshots do not prove animation behavior, a live Host, native input or delivery.

The explicit notification slice is exercised with:

```sh
node apps/desktop/scripts/verify-a2a-manual-notify.mjs
node apps/desktop/scripts/verify-message-tool-workspace.mjs --manual-notify
```

The first command runs the unchanged mounted Renderer and registered preload/IPC/Main → actual Core journal path, then kills four original Renderer mutations and four Main/IPC mutations. Each nonempty suite and actual imported source mutation is recorded. It covers exact Host/MID/recipient Session and frozen notification Run, trusted sender, distinct explicit operation IDs, same-operation read-only inspection, and rejection of an unrelated producer's ACK. The Core bridge deliberately has an unavailable Runtime and certifies retained unknown/failed observation, not a live CLI delivery.

`--manual-notify` uses the existing private production Renderer at dark 380/320 and light 640 Region widths. It clicks Notify now on one retained reference message, captures its unconfirmed receipt, opens the same MID, clicks Refresh receipt and captures the submitted receipt. Fixture notification/inspection ports assert the original IDs; one explicit notification and one read-only inspection are recorded. Original editor, draft, queued messages and terminal remain intact. These controlled ports do not send to user Agents, and a submitted notification never certifies original-body reading or task acceptance. The nine full screenshots and compilation identity are listed in the generated review.md for independent review.

The related interaction recovery slice uses:

```sh
node apps/desktop/scripts/verify-a2a-manual-notify.mjs --recovery
node apps/desktop/scripts/verify-message-tool-workspace.mjs --notification-recovery
```

The recovery gate consumes the same production Composer, persisted workbench intent owner, original message event reader and input inspection ports. It covers remount/restore without replay, independent repeated notifications with retained older operations, shared in-flight state, confirmed results before a lost response returns, preclaim refusal without an input record, exact source and frozen earlier paging, Sent recipient naming, and delayed A2A body insertion at the original mapped caret. Its five source mutations break persistent intent selection, retained operation history, confirmed waiting-state settlement, original event refusal consumption and caret capture timing. Each must cause an active assertion failure before restored GREEN.

The private Electron recovery mode operates dark 380, dark short 320 and light 640 Regions. It closes and reopens the mailbox with Escape/Enter, retains an uncertain original action, explicitly creates a second notification, opens older operation details, uses actual Tab/Enter to inspect the first receipt without sending again, and reads Sent details with an accurate recipient label. Fifteen complete screenshots cover list, unknown, retained history, checked receipt and Sent. The light 640 scene also reloads the actual Renderer and restores the original persisted request identities without notification replay. Draft, queue, editor and terminal preservation is checked before that deliberate Renderer reload; this fixture does not claim a live Agent or full application process recovery.

The persistent-recipient notification slice uses:

```sh
node apps/desktop/scripts/verify-a2a-manual-notify.mjs --resumed
node apps/desktop/scripts/verify-message-tool-workspace.mjs --notification-resumed
```

The gate covers a historical message Run A, a new notice bound to Run B, and inspection of that same notice after the Session moves to C. The production hook retains the original operation instead of guessing its input key from A. The trusted preload/IPC/Main bridge consumes Core's producer-qualified read-only `inspectMessageNotification`; wrong Host, MID and ordinary-input receipts remain rejected. Eight source mutations break historical-Run separation, frozen-key correlation, original-operation lookup, read-only recovery, visible failure reasons and trusted bridge routing. All mounted cases actively execute in candidate, mutation and restored runs.

The private Renderer mode operates dark 380/320 and light 640 Regions. It loses the first notification response, checks the original operation to recover its B receipt, and displays the historical message Run separately from the notification input Run. The light scene reloads the Renderer before that query to prove retained request identity. A second explicit action has no retained notice in the controlled read: the visible reason preserves its unknown outcome and no input is replayed. Nine complete screenshots cover lost response, confirmed receipt and missing notice. Draft, reading and terminal preservation apply before the deliberate reload. These ports do not establish actual Core recovery or delivery; the separate Core Runtime probe owns that evidence. The [A2A behavior contract](../../../../../docs/design/behavior/a2a-collaboration.md) owns persistent-recipient and original-notice semantics.
