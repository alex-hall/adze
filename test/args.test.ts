import { describe, expect, it } from "vitest";
import { parseCommand, tokenizeLine, UsageError } from "../src/args.js";

describe("parseCommand", () => {
  it("parses a tap with its flags", () => {
    const command = parseCommand([
      "tap",
      "--label",
      "Sign in",
      "--wait-timeout",
      "2",
    ]);
    expect(command.name).toBe("tap");
    expect(command.flags.get("--label")).toBe("Sign in");
    expect(command.flags.get("--wait-timeout")).toBe("2");
  });

  it("accepts --udid as another name for --serial", () => {
    expect(
      parseCommand(["describe-ui", "--udid", "emulator-5554"]).flags.get(
        "--serial",
      ),
    ).toBe("emulator-5554");
  });

  it("prefers --serial when both are given", () => {
    const command = parseCommand([
      "describe-ui",
      "--udid",
      "a",
      "--serial",
      "b",
    ]);
    expect(command.flags.get("--serial")).toBe("b");
  });

  it("accepts --flag=value", () => {
    expect(
      parseCommand(["swipe", "--duration=0.5"]).flags.get("--duration"),
    ).toBe("0.5");
  });

  it("treats a negative number as a value, not a flag", () => {
    expect(parseCommand(["tap", "-x", "-5", "-y", "10"]).flags.get("-x")).toBe(
      "-5",
    );
  });

  it("takes the text to type as a positional", () => {
    expect(parseCommand(["type", "hello there"]).positionals).toEqual([
      "hello there",
    ]);
  });

  it("collects repeated batch steps", () => {
    const command = parseCommand([
      "batch",
      "--step",
      "tap -x 1 -y 2",
      "--step",
      "type hi",
    ]);
    expect(JSON.parse(String(command.flags.get("--step")))).toEqual([
      "tap -x 1 -y 2",
      "type hi",
    ]);
  });

  it("rejects an option the command doesn't have", () => {
    expect(() => parseCommand(["tap", "--start-x", "1"])).toThrow(UsageError);
  });

  it("rejects an unknown command", () => {
    expect(() => parseCommand(["fly"])).toThrow("Unknown command 'fly'.");
  });

  it("rejects a flag missing its value", () => {
    expect(() => parseCommand(["tap", "--label"])).toThrow(
      "--label needs a value.",
    );
  });
});

describe("tokenizeLine", () => {
  it("splits on whitespace", () => {
    expect(tokenizeLine("tap  -x 10 -y 20")).toEqual([
      "tap",
      "-x",
      "10",
      "-y",
      "20",
    ]);
  });

  it("groups double-quoted text", () => {
    expect(tokenizeLine('tap --label "Sign in now"')).toEqual([
      "tap",
      "--label",
      "Sign in now",
    ]);
  });

  it("unescapes quotes and backslashes inside quotes, as AXhandle sends them", () => {
    expect(tokenizeLine('type "say \\"hi\\" \\\\ bye"')).toEqual([
      "type",
      'say "hi" \\ bye',
    ]);
  });

  it("keeps an empty quoted token", () => {
    expect(tokenizeLine('type ""')).toEqual(["type", ""]);
  });

  it("rejects an unterminated quote", () => {
    expect(() => tokenizeLine('type "oops')).toThrow(UsageError);
  });
});
