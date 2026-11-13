# Profile environment editor

Contract: [Profile environment behavior](../../../../../docs/design/behavior/browser-workface.md#profile-管理环境与指纹编辑), [Browser Profiles presentation](../../../../../docs/design/presentation/settings-and-observation.md), and [independent visual review](../../../../../docs/guides/agent-visual-e2e-review.md).

From the repository root:

```sh
pnpm exec vitest run apps/desktop/test/browser-profile-fingerprint-editor.test.ts
node apps/desktop/scripts/verify-browser-profile-environment-editor.mjs --mutations
```

The private application builds the current real Browser Profiles settings pane and full original preload. The Renderer uses shipping API mode, the existing IPC result envelope, the trusted main-frame check, original Profile manager/store/native environment owner, and original Desktop user document owner. The normal public CLI reads and edits that same Profile through its original RPC server. The fixture supplies an empty site-data list and proxy-sign-in summary; these unrelated capabilities are not certified by this scene.

Use native input to edit all eight supported environment fields, including structured client hints and location. Check native keyboard order, persisted CLI readback, actual engine values, retained page input, delayed Save ACK with newer raw input, an external CLI configuration conflict, explicit engine-default restoration, and failed draft storage. Start a second actual process on the same private storage to recover the exact Profile/Browser identities, configuration and incomplete draft. The restarted test creates the retained Browser ID for this editor proof; it does not claim Browser page-process or Agent Run recovery.

`--mutations` replaces the production GUI time-zone submission with UTC in its private compilation. The actual CLI/native expectation must fail, followed by a restored compilation and real restart passing. No product source bytes are edited by this native mutation. Receipts pin source and executable identities and confirm ended private processes before removing only their temporary homes. Screenshots, compiled candidates, logs and receipts stay in `.local/browser-profile-editor/native/`.

Inspect the four complete PNGs independently: wide/dark and narrow/light with regional input; wide/light client hints; narrow/dark application scope. Judge actual hierarchy, controls, wrapping, contrast, keyboard focus and usable scrolling. Capture success is not visual approval. Parameter persistence is separate from native application; subdocument, Worker and first-script scope remain unknown, and the editor makes no complete-fingerprint or anti-detection claim.
