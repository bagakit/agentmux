# Settings editor density

Open Settings from the Desktop status bar and open Prompts. Use a populated library and edit the same Prompt with two lines, a long multiline value, two lines again and then an invalid value. Check the text bounds, native focus, inner scrolling, attached validation message and whole-library save in wide and narrow windows. Observe the same presentation in Derived actions, My Profile and Automation. Exercise visible radio and switch keyboard focus in InApp and Clubs.

The scenario mounts the actual Desktop renderer in Electron and saves through a private ConfigOwner and ConfigStore. The fixture owns its sample inputs. For the paired failure, the probe consumes a private mutation of the actual Prompt component and checks that an oversized field and a second boundary both fail the layout assertion. The scope and focus contract live in [Settings presentation](../../../../../docs/design/presentation/settings-and-observation.md#prompt-库与编辑工作面).
