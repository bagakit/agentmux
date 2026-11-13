# Native ref-to-ref drag

Run `node apps/desktop/scripts/verify-browser-drag.mjs`; add `--mutations` for
production drop omission, unknown-as-unsent and CSS hover regression red/green.
The driver bundles current worktree Desktop sources and uses that worktree's
built Core and dependency graph, including the built public CLI. It creates private Electron storage, HTTP documents and
one exact Browser; no user App, Profile, Agent or Run is used.

The built public CLI traverses the original Renderer browser.run consumer,
BrowserViewManager, isolated script worker and page dispatcher. The HTML5 page
receives Chromium's original drag payload and trusted drop exactly once. A
separate pointer-capture slider in a closed ShadowRoot receives real trusted
native pointer/mouse movement and release; its original root witnesses the hit
before document-level retargeting. Concurrent pageInfo must not steal the drag's two replay identities.

Invalid refs never press. Replacing the original target with an identically
named node never drops on that node. Navigation during a pressed gesture keeps
machine effects unknown and sends no old release/drop into the new document.
That same Browser then accepts a fresh public click while CSS hover remains
empty, followed by human input after actual Take control. Pointer-capture
takeover likewise leaves the original Browser usable for a new human click.
These human actors use Electron sendInputEvent and assert trusted DOM effects;
physical hardware/WindowServer input is not asserted.

Native input fills the real BrowserTaskAssetEditor source/destination fields,
reviews the step, saves an immutable version via its production callback and
runs it through the original task owner. The built public CLI then edits that
draft, publishes version 2 and runs its native drop through the original Main
task control; both semantic endpoints survive the strict authoring parser and
version 1 stays unchanged. A third version declaring three retries receives an
unknown native effect and keeps exactly one operation and
one press. The task cursor does not move or replay that step.

Four current Renderer images cover dark/light at 390/310 CSS pixels, with the
original styles and theme sprite. They require an independent visual review;
PNG production is not visual approval. Receipts, input hashes, compiled bundle
hashes and images are under `.local/browser-drag/proof`.

This bounded fixture seeds one empty asset through the original task owner. It
certifies GUI and public edit/publish authoring, immutable version execution and
the page-program API. Public task creation has separate client contract verification.
Private Electron paths and Core runtime/state/session/message paths are explicit;
the original HOME environment is retained.
No JSON-RPC operation is added: page-program discovery and leaf help expose the
new runtime function through the existing browser.run owner.

The private process observer uses the existing full native Browser/CLI fixture’s
180-second budget (verify-browser-agent-input-isolation.mjs). Cold Core imports
and startup precede the page calls; each real page program retains its original
product deadline. Observer expiry is a failed observation, never a semantic RED.
