# Plugin Presets System

Addie ships pre-configured Ableton device presets (`.adg` files) that wrap
third-party VST/AU plugins inside Instrument Racks with their Ableton
Configure lists already populated. This lets Addie read and control plugin
parameters without any manual setup by the end user.

## How it works

1. A developer loads a plugin in Ableton, opens Configure mode, touches every
   parameter that should be exposed, then groups the plugin into an
   Instrument Rack and saves it to User Library.
2. The resulting `.adg` file is placed in this `presets/` directory.
3. The plugin name is added to `registry.json`.
4. When a user installs Addie, the `.adg` files are copied to their Ableton
   User Library under an `Addie/` subfolder.
5. When the user (or the LLM) requests loading a plugin that has an entry in
   the registry, Addie loads the pre-configured `.adg` instead of the raw
   plugin — giving full parameter access immediately.

## Adding a new plugin preset

### Step 1 — Configure the plugin

1. Open Ableton Live
2. Create a new MIDI track
3. Load the plugin from the browser (e.g. drag "Serum" onto the track)
4. Click **Configure** in the plugin's device panel (bottom-right)
5. Open the plugin GUI and click/wiggle every parameter you want Addie to see
6. The parameters appear in the green Configure list at the bottom

### Step 2 — Wrap in a Rack and save

1. Right-click the plugin's title bar → **Group** (or Ctrl+G / Cmd+G)
2. The plugin is now inside an Instrument Rack
3. Drag the **Instrument Rack** title bar into User Library in the browser
4. Name it `Addie - <PluginName>` (e.g. `Addie - Serum`)

### Step 3 — Add to Addie

1. Find the saved `.adg` file in your Ableton User Library folder:
   - **Windows:** `C:\Users\<you>\Documents\Ableton\User Library\Presets\Instruments\Instrument Rack\`
   - **Mac:** `~/Music/Ableton/User Library/Presets/Instruments/Instrument Rack/`
2. Copy it to this `presets/` directory
3. Update `registry.json`:

```json
{
  "Diva": "Addie - Diva",
  "Serum": "Addie - Serum"
}
```

The key on the left is what the LLM or user says (fuzzy matched).
The value on the right is the `.adg` filename (without extension) as saved
in Ableton's User Library under the `Addie/` folder.

### Step 4 — Test

1. Restart Addie (or re-run `npm start`)
2. Say "load Serum on my lead track"
3. Addie should load the pre-configured Rack version
4. Ask "what's on my lead track?" — Addie should see all parameters

## File structure

```
presets/
  README.md          ← this file
  registry.json      ← maps plugin names to preset names
  Addie - Diva.adg   ← pre-configured Instrument Rack with Diva
  Addie - Serum.adg  ← pre-configured Instrument Rack with Serum
  ...
```

## How the intercept works (technical)

`app/plugins/presets.js` loads `registry.json` on startup. When `actions.js` processes a `browser_insert` action, it calls `presets.getPresetName(deviceName)`. If a match is found, the device name is silently rewritten to the preset name before sending to the Python bridge. The bridge searches `user_library` in the browser (which is already in the search order) and finds the `.adg`.

Because the preset is an Instrument Rack wrapping the plugin, Addie uses Rack traversal (`device.can_have_chains` → `device.chains` → `chain.devices`) to reach the plugin's parameters through the Rack. Inner devices are addressed by name:

```
param_set_inner | TrackName | Instrument Rack | Diva | VCF1: Frequency | 2.5 kHz
```

The Python bridge resolves `Instrument Rack` to the outer Rack on the track, then `Diva` to the inner device inside it. No numeric indices involved — renaming the Rack or reordering chains never breaks parameter access.

## Notes

- The `.adg` preset stores the Configure list but loads the plugin in its
  **init/default state**. The user's sound is not affected — they load their
  own presets via the plugin GUI afterward.
- Preset portability depends on the plugin being installed on the target
  machine. If the user doesn't have Diva installed, loading `Addie - Diva`
  will fail with a missing plugin error from Ableton.
- The fuzzy matching in `presets.js` handles variations like "Diva", "diva",
  "Diva(x64)", "u-he Diva" all matching the registry key "Diva".
