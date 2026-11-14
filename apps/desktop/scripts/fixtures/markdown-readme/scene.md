# README File Preview scene

Real Workbench File Preview of the root `README.md` and `README.zh-CN.md`, for the independent image
review required by [Agent visual review](../../../../../docs/guides/agent-visual-e2e-review.md).

- **Current constraints:** [Markdown 的 HTML 子集与提示块](../../../../../docs/design/behavior/files-and-git.md#markdown-的-html-子集与提示块),
  [Markdown 文档的阅读版式](../../../../../docs/design/behavior/files-and-git.md#markdown-文档的阅读版式) and the
  [presentation](../../../../../docs/design/presentation/files-and-git.md#markdown-的-html-子集与提示块) topics.
- **Real path:** production `WorkspaceWorkbench`, store, preload and `WorkspaceFiles` over private copies of both
  READMEs and `docs/assets/readme`; the App theme runtime is mounted like `App.tsx`; reading layout saves go through
  the preload to a fixture Main that merges with `applyConfigEdit` and pushes the committed config back.
- **Operations:** for each README and each App appearance, open the preview and capture the centered hero, the
  NOTE alert, the card tables and the themed architecture diagram; then open the Aa reading layout, choose serif,
  wide and a larger size; finally narrow the window over the cards. The elements page also captures fixed
  width/height and height-only local images in both themes, asserting the real image element resolves to the
  authored pixel dimensions through the original workspace resource port.
- **Boundary:** remote README badges load over the network like the product renderer. No installed App, user
  configuration, Session or Run is touched.

Run from the repository root:

```sh
node apps/desktop/scripts/capture-markdown-readme.mjs
```

Frames, `receipt.json` and `review.md` are written to `.tmp/markdown-readme-visual/`.
