import { describe, expect, it } from "vitest";
import { describeWindows, flatten, type UiElement } from "../src/tree.js";
import { node, SCREEN, signInScreen, window } from "./fixtures.js";

const describeSignIn = () => describeWindows(signInScreen(), SCREEN);
const byId = (elements: UiElement[], id: string) =>
  flatten(elements).find((element) => element.AXUniqueId === id)!;

describe("describeWindows", () => {
  it("leaves out the status and navigation bars", () => {
    expect(
      describeSignIn().map((element) => element.android.windowTitle),
    ).toEqual(["Example App"]);
  });

  it("keeps the bars when asked for every window", () => {
    expect(
      describeWindows(signInScreen(), SCREEN, { allWindows: true }),
    ).toHaveLength(3);
  });

  it("keeps a system window that isn't a bar, such as a dialog", () => {
    const dialog = window(
      node({
        package: "com.android.systemui",
        frame: { x: 40, y: 300, width: 320, height: 200 },
      }),
      {
        type: "system",
        layer: 5,
        frame: { x: 40, y: 300, width: 320, height: 200 },
      },
    );
    expect(describeWindows([dialog], SCREEN)).toHaveLength(1);
  });

  it("orders windows back to front", () => {
    const top = window(node(), { id: 9, layer: 9, title: "Dialog" });
    const bottom = window(node(), { id: 1, layer: 1, title: "App" });
    const titles = describeWindows([top, bottom], SCREEN).map(
      (element) => element.android.windowTitle,
    );
    expect(titles).toEqual(["App", "Dialog"]);
  });

  it("reports an app window as an application element, labelled with the app's name", () => {
    const [app] = describeSignIn();
    expect(app).toMatchObject({
      type: "Application",
      role: "AXApplication",
      role_description: "application",
      AXLabel: "Example App",
    });
  });
});

describe("describeNode", () => {
  it("gives the testID as AXUniqueId", () => {
    expect(byId(describeSignIn(), "sign-in").AXUniqueId).toBe("sign-in");
  });

  it("prefers the content description over the visible text for the label", () => {
    expect(byId(describeSignIn(), "sign-in").AXLabel).toBe("Sign in");
  });

  it("labels plain text with the text itself", () => {
    const label = flatten(describeSignIn()).find(
      (element) => element.type === "StaticText",
    )!;
    expect(label.AXLabel).toBe("Welcome, Alice");
    expect(label.AXValue).toBeNull();
  });

  it("labels an empty text field with its hint and gives it no value", () => {
    const email = byId(describeSignIn(), "email-field");
    expect(email).toMatchObject({
      type: "TextField",
      AXLabel: "Email",
      AXValue: null,
    });
  });

  it("gives a filled text field its text as the value", () => {
    const [app] = describeWindows(
      [
        window(
          node({
            children: [
              node({
                class: "android.widget.EditText",
                resourceId: "name",
                hint: "Name",
                text: "Bob",
                editable: true,
              }),
            ],
          }),
        ),
      ],
      SCREEN,
    );
    expect(byId([app!], "name")).toMatchObject({
      AXLabel: "Name",
      AXValue: "Bob",
    });
  });

  it("reports a password field as a secure text field", () => {
    expect(byId(describeSignIn(), "password-field").type).toBe(
      "SecureTextField",
    );
  });

  it('reports a switch\'s state as "1" or "0"', () => {
    const toggle = flatten(describeSignIn()).find(
      (element) => element.type === "Switch",
    )!;
    expect(toggle.AXValue).toBe("1");
  });

  it("maps widget classes to element roles", () => {
    expect(byId(describeSignIn(), "sign-in")).toMatchObject({
      type: "Button",
      role: "AXButton",
      role_description: "button",
    });
  });

  it("trusts a role description over the widget class", () => {
    const [app] = describeWindows(
      [
        window(
          node({
            children: [node({ resourceId: "tab", roleDescription: "Tab" })],
          }),
        ),
      ],
      SCREEN,
    );
    expect(byId([app!], "tab").type).toBe("Tab");
  });

  it("drops a described element's text children that only repeat its description, as iOS does", () => {
    expect(byId(describeSignIn(), "sign-in").children).toEqual([]);
  });

  it("keeps a described element's children that carry an ID or can be tapped", () => {
    const [app] = describeWindows(
      [
        window(
          node({
            contentDescription: "Alice, 2 unread",
            children: [
              node({ class: "android.widget.TextView", text: "Alice" }),
              node({
                class: "android.widget.TextView",
                text: "2 unread",
                resourceId: "unread-count",
              }),
              node({
                class: "android.widget.Button",
                text: "Alice",
                clickable: true,
              }),
            ],
          }),
        ),
      ],
      SCREEN,
    );
    const children = app!.children.map(
      (child) => child.AXUniqueId ?? child.type,
    );
    expect(children).toEqual(["unread-count", "Button"]);
  });

  it("writes AXFrame in its string form", () => {
    expect(byId(describeSignIn(), "sign-in").AXFrame).toBe(
      "{{20, 700}, {360, 56}}",
    );
  });
});

describe("windows over windows", () => {
  const keyboard = (top: number) =>
    window(node({ package: "com.example.keyboard", frame: { x: 0, y: top, width: 400, height: 800 - top } }), {
      id: 7,
      type: "input-method",
      layer: 5,
      frame: { x: 0, y: top, width: 400, height: 800 - top },
      title: "Keyboard",
    });

  it("reports an element under the keyboard as not visible", () => {
    const [app] = describeWindows([...signInScreen(), keyboard(500)], SCREEN);
    expect(byId([app!], "sign-in").visible).toBe(false);
    expect(byId([app!], "email-field").visible).toBe(true);
  });

  it("reports an element under a status bar it was laid out beneath as not visible", () => {
    const [app] = describeWindows(
      [
        window(node({ children: [node({ resourceId: "under-bar", frame: { x: 0, y: 0, width: 400, height: 20 } })] })),
        window(node({ package: "com.android.systemui", frame: { x: 0, y: 0, width: 400, height: 24 } }), {
          id: 2,
          type: "system",
          layer: 3,
          frame: { x: 0, y: 0, width: 400, height: 24 },
        }),
      ],
      SCREEN,
    );
    expect(byId([app!], "under-bar").visible).toBe(false);
  });

  it("leaves out a landscape navigation bar down the side of the screen", () => {
    const landscape = { widthDp: 800, heightDp: 400 };
    const sideBar = window(node({ package: "com.android.systemui" }), {
      id: 3,
      type: "system",
      layer: 2,
      frame: { x: 752, y: 0, width: 48, height: 400 },
    });
    expect(describeWindows([window(node()), sideBar], landscape)).toHaveLength(1);
  });

  it("keeps a thin edge window that isn't System UI's", () => {
    const banner = window(node({ package: "com.example.app" }), {
      id: 4,
      type: "system",
      layer: 2,
      frame: { x: 0, y: 0, width: 400, height: 40 },
    });
    expect(describeWindows([window(node()), banner], SCREEN)).toHaveLength(2);
  });
});

describe("text that repeats a description", () => {
  it("keeps a child whose text is only part of a word in the description", () => {
    const [app] = describeWindows(
      [
        window(
          node({
            contentDescription: "Inbox, 3 unread",
            children: [node({ class: "android.widget.TextView", text: "3" })],
          }),
        ),
      ],
      SCREEN,
    );
    expect(app!.children.map((child) => child.AXLabel)).toEqual(["3"]);
  });

  it("drops a child that repeats one comma-separated part of the description", () => {
    const [app] = describeWindows(
      [
        window(
          node({
            contentDescription: "Inbox, 3 unread",
            children: [node({ class: "android.widget.TextView", text: "3 unread" })],
          }),
        ),
      ],
      SCREEN,
    );
    expect(app!.children).toEqual([]);
  });
});
