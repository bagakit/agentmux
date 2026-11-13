# Browser pointer above native page layers

This private native scenario consumes the current `BrowserViewManager`, actual snapshot refs, the production action dispatcher and `BrowserOperationFeedback`. It opens a synthetic loopback page with an HTML modal dialog or a manual popover, hovers its real button and captures the original WebContents native image. Both target identity and pixels near its measured arrow are recorded. The page layer and DOM/native focus must remain unchanged.

Run from the repository root:

```sh
node apps/desktop/scripts/verify-browser-pointer-top-layer.mjs
```

The same two scenes run after a private compile transform removes the production cue's top-layer promotion. Those real actions must still complete, while the same arrow pixel assertion fails. The shared worktree is never changed for mutation. Evidence stays under `.tmp/browser-pointer-top-layer/` with source hashes, native receipts and full PNGs. The fixture's user data and process group are private and are removed after confirmed exit.

The command captures only: an independent Agent must open the full PNGs for aesthetic review. A captured WebContents image does not certify final OS composition, physical input, installed Desktop, passive mirrors or Core Session recovery. Normal-page/main-frame/iframe observations from the initial diagnostic remain separate evidence; this targeted scenario proves the native page-layer regression only. It does not reproduce the user's original page or claim every missing pointer has this cause.
