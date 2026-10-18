# Browser control boundary continuity

The scene exercises the [Browser behavior](../../../../../docs/design/behavior/browser-workface.md#agent-操作可见性与输入隔离) and [Browser presentation](../../../../../docs/design/presentation/browser-workface.md) contracts through the real BrowserViewManager, script worker and CDP dispatch.

One private Browser operation waits, navigates through a held HTTP response, reaches a new document, replaces that document's root contents, then clicks once and completes. Completion, a following failure, a stopped program and the next program retain Agent ownership and the same native input shield. Only explicit takeover releases that shield, both while idle and while a program is running. Explicit return prepares a new shield without replaying the stopped program; a fresh program adds only its own new effect. Page identity, native Session and contents survive each transition.

During the first wait, the scene hides the Browser, saves a disabled rim and a new color through the original ConfigOwner and ConfigStore, then returns to the same Browser and shield. The disabled native layer stays transparent; explicitly enabling the rim again retains the original operation and document.

The `*-shield.png` images contain the exact shield's own pixels: four painted edges and a transparent center. The separate `*-page.png` images contain complete original page WebContents frames, including the real page-blended inner glow. Held navigation is checked through the independently available shield; source JavaScript and capture are deferred by that navigation, so no source image is claimed at that checkpoint. Neither image type includes the outer Renderer or a composed OS window. Native `sendInputEvent` receipts show mouse, wheel and keyboard delivery to the exact active shield, ordinary mouse delivery during completed/stopped gaps, and no source-page delivery; they do not certify OS coordinate routing or physical hardware input. Finite frame subscriptions and still images do not claim every compositor frame was captured.

Run from the repository root:

```sh
node apps/desktop/scripts/verify-browser-control-continuity.mjs
```

The verifier binds actual consumed source and bundle hashes, mutates only private compiled source and requires each changed behavior to fail its owning assertion. Each native process has a bounded lifetime and isolated HOME. Original receipts, logs and PNGs remain separate from private process data; cleanup requires confirmed exit and no remaining owner. `--baseline-only` and `--prepare-only` are diagnostic scopes, not the complete mutation proof. No user App, Agent, Runtime or clipboard is used.

## Shared Renderer reading

```sh
node apps/desktop/scripts/capture-browser-control-continuity.mjs
```

This separate scene mounts the real BrowserPane, stable secondary presentation, capture hook, video receivers, BrowserPresentationStage and operation chrome. The maintained typed API fixture supplies explicit operation/control/coverage facts; `getDisplayMedia` supplies one private canvas stream. It does not simulate a native control receipt or prove a live Agent operation. Both presentations consume that one media acquisition and actual video dimensions. SVG screen transforms must match the captured page's aspect fit, including narrow and short layouts. Exact coverage handoff removes only the covered presentation's mirrored rim and redundant receiver.

Complete Renderer PNGs show waiting, navigation, script, observation, completion, failure, stopped and explicit human control, plus layout and coverage cases. Completed, failed and stopped operations retain Agent control and the mirrored boundary. Real BrowserPane Take control and direct Return to Agent buttons exercise their callbacks through the maintained typed API seam, including the idle gap. Return is visible outside the disclosure and requires one button click. This proves the Renderer callback path; the fixture does not certify Main's trusted IPC authorization. Private mutations disconnect BrowserPane's control prop from Stage and reconnect Take control to public Stop; each must fail its owning assertion, then pass after restoring the exact original compiled source. Immutable hash-named media may be shared across private builds while every asset hash remains bound. These images require independent visual review and do not certify a composed native or OS window.

Phase screenshots require the committed chrome cue, the actual video frame's private source-phase marker, then an original complete Renderer frame whose two marker pixels match. The marker verifies image freshness, never control authority. `--ownership-scope` checks waiting, completion, failure, stopped and human ownership phases together with the existing layouts, coverage, Take/Return callbacks and both private mutations; it excludes the unchanged navigation/script/observation animation captures. `--return-control-scope` captures only human control at normal, narrow dark and short light sizes, checks the visible direct Return buttons and the existing active/idle Take→Return callbacks, and runs one baseline without repeating the earlier mutations. `--recapture-phases navigation,script,human` captures only those explicit phases and reports an image-only scoped result; it does not repeat the mutation matrix. The human phase retains the original operation and shows explicit human control, distinct from an empty idle history.

`--agent-preview-scope` checks only initial waiting and completed control after hiding and showing the original presentation. The typed API seam returns the actual `input-unconfirmed` / `agent-control-active` contract for Agent-owned input selection and records each refusal without accepting a new input lease. Both real video receivers remain readable from the same capture; the original Browser identity and completed control projection stay intact, and the real Pane exposes no false preview notice or Retry button. The secondary presentation remains visible during this bounded scenario. It does not exercise all-hidden capture retirement, Main/native input ownership, physical input, installation or the earlier mutation matrix.
