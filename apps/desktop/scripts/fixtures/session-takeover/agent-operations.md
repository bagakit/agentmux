# Stop and Fork feedback: exact-candidate native scene

Run from the repository root:

```sh
node apps/desktop/scripts/verify-session-takeover.mjs --native --agent-operations --evidence=.local/agent-card-operations/product
```

Prepare without executing an Electron candidate:

```sh
node apps/desktop/scripts/fixtures/session-takeover/native.mjs --agent-operations --preflight --evidence=.local/agent-card-operations/fixture-preflight
```

The latter only builds the actual current production Renderer and validates a nonempty production/style input set. It writes `preflight.json`, never a passed final-candidate receipt. The final gate must run after the integrated candidate has been pinned. Receipts from the former combined Takeover/Fork scene cannot certify this mode.

Default `verify-session-takeover.mjs --native` delegates the public Takeover flow to `fixtures/takeover-flow/capture.mjs::runTakeoverFlow`; its qualification is `public-takeover-renderer-recovery-v1`. This Stop/Fork fixture adds no Takeover creator. `--live-adoption` remains a separate fixture and qualification.

## Real consumers and controlled boundary

The fixture mounts actual `WorkspaceWorkbench`, `SessionPane`, xterm and shared product styles. Beside the original workface it mounts the original `createFocusProjectionSelector` → `FocusContextRow` consumers for three exact controlled Native sources. The fixture layout only places those production consumers; it does not copy a card, operation phase, dialog or controller. Native launch/stop/inspect, exact capability/nativeHandle facts and ordered bytes are controlled. Creation requests, their destination admission, spatial Core file owner, original production controllers, drafts, UI persistence, body and focus remain real. No vendor CLI/real ctxmux execution or user Session is claimed.

The first source remains healthy with ongoing ordered output. Its actual xterm receives native mouse-wheel and keyboard events during card feedback. Two other sources have separately confirmed Stops, then independently confirm retirement or lose their receipt. Fork uses the original context-menu item and destination button. It has a real created target with initial-input confirmation missing; the production spatial owner produces partial completion. Read-only buttons inspect original requests without additional launches or Stops.

## Candidate scenes

- Actual original cards, Run controls, unsent drafts and original workface before actions.
- The real PaneGroup Stop Run button and a separate original card-menu Stop confirmation immediately released while distinct original requests remain in flight.
- Real edge motion sampled over a complete measured animation cycle. Still frames do not certify subjective motion quality.
- Dark/light at actual native window sizes, and a narrow native window without DPR override.
- Reduced-motion media, hidden cards and offscreen cards pause their original shared animation consumer. Native getAnimations/currentTime/computed offsetDistance are sampled twice; zero actual running/moving edge work is the visibility oracle, not data-motion-active.
- Fixed visible sources with 0/384 unrelated retained Sessions. Three alternating samples record native Chromium style/Layout/Paint trace events, actual xterm input latency, mouse-wheel movement, stream continuity and visible card DOM mutation deltas. The comparison rejects work growing linearly with unrelated membership, using normalized repeated samples and observed noise, not an invented absolute latency threshold.
- Independent Stop completion and static unknown with a real inspect button.
- Fork in-flight/partial with real new Agent identity; its original request is the only creation request in this qualification.
- An ordinary second Electron process reads real profile/Core workface persistence, unresolved original operation references and drafts without reseeding; confirmed completion decorations stay omitted. Reconciliation uses actual buttons; no Stop/Start/input is replayed. Both Renderer and controlled Native surviving Host/Session/Run identities are compared before and after checks, and the separate Native input log must be empty on both sides. Attachment observation validates exact Host/Session/Run before choosing a known controlled representation; arbitrary attach errors never trigger a catch-all fallback.

The `stop-fork-feedback-v1` qualification requires the exact first-process and restart scenario sets defined by `agent-operations-main.cjs::assertStopForkScenarios`, plus measured cost/motion collections. It uses schema `agentmux.stop-fork-feedback-native.v1`; source negatives use qualification `stop-fork-feedback-mutation-v1`. Production sources, CSS, every fixture input, the Core spatial module inputs, compiled files and image hashes bind the same candidate. Cleanup remains the original isolated process/root owner. Independent visual review consumes the final generated frames; no reviewer is allowed to treat preflight or old prototype images as this product proof.

## Falsifiable isolation oracles

The shared source mutation driver may withdraw the real `FocusContextRow` feedback call: the same native scene must fail at nonempty short Stop labels/active edge feedback. For visibility isolation, change the actual `AgentOperationFeedback` motion predicate from `visible && decoration.phase === 'pending'` to `decoration.phase === 'pending'`: the same `offscreen` scene must turn red because native CSS animations still run/move. The native driver applies this supported mutation by an in-memory Vite transform and records original/loaded hashes. `verify-agent-operation-feedback.mjs --task=T-004` requires this exact native assertion failure (not compile/setup failure), then verifies restored zero work from the unchanged full candidate receipt. The negative first-process run uses its own evidence directory and cannot qualify as a normal two-process capture. Removing persisted original operation references must turn the ordinary second-process equality check red. These are production source mutations, not changed expected values or fabricated fixture phases. Removing CSS contain alone is not claimed to be a performance mutation: compositor equivalence is allowed. Normal 0/384 style/Layout/Paint/input samples remain real raw browser costs; the negative work-avoidance proof establishes visibility isolation, not a claimed Paint slowdown. A second supported read-only native mutation, `tooltip-reorders-host`, changes only WindowOverlayHost's tooltip exclusion to reordering. Its first-process evidence must have an exact Right hit, a trusted Right pointerdown and click, and an intervening native window-overlay-host beforetoggle from open to closed; the original Fork submission must still succeed. Only the original native assertion `Opening its tooltip preserves the shown host through the native pointer sequence` at the Fork pointer stage qualifies. This proves unnecessary host churn during activation; it does not claim the churn necessarily cancels the click or submission. Restored GREEN must preserve the shown host through the same trusted pointer sequence while still submitting. Compile failures, missing entries and watchdog/deadline failures do not qualify. The mutation runner records both native RED results and a single unchanged full-candidate restored GREEN with exact source consumption.

## Qualification limits

This fixture proves actual browser rendering and production client/control/spatial consumption against a declared controlled Native boundary. It does not replace the separate Core/public RPC/compiled CLI proof, packed Native tests or subjective dynamic review. No product approval, package or installation follows merely from a passed capture.
