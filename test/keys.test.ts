import { describe, expect, it } from "vitest";
import { androidKeycode, buttonKeycode, metaStateFor } from "../src/keys.js";

const KEYCODE_A = 29;
const KEYCODE_ENTER = 66;
const KEYCODE_BACK = 4;
const META_CTRL_ON = 0x1000;
const META_SHIFT_ON = 0x1;

describe("androidKeycode", () => {
  it("reads a number as a HID usage code, as AXe does", () => {
    expect(androidKeycode("4")).toBe(KEYCODE_A);
    expect(androidKeycode("40")).toBe(KEYCODE_ENTER);
  });

  it("maps the HID digit row, where 0 comes after 9", () => {
    expect(androidKeycode("30")).toBe(8); // "1"
    expect(androidKeycode("39")).toBe(7); // "0"
  });

  it("reads a name as an Android keycode name", () => {
    expect(androidKeycode("BACK")).toBe(KEYCODE_BACK);
    expect(androidKeycode("keycode_enter")).toBe(KEYCODE_ENTER);
  });

  it("rejects a HID code Android has no key for", () => {
    expect(() => androidKeycode("200")).toThrow("no Android equivalent");
  });
});

describe("metaStateFor", () => {
  it("turns Command into Ctrl, so Cmd+A selects all on Android too", () => {
    expect(metaStateFor(["227"]) & META_CTRL_ON).toBeTruthy();
  });

  it("combines modifiers", () => {
    const meta = metaStateFor(["224", "225"]);
    expect(meta & META_CTRL_ON).toBeTruthy();
    expect(meta & META_SHIFT_ON).toBeTruthy();
  });

  it("rejects a key that isn't a modifier", () => {
    expect(() => metaStateFor(["4"])).toThrow("not a modifier");
  });
});

describe("buttonKeycode", () => {
  it("maps AXe's lock button to power", () => {
    expect(buttonKeycode("lock")).toBe(26);
  });

  it("explains a button Android doesn't have", () => {
    expect(() => buttonKeycode("apple-pay")).toThrow(
      "doesn't exist on Android",
    );
  });
});
