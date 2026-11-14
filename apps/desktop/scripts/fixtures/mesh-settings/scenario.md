# Mesh settings review

Uses the production SettingsPanel, Mesh components, theme and layout inside a private Electron window. Network data is controlled in entry.tsx; this does not prove Farm deployment, native manufacturer protocols or real networking. The separate mesh-desktop-service and real Mesh editor tests cover original Core/Host/Native consumers.

Read docs/design/behavior/mesh.md and docs/design/presentation/settings-and-observation.md#mesh-网络工作面. Inspect actual configured network, selected route, dark/light, narrow view, failed new listener preserving previous observation, lower fields, endpoint offer and saved connections. Added first-use disabled, unavailable settings+network, and settings unavailable with authenticated network observed. Initial/unavailable include wide dark/light and narrow dark/light.

Use capture.cjs with the private preview URL, absolute or relative private userData directory and an existing output directory. The script never starts/stops user Agents, modifies installed App configuration or installs a package. A screenshot/fixture is not proof of UI aesthetics; an independent Agent opens the full images and records approval. New visual code requires a fresh build and recapture. No animation is added by this change.
