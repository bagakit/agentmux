# Screenshot startup comparison

The complete Task gate is `node apps/desktop/scripts/verify-capture-startup.mjs --mutations`.
`--mutations --unit-only` is a development check only; its receipt explicitly keeps
`passed:false` and cannot sign off the complete Task.

Before the complete gate, the execution owner writes the local, untracked
`.local/state/capture-startup/baseline.json` as `agentmux.capture-startup-baseline.v2`
with the exact pre-optimization Git `ref`. A moving branch, invented tree, identical
candidate or stale baseline fails. Baseline and candidate each build their own production
Main, shared contracts, preload, screenshot Renderer and annotation editor from their own
Git tree. The fixture driver may be shared, but every production input records its actual
consumed hash. Mixing an old Main with the current Renderer is not a complete A/B proof.

The production mutation suite removes window/native overlap, skips current-input readiness,
strands an early load on cancel, reorders background delivery, drops the final deferred
diagnostic, lets an old request overwrite a new one, and breaks the real shortcut chain.
The loader records exact original and consumed source hashes. Nonempty owning AssertionRED
is required; collection, transform, process timeout and external termination are
infrastructure failures.

For each initial background and virtual-display count, four independent baseline/candidate
process pairs run in an alternating order. Every process has fresh temporary userData and
invokes the real registered shortcut callback → GlobalScreenshot → ScreenCapture →
CaptureSurface path twice, providing the first/repeat cells. Thus every
first/repeat × one/two-display × included/excluded cell has four independent pairs and no
outlier removal. The candidate's actualShown median must improve by at least 100 ms and 15%
in every cell; a missing cell or a threshold miss fails without cross-cell averaging.

Each actual Native-port invocation constructs a new solid PNG with a per-capture nonce using
`nativeImage.createFromBitmap/toPNG`, then waits an actual 200 ms. Host opacity is never
changed by the candidate; baseline behavior is measured, not copied into the candidate.
No clocks are mocked. Controlled Native delay proves readiness and relative mechanics only,
never actual OS capture speed.

`browser-window-created` records actual shell construction relative to the capture trigger.
Hidden Renderer startup overlaps the selected exposure. Independent `BrowserWindow.isVisible()`
samples every 5 ms measure actual showing; native `show` event offsets remain separate because
macOS inactive panels may omit that event. Shown overlays must reference this capture's exact
PNG in the real DOM, have a decoded image and canvas, and report numeric `presentedMs` for every
display. Deferred background delivery exercises the real preload subscription boundary without
recapturing, changing the document or producing an output for a pending background.

The production IPC `recordTiming` sink owns the small diagnostic writes. The selected first
frame writes once after showing; completion of the deferred background writes exactly one final
record for that same request with final native timings. A late result cannot overwrite a newer
request. Fields cannot carry screenshot data, arbitrary text, paths or a draft body. Real CDP
Escape and exact preload cancellation release current shells without waiting for the deferred
producer; the Native lease still follows the real producer.

Receipts keep the baseline ref, both trees' consumed hashes, every cell's raw samples,
median/range, process order, and machine load/memory conditions. Temporary app/bundles/userData
are removed; evidence stays under `.local/capture-startup/`. Real OS performance has its own
integrated gate and thresholds; this controlled gate does not claim physical displays, TCC,
clipboard, user drafts, packages or installation.
