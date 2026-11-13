# Temporary reference image

This fixture uses the production Main image owner, isolated preload and PinView with
the public Unix service, SDK client and built CLI. A generated test image is pinned
through the actual public operation. The private copy sink and file chooser avoid
the person's clipboard and system file dialog; the production PNG writer still
writes and reads back the fixed processed pixels in the fixture output directory.

Capture wide and narrow windows in dark and light themes. Use trusted CDP input in
these private windows for Copy, Save PNG and Escape. Close the second exact pin via
the actual CLI; inspect its original creation separately from its current closed
state. Repeat an original operation without recreating the window, and dispose the
owner with another reference still open.

Requirements: `docs/design/behavior/capture-and-recording.md` and the existing
screenshot presentation sections. The renderer must preserve image proportion,
readable dimensions, temporary-reference status and reachable copy/save/close actions
in each size and theme. These captures require a separate agent to open every image
and judge visual quality; layout assertions do not constitute that review.

The fixture does not capture the desktop, request OS recording permission, manipulate
a user Session or Run, package or install the app, or prove the original editor's
Browser/Composer attachment workflow. It uses the existing Electron binary and
private transient assets; no dependency download or application copy is needed.
