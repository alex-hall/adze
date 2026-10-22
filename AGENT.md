# Open-source project rules

adze is a public, open-source project. Treat every file, commit, test fixture,
log, screenshot, recording, issue and generated artifact as if it may be
published.

## Information safety

- Do not copy, reference, infer or disclose any private application's source,
  behavior, test flows, architecture, data, credentials, identifiers, service
  URLs, keys or internal tooling.
- Do not commit screenshots, accessibility dumps, videos or logs captured from
  a private application. Fixtures come from stock Android system UI or are
  written by hand, with generic names and fictional data ("Example App",
  "Alice", "Bob").
- Do not push, publish or send anything externally unless explicitly asked.

## Design rules

- **Mirror AXe.** Subcommands, flags, `serve` protocol, `describe-ui` JSON keys
  and the "no element matched" error text follow AXe's, so a driver written for
  AXe works against adze by changing the binary name. Android-only additions
  are new subcommands or flags; never change the meaning of an AXe one.
- **Coordinates are dp**, the Android counterpart of iOS points, everywhere on
  the command line and in output.
- **The device server stays small.** It exposes primitives (dump, touch, key,
  text, screenshot). Resolution, waiting and output shaping live in the CLI,
  where tests run without a device.
- Tests run without an emulator by default. Emulator tests are opt-in
  (`npm run test:e2e`).
