# Browser popup navigation scene

This scene covers website child windows under the [Browser behavior contract](../../../../../docs/design/behavior/browser-workface.md) and [Browser presentation contract](../../../../../docs/design/presentation/browser-workface.md). It does not replace the existing system HTTP(S) ingress or detached-workbench tests.

The fixture creates a real `BrowserViewManager` and opens the website's child through its original `window.open` handler. Electron supplies the guest and complete creation options; the production popup owner returns that original guest below its local navigation Renderer. The dedicated sandbox preload invokes the production, window-scoped navigation handlers. No Agent, Runtime connection or installed App is needed.

## Behavior proof

From the repository root:

```sh
node apps/desktop/scripts/verify-browser-popup-navigation.mjs
```

The normal run checks ten nonempty protocol and navigation cases, removes the real navigation dispatch in a private compiled bundle, requires the corresponding assertion failure, then restores the source bundle and checks all ten cases again. Each behavior process has a separate private HOME and a bounded lifetime. The receipt records consumed source and bundle hashes, original native guests, process exit and cleanup. `--baseline-only` and `--prepare-only` are development scopes rather than the complete proof.

Navigation checks compare the original page with the actual Main snapshot and navigation Renderer address, history buttons and loading control. An original-page navigation with no active address draft must also reach that Renderer. The receipt keeps page and chrome document visibility plus native window and view facts; a hidden visibility value alone is not treated as proof of a rendering failure.

Native keyboard events and Renderer composition events exercise their actual consumers; they do not certify physical keyboard, system clipboard or hardware IME use. The synthetic account-selection event uses the actual native Session and frame but does not select real credentials or test an authenticator.

## Independent window images

Use a separately prepared private Electron App when another running App has the same stock bundle identity:

```sh
node apps/desktop/scripts/verify-browser-popup-navigation.mjs --capture-handoff --capture-app '<private-app-executable>'
```

The executable override is accepted only for this capture scope; it never changes the stock-Electron behavior proof. The receipt records its actual executable path and hash. Producing or signing that private App is outside this fixture.

Capture mode prepares six original native children at their initial dimensions: normal, narrow and short, each in light and dark. Two original Browser hosts supply fixed themes. It does not reload or dynamically resize those children. The handoff lists each child's exact PID, native window ID, URL, title, page and shell IDs, visibility, native view bounds and membership, plus the actual Main snapshot and chrome DOM. `chromeReadyToShow` describes the local chrome only, not a confirmed remote-page frame. These static images do not certify repaint after navigation or resizing.

Read the printed receipt's output directory and its `capture-handoff/handoff.json`. Write a fresh selection to the handoff's command path:

```json
{"requestId":"select-narrow-dark","id":"narrow-dark"}
```

Wait for matching `applied` and `active`. Only the selected original window is shown and focused, with a temporary floating level to control this private test's visibility prerequisite. Confirm its exact private App, title and URL before capturing; never adopt a different same-bundle window. Creating the handoff's release file ends the scene early. Otherwise the static handoff ends at its original five-minute bound; selection does not renew it. The outer capture process separately allows up to one minute for preparation and ten seconds for cleanup. Ordinary behavior processes retain their one-minute bound.

For one bounded navigation observation on the already selected window, use `{"requestId":"navigate-normal-light","id":"normal-light","action":"navigate"}`. This uses native input to enter the fixture's second page. The chrome gets one frame-counter installation before input; each controlled HTTP document installs its own counter during parsing. The wait observes native URL/loading only and performs no Renderer eval. Each final synchronous sample first copies accrued RAF, visibility and DOM facts; a later `inspect` is labelled separately. The handoff then reuses those samples without rereading the documents while independent capture is pending. Missing counters remain unknown. This action checks no dynamic resize, and successful DOM synchronization still needs an actual composed image to establish visible repaint.

Keep complete original images and review them independently. A Renderer or `BrowserWindow.capturePage` result may exclude the native website and cannot stand in for a composed window. A failed system capture or an unreported lock state remains explicit. Read `behaviorPassed`, image availability and the independent visual review separately; captured pixels alone do not establish aesthetic approval or installed-App completion.
