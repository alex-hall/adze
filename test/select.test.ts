import { describe, expect, it } from "vitest";
import {
  activationPoint,
  AmbiguousMatchError,
  elementAt,
  labelMatches,
  NoMatchError,
  OffScreenMatchError,
  selectElement,
} from "../src/select.js";
import { describeWindows } from "../src/tree.js";
import { messageList, node, SCREEN, signInScreen, window } from "./fixtures.js";

const signIn = () => describeWindows(signInScreen(), SCREEN);
const messages = () => describeWindows(messageList(), SCREEN);

describe("selectElement", () => {
  it("finds an element by testID", () => {
    expect(
      selectElement(signIn(), { kind: "id", text: "sign-in" }).AXLabel,
    ).toBe("Sign in");
  });

  it("finds an element by label", () => {
    expect(
      selectElement(signIn(), { kind: "label", text: "Welcome, Alice" }).type,
    ).toBe("StaticText");
  });

  it("finds an element by value", () => {
    expect(selectElement(signIn(), { kind: "value", text: "1" }).type).toBe(
      "Switch",
    );
  });

  it("fails with the stable no-match wording drivers match on", () => {
    expect(() =>
      selectElement(signIn(), { kind: "label", text: "Sign up" }),
    ).toThrow(NoMatchError);
    expect(() =>
      selectElement(signIn(), { kind: "label", text: "Sign up" }),
    ).toThrow("No accessibility element matched --label 'Sign up'");
  });

  it("refuses to guess between two visible matches", () => {
    // The button and its own text child both read "Sign in".
    const twoMatches = describeWindows(
      [
        window(
          node({
            children: [node({ text: "Sign in" }), node({ text: "Sign in" })],
          }),
        ),
      ],
      SCREEN,
    );
    expect(() =>
      selectElement(twoMatches, { kind: "label", text: "Sign in" }),
    ).toThrow(AmbiguousMatchError);
  });

  it("narrows matches by element type", () => {
    const element = selectElement(signIn(), {
      kind: "label",
      text: "Sign in",
      elementType: "button",
    });
    expect(element.AXUniqueId).toBe("sign-in");
  });

  it("ignores off-screen copies when one match is on screen", () => {
    const repeated = describeWindows(
      [
        window(
          node({
            children: [
              node({ text: "Bob", visible: false }),
              node({ text: "Bob" }),
            ],
          }),
        ),
      ],
      SCREEN,
    );
    expect(
      selectElement(repeated, { kind: "label", text: "Bob" }).visible,
    ).toBe(true);
  });

  it("doesn't find a row scrolled off screen, as on iOS", () => {
    expect(() =>
      selectElement(messages(), { kind: "id", text: "message-1" }),
    ).toThrow(NoMatchError);
  });

  it("says a match is off screen when off-screen elements are included", () => {
    const withOffscreen = describeWindows(messageList(), SCREEN, {
      offscreen: true,
    });
    expect(() =>
      selectElement(withOffscreen, { kind: "id", text: "message-1" }),
    ).toThrow(OffScreenMatchError);
  });
});

describe("labelMatches", () => {
  it("matches Android's all-caps button by its ordinary spelling", () => {
    expect(labelMatches("CONFIRM", "Confirm")).toBe(true);
  });

  it("stays exact for labels that aren't all caps", () => {
    expect(labelMatches("Confirm", "confirm")).toBe(false);
    expect(labelMatches("Sign In", "Sign in")).toBe(false);
  });

  it("doesn't read an all-caps search as matching a mixed-case label", () => {
    expect(labelMatches("Confirm", "CONFIRM")).toBe(false);
  });
});

describe("activationPoint", () => {
  it("is the center of an element fully on screen", () => {
    const button = selectElement(signIn(), { kind: "id", text: "sign-in" });
    expect(activationPoint(button, SCREEN)).toEqual({ x: 200, y: 728 });
  });

  it("is the center of the visible part of an element cut off by the screen edge", () => {
    const row = selectElement(messages(), { kind: "id", text: "message-5" });
    // The row spans y 770–830 on an 800 dp screen: its visible part is 770–800.
    expect(activationPoint(row, SCREEN)).toEqual({ x: 200, y: 785 });
  });
});

describe("elementAt", () => {
  it("finds the deepest visible element under a point", () => {
    expect(elementAt(signIn(), 200, 350)?.type).toBe("Switch");
    expect(elementAt(signIn(), 30, 110)?.AXLabel).toBe("Welcome, Alice");
  });

  it("finds nothing outside every element", () => {
    expect(elementAt(signIn(), 500, 500)).toBeUndefined();
  });
});
