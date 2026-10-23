import { describe, expect, it } from "vitest";
import {
  biometricPromptShowing,
  fingerprintEnrolled,
  nextEnrollStep,
} from "../src/biometric.js";
import { describeWindows } from "../src/tree.js";
import { node, SCREEN, window } from "./fixtures.js";

/** A Settings screen showing these texts, one text element each. */
const screen = (...texts: string[]) =>
  describeWindows(
    [
      window(
        node({
          package: "com.android.settings",
          children: texts.map((text, index) =>
            node({
              class: "android.widget.TextView",
              text,
              frame: { x: 0, y: index * 60, width: 400, height: 50 },
            }),
          ),
        }),
        { title: "Settings" },
      ),
    ],
    SCREEN,
  );

describe("nextEnrollStep", () => {
  it("enters the PIN when Settings asks for it", () => {
    expect(nextEnrollStep(screen("Re-enter your PIN")).kind).toBe("pin");
  });

  it("taps I AGREE once the intro offers it", () => {
    const step = nextEnrollStep(
      screen("Set up Pixel Imprint", "MORE", "I AGREE"),
    );
    expect(step).toMatchObject({ kind: "tap", target: { AXLabel: "I AGREE" } });
  });

  it("scrolls the intro with MORE until it can agree", () => {
    const step = nextEnrollStep(screen("Set up Pixel Imprint", "MORE"));
    expect(step).toMatchObject({ kind: "tap", target: { AXLabel: "MORE" } });
  });

  it("touches the sensor while enrollment asks for a finger", () => {
    expect(nextEnrollStep(screen("Touch the sensor")).kind).toBe(
      "touch-sensor",
    );
  });

  it("finishes on Fingerprint added, tapping Done", () => {
    const step = nextEnrollStep(
      screen("Fingerprint added", "ADD ANOTHER", "DONE"),
    );
    expect(step).toMatchObject({ kind: "done", target: { AXLabel: "DONE" } });
  });

  it("waits on a screen it doesn't recognize", () => {
    expect(nextEnrollStep(screen("Loading")).kind).toBe("wait");
  });
});

describe("dumpsys readers", () => {
  it("sees a biometric prompt only when it holds focus", () => {
    expect(
      biometricPromptShowing(
        "mCurrentFocus=Window{242de1f u0 BiometricPrompt}",
      ),
    ).toBe(true);
    expect(
      biometricPromptShowing(
        "mCurrentFocus=Window{a235d29 u0 com.example/com.example.Main}\n  Window #3 BiometricPrompt",
      ),
    ).toBe(false);
  });

  it("counts enrolled fingerprints", () => {
    expect(fingerprintEnrolled('{"prints":[{"id":0,"count":1}]}')).toBe(true);
    expect(fingerprintEnrolled('{"prints":[{"id":0,"count":0}]}')).toBe(false);
    expect(fingerprintEnrolled("")).toBe(false);
  });
});
