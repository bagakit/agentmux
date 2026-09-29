# Mote presentation — bounded actual Renderer capture

Run `node apps/desktop/scripts/verify-mote-navigation-footer.mjs` only after the
product candidate is coherent. It performs one private Vite Renderer compile
and one private Electron process, with eight targeted Renderer frames. It does
not run a Core/desktop build, package, installation, user App restart, OS capture
or the old complete-App/two-process proof.

The original App, Settings, SurfaceSwitch, Mote Entry/Panel, Workbench, Composer,
native-overlay collector and full style dependency graph are imported. No
component or stylesheet is replaced. The existing WEB_PREVIEW API and typed
`test/fixtures/mote-workface` data provide controlled external facts. Ordinary
Agent statuses use a fresh controlled observation time; an empty typed controlled
history page leaves the seeded captured timeline as the displayed input source.
store initialization is a typed no-op with controlled `loading: false` (it does
not prove ordinary startup/recovery); warm/send/launch/stop/input sinks record
side effects and cannot start or consume a real Run. This proves Renderer
presentation and explicit DOM input ownership, not SDK/attachment/Core/ctxmux
Run survival, native Browser composition or OS IME.

The fixture exposes an optional typed `window.moteFooterNative` bridge before
App mounts. A separately owned private Main/preload may connect original UI
methods there and consume the same archived Renderer bytes for its native-only
supplement. This Renderer receipt never takes credit for that supplement.

Planned frames: wide closed/footer; wide hover/card rail; wide avatar rail; light
edge/card rail; narrow long-name/card rail; narrow avatar/custom original draft;
Settings hover/bridge/explicit original input; Settings retained/keyboard focus.
The narrow avatar frame shows the production long-name identity/state hint:
actual pointer hover first, then the original button's DOM focus handler after
the pointer hint closes. This does not claim physical keyboard tab-order proof.
Toggle selection is bound to the actual coherent product control before the
first capture, not a fixture-owned mode switch. Pointer/key input uses Chromium
DevTools; it is trusted browser input, not physical hardware or OS IME.

Original text bytes consumed by Vite and archived beside the compiled Renderer,
PostCSS original Input.css for every local stylesheet,
Vite's nonempty watched style dependency set, compiled files, actual geometry,
event logs, frame SHA-256 and cleanup are recorded. Source drift yields an
honest failed receipt. Generated Renderer bytes are retained under the capture
evidence for candidate-bound native supplementation; the process/profile/temp
root must be gone. An independent Agent must actually open every frame.

For an explicitly approved CSS-only correction, use
`node apps/desktop/scripts/verify-mote-navigation-footer.mjs --reuse <parent-compiled-receipt.json> --recapture narrow --candidate <coherent-manifest.json>`.
This performs no Vite build: it verifies and copies the immutable complete parent
archive, replaces the uniquely matched whole original pmo CSS block with the
actual repaired source, and records PostCSS syntax/dependency checks. The seven
other product UI sources must be unchanged. Original compilation inputs and the
new capture drivers have separate provenance; only two narrow images are new,
although the original interaction/assertion sequence still runs. The six old
wide/Settings images retain their previous candidate scope. No evaluate-time
style insertion, product component replacement or hand-painted frame is used.

An Entry TSX repair uses ordinary actual compilation instead of CSS derivation:
`node apps/desktop/scripts/verify-mote-navigation-footer.mjs --capture affected-entry --candidate <coherent-manifest.json>`.
It captures six new frames: closed footer, wide hover cards, both narrow rail
forms, Settings explicit input and the retained Settings/Entry keyboard focus.
All eight original interactions/assertions, including theme and avatar toggle,
remain. The old wide avatar and light images are retained only within their
original candidate scope; this run does not claim new light-theme screenshots.
Original Source/style consumption and compiled outputs have a fresh receipt;
no compiled JavaScript is manually replaced to represent new TSX Source.
# Footer count clearance supplement

`--capture footer-only --candidate <manifest.json>` compiles the actual App once and checks 320/420/560/980 widths with zero, one working, one attention and two three-digit counts. Controlled Session facts enter only through the original Store; actual FocusNavigationButton, CSS, number text Range, neighbors and right-side actions determine the result. Five complete frames show both themes at 320 and the other widths in dark.

The same archived compilation is copied privately; the two narrow Focus sizing declarations are removed from one unique complete agent.css block. Actual count containment must fail with AssertionError. The unchanged original compilation must then pass the same sixteen cases. No shared Source mutation or second compilation is used. This covers the existing low-footer contract in density SSOT, not Native/OS/IME/Core Run/restart or the earlier rail/Settings scenarios. All private outputs are cleaned after hashes and evidence are preserved.

# Floating resize and preference memory

`--capture floating-resize --candidate <manifest.json>` runs only the new resize
scope in the actual App. The formal task gate owns this one private compile and
bounded process. Five complete dark frames cover wide/narrow card and avatar
forms plus a real advisory storage failure. Trusted Chromium pointer input must
grab the actual corner, continue outside its box under capture, and commit on
release; keyboard input checks arrows and consumed Escape. Explicit DOM-dispatched
pointercancel and window blur exercise the original termination handlers; this
does not claim OS focus loss or physical touch input.

The original nonempty navigation, Tab actions and unsent Composer are measured
and hit-tested. Width/height bounds, viewport smaller than the ordinary minimum,
unchanged target/input token and protected work facts, no-op/X/Y/both-axis input,
gesture draft without storage writes, cancellation and cursor/selection cleanup
are asserted. A controlled Storage API failure leaves the real Panel operable
with its notice; the next explicit resize clears that notice after a successful
save. The localStorage seed runs only when absent. A private Renderer reload
must read back that same saved size and target from the real floating owner.

Every consumed Source/style and compiled byte is archived immutably. Current
task-owned producers (including the floating lib.ts) must match the candidate.
Whole-App end freshness is separately reported so unrelated concurrent Source
drift does not relabel immutable resize proof. Footer modes retain their prior
freshness semantics. Optional `--reuse-renderer` verifies every archived byte and
all actual task Renderer producers; it permits only a separately bound capture
driver correction, never a changed product Source under an old compilation.
