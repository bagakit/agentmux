# Connecting / recovery runtime cutover decision

Date: 2026-09-21

The Connecting and Terminal recovery implementation is validated in the desktop source tree and in a real Electron `WebContentsView`. The normal startup regression is fixed by letting `RendererUpdates` own the single navigation; the full Region surfaces keep durable layout and Session identity visible while the Runtime handshake is pending.

This feature does not perform a live Runtime replacement or restart. The installed Runtime derives its socket and state endpoint from the artifact identity, so a new package cannot be assumed to reattach the existing live Runs. The current field evidence also identifies active Runs that must not be interrupted merely to prove an install.

Decision: preserve the running daemon and active Runs, do not bypass the installer guard, and treat a reviewed drain/resume cutover as a separate operational task. The installer already requires a non-empty Run/resume review record when a Runtime identity changes. This feature therefore closes the code and UI contract without claiming that a live endpoint cutover was performed.
