# Mesh settings review

Uses the production SettingsPanel, Mesh components, theme and layout inside a private Electron window. Network data is controlled in entry.tsx; this does not prove Farm deployment, native manufacturer protocols or real networking. The separate mesh-desktop-service and real Mesh editor tests cover original Core/Host/Native consumers.

Read docs/design/behavior/mesh.md and docs/design/presentation/settings-and-observation.md#mesh-网络工作面. Inspect actual configured network, selected route, dark/light, narrow view, failed new listener preserving previous observation, lower fields, endpoint offer and saved connections. Added first-use disabled, unavailable settings+network, and settings unavailable with authenticated network observed. Initial/unavailable include wide dark/light and narrow dark/light.

Use capture.cjs with the private preview URL, absolute or relative private userData directory and an existing output directory. The script never starts/stops user Agents, modifies installed App configuration or installs a package. A screenshot/fixture is not proof of UI aesthetics; an independent Agent opens the full images and records approval. New visual code requires a fresh build and recapture. No animation is added by this change.

## Runtime Settings inputs

Run `node apps/desktop/scripts/verify-settings-inputs-runtime.mjs` from the repository root. It verifies mounted form behavior and two product source mutations, then captures the original Settings panels in private Electron at 1280px dark and 520px light.

The captures exercise Provider search and selection, the new Executor Provider and arguments, the remote SSH port, a masked read-only Tailcat address beside its copy action, a submitted Mesh code error, Node publication paths and the shared Remote preparation selector. The review should check field boundaries, focus, narrow layouts, error text and truncation against the Settings and input presentation contracts. Provider and preview configuration facts are from the built app preview. Node, Tailcat and Mesh responses are controlled observations. The capture does not start or replace user Sessions or prove transport or clipboard access. The behavioral gate covers the original route and save owners independently.
