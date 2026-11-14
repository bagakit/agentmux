# Original Browser windows

The private fixture uses the actual `WorkspaceWorkbench`, `BrowserPane`, window hook,
`WorkbenchWindows`, `BrowserViewManager` and `AppCaptureSource`. Only unrelated desktop
services use the maintained preview API. Browser registration, geometry, activation,
capture, annotations and window requests cross the actual preload bridge and Main owner.

A separate hidden cold Browser Tab has no native WebContents and must receive zero prepare, presentation registration or restore requests during all phases. A two-Region Tab contains an HTTP form and a file-URL form. While its main workface is
not selected, open the exact cross-display Tab in an independent window. Both original
native views must be physically attached to that child, with no copies left in Main.
Return it, then display its original main occurrence. Detach only the HTTP Region;
the file page stays in Main. Return that Region and verify both original documents,
navigation identities and unsubmitted title/draft values survive without submission.

Leave the original Tab in a durable independent window, exit the private process and
start a new private Electron process using the same data. The same durable window and
Browser IDs must recover with native views in the correct child, then return successfully.
Forms and WebContents identity are checked within each process. This does not claim that
Chromium form state persists across application restart.

Full-window images come from production `AppCaptureSource`, including exact Renderer and
Browser native layers. They support visual review of actual product composition, not an
OS compositor, physical keyboard/mouse input, real websites, user Sessions or Runtime recovery.
