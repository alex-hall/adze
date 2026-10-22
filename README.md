# adze

Drive Android emulators through accessibility from the command line: read the
screen's accessibility tree as JSON, tap elements by ID or label, type, swipe
and press keys. Built for end-to-end test harnesses, and handy by hand.

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
another name for it.

## Commands

| Command                            | What it does                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `describe-ui`                      | The accessibility tree as JSON; `--point x,y` for the element at a point                                            |
| `tap`                              | Tap a point (`-x`/`-y`) or an element (`--id`, `--label`, `--value`), optionally waiting for it (`--wait-timeout`)  |
| `type`                             | Type text into the focused field (argument, `--stdin` or `--file`)                                                  |
| `swipe`                            | Swipe between two points                                                                                            |
| `touch`                            | Touch down and/or up at a point                                                                                     |
| `key`, `key-sequence`, `key-combo` | Press keys, in turn or with modifiers                                                                               |
| `button`                           | Press `home`, `back`, `recents`, `lock`/`power`, `volume-up` or `volume-down`                                       |
| `gesture`                          | Preset swipes: `scroll-up`, `scroll-down`, `scroll-left`, `scroll-right`, `swipe-from-{left,right,top,bottom}-edge` |
| `screenshot`                       | Save a PNG of the screen                                                                                            |
| `list-devices`                     | Connected devices                                                                                                   |
| `batch`                            | Run several commands over one connection                                                                            |
| `serve`                            | Read commands from stdin and answer each with one JSON line, after a `{"ready":true}` line                          |

## How it works

A small instrumentation app runs on the emulator and reads and drives the
screen through `UiAutomation`; the app under test needs no changes. The CLI
installs it, starts it and keeps it on the same build as the CLI on its own:
the first command on a fresh emulator takes about a second, later ones tens of
milliseconds. Through a long-lived `adze serve`, reading a screen of about a
hundred elements takes a few milliseconds.

## Details

- **Coordinates are dp**, Android's counterpart of iOS points.
- **Keys** are USB HID usage codes, translated to Android keycodes, or Android
  keycode names (`ENTER`, `KEYCODE_BACK`). Command maps to Ctrl, so
  macOS-style shortcuts such as Cmd+A do the Android equivalent.
- **`describe-ui`** returns one top-level element per window, back to front:
  the app, dialogs, the keyboard. The status and navigation bars are left out
  unless you pass `--all-windows`. Each element has `AXLabel`, `AXUniqueId`
  (the view ID, which carries React Native's `testID`), `AXValue`, `type`,
  `frame` and `visible`, plus an `android` object with what Android itself
  reported. `visible` is false for rows scrolled off screen and for elements
  under the keyboard, a dialog or a system bar, where a tap would land on
  whatever covers them.
- **Labels:** an element's content description wins over its visible text, and
  text children that only repeat their parent's description are dropped, so a
  button labelled "Sign in" isn't matched twice. iOS hides those children too.
- **Selecting:** `--id`, `--label` and `--value` match exactly. Two visible
  matches is an error rather than a guess; narrow it with `--element-type` or
  use an ID.
- **`type`** inserts at the cursor of the focused field through the
  accessibility API, so any Unicode arrives intact. A newline presses Return.
  A password field's current text can't be read back, so typing into one
  replaces its contents.

## Development

Needs Node 20+, a JDK 17 and the Android SDK (`ANDROID_HOME`).

```bash
npm install
npm run build:server   # builds the device app into apk/
npm run build
npm test               # no emulator needed
```
