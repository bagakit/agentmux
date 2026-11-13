# Screenshot startup comparison

The complete Task gate is `node apps/desktop/scripts/verify-capture-startup.mjs --mutations`.
`--mutations --unit-only` is a development check for the six exact production mutations;
its receipt explicitly keeps `passed:false` and cannot sign off the complete Task.

Before the complete gate, the execution owner writes the local, untracked
`.local/state/capture-startup/baseline.json` with `{ref,sourceHash,source}` for the accepted
pre-optimization CaptureSurface. The tool checks the hash and `git show ref:<source>`;
a moving branch, invented source, identical source or a stale baseline file fails.
Only this Main source is substituted by esbuild. Both candidates use the same current
production preload, screenshot Renderer, shared annotation editor and image decoder.

The six unit mutants remove window/native overlap, skip current-input readiness, strand
an early load on cancel, drop diagnostics, close a healthy screenshot on diagnostic failure,
and reorder the actual production IPC diagnostic writer. The loader records exact original
and consumed source hashes. Nonempty owning AssertionRED is required; collection, transform,
process timeout and external termination are infrastructure failures.

Four independent Electron processes compare baseline/candidate with one/two virtual displays.
Each process has fresh temporary userData; the one/two-display orders are counterbalanced.
Each process invokes production `present()` twice: its first and repeat capture. A real visible
host begins at 65% opacity. Each actual Native-port invocation constructs a new solid PNG with
a per-capture nonce using `nativeImage.createFromBitmap/toPNG`, then waits an actual 200 ms.
The included exposure must see 65%; the excluded exposure must see 0. No clocks are mocked.

`browser-window-created` records actual shell construction relative to the capture trigger.
The baseline must build after the last Native return; every candidate shell must be built
before the first Native return. Independent native window `show` events measure actual showing;
the logged phase is bounded by actual Native return/fresh-DOM observation and cannot
fabricate the independently measured median gain. The older source logs just before showing;
the candidate logs after showing, and the offset from actual show events is retained. Shown overlays must reference this capture's exact PNG in
the real DOM, have a decoded image and canvas, and report numeric `presentedMs` for every
display. Real CDP Escape and exact preload cancellation separately restore opacity and
release the current shells. The candidate writes its latest small timing JSON after showing;
its fields cannot carry screenshot data, arbitrary text, paths or a draft body.

Receipts keep input/source hashes, source nonce hashes, measured phases, four matched
first/repeat single/multi-display comparisons, and machine load/memory conditions. Both
median shown time and measured Renderer tail must improve. There is no fixed latency target
and no claim that controlled Native delay proves actual OS capture speed. No actual screen,
clipboard, user draft, TCC/permission, physical display, package or installation is exercised.
Temporary app/bundles/userData are removed; evidence stays under `.local/capture-startup/`.
