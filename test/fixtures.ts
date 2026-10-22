import type { AndroidNode, AndroidWindow, Frame } from "../src/tree.js";

/** A 400×800 dp phone. */
export const SCREEN = { widthDp: 400, heightDp: 800, sdk: 35, density: 2.5 };

const frame = (x: number, y: number, width: number, height: number): Frame => ({
  x,
  y,
  width,
  height,
});

export const node = (overrides: Partial<AndroidNode> = {}): AndroidNode => ({
  class: "android.view.ViewGroup",
  package: "com.example.app",
  frame: frame(0, 0, 400, 800),
  visible: true,
  enabled: true,
  ...overrides,
});

export const window = (
  root: AndroidNode,
  overrides: Partial<AndroidWindow> = {},
): AndroidWindow => ({
  id: 1,
  type: "application",
  layer: 1,
  active: true,
  focused: true,
  frame: frame(0, 0, 400, 800),
  title: "Example App",
  root,
  ...overrides,
});

/** A sign-in screen for Alice, with the status and navigation bars around it. */
export function signInScreen(): AndroidWindow[] {
  const app = node({
    children: [
      node({
        class: "android.widget.TextView",
        text: "Welcome, Alice",
        frame: frame(20, 100, 360, 40),
      }),
      node({
        class: "android.widget.EditText",
        resourceId: "email-field",
        hint: "Email",
        text: "Email",
        showingHint: true,
        editable: true,
        focused: true,
        frame: frame(20, 200, 360, 48),
      }),
      node({
        class: "android.widget.EditText",
        resourceId: "password-field",
        hint: "Password",
        text: "••••",
        editable: true,
        password: true,
        frame: frame(20, 260, 360, 48),
      }),
      node({
        class: "android.widget.Switch",
        text: "Remember me",
        checkable: true,
        checked: true,
        clickable: true,
        frame: frame(20, 320, 360, 40),
      }),
      node({
        class: "android.widget.Button",
        resourceId: "sign-in",
        contentDescription: "Sign in",
        clickable: true,
        frame: frame(20, 700, 360, 56),
        children: [
          node({
            class: "android.widget.TextView",
            text: "Sign in",
            frame: frame(150, 715, 100, 24),
          }),
        ],
      }),
    ],
  });
  return [
    window(
      node({ package: "com.android.systemui", frame: frame(0, 0, 400, 24) }),
      {
        id: 2,
        type: "system",
        layer: 3,
        frame: frame(0, 0, 400, 24),
        title: "Status bar",
      },
    ),
    window(app),
    window(
      node({ package: "com.android.systemui", frame: frame(0, 776, 400, 24) }),
      {
        id: 3,
        type: "system",
        layer: 2,
        frame: frame(0, 776, 400, 24),
        title: "Navigation bar",
      },
    ),
  ];
}

/** A list of messages from Bob, two of them scrolled above the top of the screen. */
export function messageList(): AndroidWindow[] {
  const row = (index: number, y: number) =>
    node({
      class: "android.widget.TextView",
      resourceId: `message-${index}`,
      text: `Hi Alice, message ${index}`,
      visible: y >= 0,
      frame: frame(0, y, 400, 60),
    });
  return [
    window(
      node({
        class: "androidx.recyclerview.widget.RecyclerView",
        scrollable: true,
        children: [
          row(1, -120),
          row(2, -60),
          row(3, 0),
          row(4, 60),
          row(5, 770),
        ],
      }),
    ),
  ];
}
