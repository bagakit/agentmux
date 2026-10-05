# Demand collaboration product capture

Owning contracts: `docs/design/behavior/goals-and-demand.md` and `docs/design/presentation/goals-and-demand.md`.

Run `node apps/desktop/scripts/capture-demand-collaboration.mjs`. The private Electron window renders the complete current Source App, GlobalBoardSurface, GoalDetail, picker, continuation control and original styles/client UI. The data and original preview transport are controlled. This capture does not claim installed App, native creation, source authentication, disk confirmation or restart; those use the actual Main/Core and Native receipts.

At 1280 and 420 pixels, in both light and dark themes: open the actual Goal detail, open Assignees, switch to Mote new Session, explicitly select an observed original Mote and saved Agent configuration, switch to New Agent and choose its directory, open the Supervisor single selection, view saved Supervisor and expand More properties. Native mouse events use positions read from the actual named controls. Wait for finite animations to finish before saving complete frames. Source hashes accompany every batch; aesthetic approval is recorded independently and locally.

The fixture deliberately gives presentation IDs different from canonical Core Session IDs. Screens must show the original names/avatar while business selections retain exact canonical identities. New Session creation, relationship saving and Continue remain separate. Key states include long names/search, retained creation operation and conflict; the original operation is never recreated by observation.
