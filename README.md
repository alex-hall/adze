# adze

Drive Android emulators through accessibility, the way
[AXe](https://github.com/cameroncooke/AXe) drives iOS simulators: read the
screen's accessibility tree as JSON, tap elements by ID or label, type, swipe,
press keys.

adze mirrors AXe's command line, `serve` protocol and `describe-ui` JSON, so
a test driver written for AXe drives an emulator by changing the binary name.

```bash
adze describe-ui --serial emulator-5554
adze tap --id sign-in --serial emulator-5554
adze tap --label "Sign in" --wait-timeout 5
adze type "Alice’s note 👋"
adze swipe --start-x 200 --start-y 600 --end-x 200 --end-y 200
adze key-combo --modifiers 227 --key 4      # Cmd+A → select all
adze button back
adze screenshot --output screen.png
```

With one device connected, `--serial` can be left out. `--udid` is accepted as
another name for it, so AXe-style invocations work unchanged.

## How it works

A small instrumentation app runs on the emulator and reads and drives the
screen through `UiAutomation`; the app under test needs no changes. The CLI
installs it, starts it and keeps it on the same build as the CLI on its own:
the first command on a fresh emulator takes about a second, later ones tens of
milliseconds. Through a long-lived `adze serve`, reading a screen of about a
hundred elements takes a few milliseconds.

## Differences from AXe

- **Coordinates are dp**, Android's counterpart of iOS points.
- **Keys** take HID usage codes like AXe's, translated to Android keycodes, or
  Android keycode names (`ENTER`, `KEYCODE_BACK`). Command maps to Ctrl, so
  macOS-style shortcuts such as Cmd+A do the Android equivalent.
- **Buttons:** `home`, `back`, `recents`, `lock` (also `side-button`,
  `power`), `volume-up`, `volume-down`.
- **`describe-ui`** returns one top-level element per window, back to front:
  the app, dialogs, the keyboard. The status and navigation bars are left out
  unless you pass `--all-windows`. Each element carries `visible` and an
  `android` object with what Android itself reported. `visible` is false for
  rows scrolled off screen and for elements under the keyboard, a dialog or a
  system bar, where a tap would land on whatever covers them.
- **Labels:** an element's content description wins over its visible text, and
  text children that only repeat their parent's description are dropped, so a
  button labelled "Sign in" isn't matched twice. iOS hides those children too.
- **`type`** inserts at the cursor of the focused field through the
  accessibility API, so any Unicode arrives intact. A newline presses Return.
  A password field's current text can't be read back, so typing into one
  replaces its contents.
- Not implemented: `slider`, `drag`, `stream-video`, `record-video`, `init`.

## Development

Needs Node 20+, a JDK 17 and the Android SDK (`ANDROID_HOME`).

```bash
npm install
npm run build:server   # builds the device app into apk/
npm run build
npm test               # no emulator needed
```
