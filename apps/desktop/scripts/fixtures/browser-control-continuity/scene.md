# Browser control boundary continuity

The scene exercises the [Browser behavior](../../../../../docs/design/behavior/browser-workface.md#agent-操作可见性与输入隔离) and [Browser presentation](../../../../../docs/design/presentation/browser-workface.md) contracts through the real BrowserViewManager, script worker and CDP dispatch.

One private Browser operation waits, navigates through a held HTTP response, reaches a new document, replaces that document's root contents, then clicks once and completes. A second waiting operation ends through explicit takeover. The scene checks the exact original native input shield, its normal one-pixel rim, page bounds and Session, then confirms the exact shield is destroyed when each operation ends.

During the first wait, the scene hides the Browser, saves a disabled rim and a new color through the original ConfigOwner and ConfigStore, then returns to the same Browser and shield. The disabled native layer stays transparent; explicitly enabling the rim again retains the original operation and document.

The native layer PNGs contain the shield's own pixels. They verify four painted edges and a transparent center; they do not certify webpage halo blending across native surfaces, passive mirrors, composed OS-window aesthetics, physical input or installation. Finite original frame-subscription samples remain observations of that layer. A handful of static images does not claim that every compositor frame was captured.

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

Complete Renderer PNGs show waiting, navigation, script, observation, completion, human control and the layout/handoff cases. A private mutation disconnects BrowserPane's control prop from Stage; the actual mirrored boundary assertion must fail, then pass again after restoring the original compiled source. These images require independent visual review and do not certify a composed native or OS window.

Phase screenshots require the committed chrome cue, the actual video frame's private source-phase marker, then an original complete Renderer frame whose two marker pixels match. The marker verifies image freshness, never control authority. `--recapture-phases navigation,script,human` captures only those explicit phases and reports a scoped result; it does not repeat or certify the complete mutation matrix. The human phase retains the original operation and shows explicit human control, distinct from an empty idle history.
