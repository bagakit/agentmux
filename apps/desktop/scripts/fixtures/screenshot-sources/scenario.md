# Capture source selection

Run the production Main source owner, isolated preload and source view in a private
Electron application. Only the native discovery interface is controlled: it returns
two displays, two applications with the same label, and windows with distinct exact
identities. The production owner must return the selected `CaptureParams` unchanged.

Use trusted CDP mouse and keyboard input to choose the second display, filter the
application list and open the second same-label application's windows. Check the
exact process identity in the discovery request and the exact window identity in
the result. Exercise a failed discovery followed by Retry, Escape cancellation, and
cancellation while a discovery result is still pending. A late result must not
reopen the window or prevent another source selection.

Capture normal and narrow windows in dark and light themes, including the partial
discovery notice and the recoverable failure. Check that the filter, source rows,
Cancel, Retry and footer remain reachable. The owning requirements are
`docs/design/behavior/capture-and-recording.md`; independently open every captured
image to judge hierarchy, readability, alignment, spacing and control clarity.
Geometry assertions and successful capture do not sign off the visual design.

The fixture does not capture desktop pixels, request OS recording permission,
claim that a process is running on the person's machine, use the person's clipboard,
or modify an existing Session, Run or workspace. It does not package or install the
application. The report records the exact production sources consumed by the
private build; all generated assets are transient and the existing Electron binary
is reused.
