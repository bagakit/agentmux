# Browser Viewport product scenario

This fixture verifies the original Browser's existing Viewport controls. Behavior is owned by [Browser viewport and size adjustment](../../../../../docs/design/behavior/browser-workface.md#browser-视口与尺寸调整); presentation is owned by [compact Browser tools](../../../../../docs/design/presentation/browser-workface.md#browser-任务工具与证据的紧凑呈现).

Run from the repository root:

```sh
node apps/desktop/scripts/verify-browser-viewport.mjs --mutations
```

The fixture mounts the production BrowserPane and native overlay consumer, bundles the production preload, and connects its original browser IPC channels to the production BrowserViewManager. Its small Store adapter consumes actual Main events and returned snapshots, so the menu's selected mode follows the original result. It uses temporary user data, a private memory partition, generic local HTTP documents and a private public-RPC endpoint. It does not connect to user Sessions, change the installed application, use the system clipboard or request screen-capture permissions.

## Actions and observations

1. Open the actual wide Viewport menu and select Mobile, Tablet, Desktop and Responsive with trusted pointer input. Repeat with documents that do and do not declare viewport meta.
2. Read the real engine's layout and visual viewport, screen dimensions and original View bounds. Fixed modes retain their declared screen size; standard mobile layout without viewport meta remains native browser behavior. Responsive follows the Pane. Inspect the original native PNG for all four colored corner controls, then click each visible control with full native pointer input and check the page's trusted event.
3. Resize the original Pane without resizing the application window, then repeat the geometry, corner and input observations. Narrow the Pane, open its actual More menu, and select the same Radio options there.
4. Discover the exact target and spatial binding through the real Core service and CLI. Use SDK and CLI browser programs to snapshot the actual page, click a current corner ref, read geometry through js and Page.getLayoutMetrics, and consume captureScreenshot. Existing semantic ref clicks and trusted native pointer events are recorded separately.
5. Reload and release/restore through the original owner/client paths. Mode selection and Pane resize preserve the physical View, navigation and live draft; explicit reload/restore may create a new document or native View, and are checked against their own lifecycle facts. The logical Browser, Profile and mode remain original, with the sibling's page, draft and zoom retained.

The mutation option revokes the real menu call, native apply and fit one at a time in private compiled variants. A private Vite transform also puts the mode assignment before native apply while running the exact original owner failure/retry test. Each mutation must reach a nonempty corresponding assertion and fail for that reason, then the unchanged source must pass again. Shared production files are never rewritten. Source inputs and compiled identities bind each receipt, and stale unit reports are removed before execution.

## Image review boundary

Each saved scene retains the complete actual Renderer image and the visible original/sibling native images with their real bounds and hashes. A whole-workface image composes these settled captures at those bounds without modifying product styles or the product DOM. Only actually visible owners are included, after the menu has closed. This image is explicitly a composite of actual surfaces, not an operating-system window screenshot; the uncomposited native PNGs and trusted corner clicks carry the fit/input evidence.

An independent reviewer opens every final whole-workface image at original size. Check the compact controls, complete four-edge page, readable content within that mode, narrow More reachability and retained sibling. Selected-mode and menu-input assertions carry the closed menu's state evidence. Inspect the original native image when the composition obscures a geometry question. Capture success, pixel counts and green tests do not replace the reviewer's visual judgment. Use the final receipt's image identities; source and mutation images are separate candidates.

This scenario proves the mounted production path with isolated test IO. It does not claim installed-app identity, full Desktop Shell recovery, physical OS input or a website-specific rendering result. Process receipts and images remain local; this file describes the stable scenario only.
