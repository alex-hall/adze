/**
 * Keys. `key` and `key-combo` take USB HID usage codes, translated to
 * Android keycodes, so the same key numbers work across platforms. Names (`ENTER`,
 * `KEYCODE_BACK`) are Android keycode names, for keys HID has no code for.
 *
 * The Command modifier maps to Ctrl: the shortcuts a macOS-minded caller
 * sends (Cmd+A to select all) then do the same thing on Android, where text
 * fields answer Ctrl+A.
 */

/** Android `KeyEvent` keycodes this module names. */
const ANDROID_KEYCODES: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  COMMA: 55,
  PERIOD: 56,
  ALT_LEFT: 57,
  ALT_RIGHT: 58,
  SHIFT_LEFT: 59,
  SHIFT_RIGHT: 60,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  GRAVE: 68,
  MINUS: 69,
  EQUALS: 70,
  LEFT_BRACKET: 71,
  RIGHT_BRACKET: 72,
  BACKSLASH: 73,
  SEMICOLON: 74,
  APOSTROPHE: 75,
  SLASH: 76,
  MENU: 82,
  SEARCH: 84,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  CTRL_LEFT: 113,
  CTRL_RIGHT: 114,
  CAPS_LOCK: 115,
  META_LEFT: 117,
  META_RIGHT: 118,
  MOVE_HOME: 122,
  MOVE_END: 123,
  INSERT: 124,
  F1: 131,
  APP_SWITCH: 187,
};
for (let letter = 0; letter < 26; letter++) {
  ANDROID_KEYCODES[String.fromCharCode(65 + letter)] = 29 + letter; // KEYCODE_A = 29
}
for (let digit = 0; digit < 10; digit++) {
  ANDROID_KEYCODES[String(digit)] = 7 + digit; // KEYCODE_0 = 7
}

/** HID usage code → Android keycode, for the keys both have. */
const HID_TO_ANDROID = new Map<number, number>([
  [40, ANDROID_KEYCODES.ENTER!],
  [41, ANDROID_KEYCODES.ESCAPE!],
  [42, ANDROID_KEYCODES.DEL!],
  [43, ANDROID_KEYCODES.TAB!],
  [44, ANDROID_KEYCODES.SPACE!],
  [45, ANDROID_KEYCODES.MINUS!],
  [46, ANDROID_KEYCODES.EQUALS!],
  [47, ANDROID_KEYCODES.LEFT_BRACKET!],
  [48, ANDROID_KEYCODES.RIGHT_BRACKET!],
  [49, ANDROID_KEYCODES.BACKSLASH!],
  [51, ANDROID_KEYCODES.SEMICOLON!],
  [52, ANDROID_KEYCODES.APOSTROPHE!],
  [53, ANDROID_KEYCODES.GRAVE!],
  [54, ANDROID_KEYCODES.COMMA!],
  [55, ANDROID_KEYCODES.PERIOD!],
  [56, ANDROID_KEYCODES.SLASH!],
  [57, ANDROID_KEYCODES.CAPS_LOCK!],
  [73, ANDROID_KEYCODES.INSERT!],
  [74, ANDROID_KEYCODES.MOVE_HOME!],
  [75, ANDROID_KEYCODES.PAGE_UP!],
  [76, ANDROID_KEYCODES.FORWARD_DEL!],
  [77, ANDROID_KEYCODES.MOVE_END!],
  [78, ANDROID_KEYCODES.PAGE_DOWN!],
  [79, ANDROID_KEYCODES.DPAD_RIGHT!],
  [80, ANDROID_KEYCODES.DPAD_LEFT!],
  [81, ANDROID_KEYCODES.DPAD_DOWN!],
  [82, ANDROID_KEYCODES.DPAD_UP!],
  [224, ANDROID_KEYCODES.CTRL_LEFT!],
  [225, ANDROID_KEYCODES.SHIFT_LEFT!],
  [226, ANDROID_KEYCODES.ALT_LEFT!],
  [227, ANDROID_KEYCODES.CTRL_LEFT!], // left Command
  [228, ANDROID_KEYCODES.CTRL_RIGHT!],
  [229, ANDROID_KEYCODES.SHIFT_RIGHT!],
  [230, ANDROID_KEYCODES.ALT_RIGHT!],
  [231, ANDROID_KEYCODES.CTRL_RIGHT!], // right Command
]);
for (let letter = 0; letter < 26; letter++)
  HID_TO_ANDROID.set(4 + letter, 29 + letter);
for (let digit = 1; digit <= 9; digit++)
  HID_TO_ANDROID.set(29 + digit, 7 + digit); // HID 30 = "1"
HID_TO_ANDROID.set(39, 7); // HID 39 = "0"
for (let fn = 0; fn < 12; fn++)
  HID_TO_ANDROID.set(58 + fn, ANDROID_KEYCODES.F1! + fn);

/** Android `KeyEvent` meta state bits for each modifier keycode. */
const META_FOR_KEYCODE = new Map<number, number>([
  [ANDROID_KEYCODES.SHIFT_LEFT!, 0x1 | 0x40],
  [ANDROID_KEYCODES.SHIFT_RIGHT!, 0x1 | 0x80],
  [ANDROID_KEYCODES.ALT_LEFT!, 0x2 | 0x10],
  [ANDROID_KEYCODES.ALT_RIGHT!, 0x2 | 0x20],
  [ANDROID_KEYCODES.CTRL_LEFT!, 0x1000 | 0x2000],
  [ANDROID_KEYCODES.CTRL_RIGHT!, 0x1000 | 0x4000],
  [ANDROID_KEYCODES.META_LEFT!, 0x10000 | 0x20000],
  [ANDROID_KEYCODES.META_RIGHT!, 0x10000 | 0x40000],
]);

/**
 * A key argument: a number is a HID usage code, a name is an
 * Android keycode name with or without its `KEYCODE_` prefix.
 */
export function androidKeycode(key: string): number {
  const trimmed = key.trim();
  if (/^\d+$/.test(trimmed)) {
    const hid = Number(trimmed);
    const keycode = HID_TO_ANDROID.get(hid);
    if (keycode === undefined) {
      throw new Error(
        `HID keycode ${hid} has no Android equivalent. Use an Android keycode name instead, e.g. ENTER or KEYCODE_BACK.`,
      );
    }
    return keycode;
  }
  const name = trimmed.toUpperCase().replace(/^KEYCODE_/, "");
  const keycode = ANDROID_KEYCODES[name];
  if (keycode === undefined) throw new Error(`Unknown key '${key}'.`);
  return keycode;
}

/** Android meta state for a set of modifier keys, given as `androidKeycode` accepts. */
export function metaStateFor(modifiers: readonly string[]): number {
  let meta = 0;
  for (const modifier of modifiers) {
    const keycode = androidKeycode(modifier);
    const bits = META_FOR_KEYCODE.get(keycode);
    if (bits === undefined)
      throw new Error(`'${modifier}' is not a modifier key.`);
    meta |= bits;
  }
  return meta;
}

/** Hardware buttons: the iOS simulator's names where they mean the same, plus Android's own. */
const BUTTONS: Record<string, number> = {
  home: ANDROID_KEYCODES.HOME!,
  lock: ANDROID_KEYCODES.POWER!,
  "side-button": ANDROID_KEYCODES.POWER!,
  power: ANDROID_KEYCODES.POWER!,
  back: ANDROID_KEYCODES.BACK!,
  recents: ANDROID_KEYCODES.APP_SWITCH!,
  "volume-up": ANDROID_KEYCODES.VOLUME_UP!,
  "volume-down": ANDROID_KEYCODES.VOLUME_DOWN!,
};

export const BUTTON_NAMES = Object.keys(BUTTONS);

export function buttonKeycode(button: string): number {
  const keycode = BUTTONS[button];
  if (keycode === undefined) {
    throw new Error(
      `Button '${button}' doesn't exist on Android. Use one of: ${BUTTON_NAMES.join(", ")}.`,
    );
  }
  return keycode;
}
