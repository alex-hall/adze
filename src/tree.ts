/**
 * Turns the device server's raw window dump into `describe-ui`'s output:
 * accessibility elements with `AXLabel`, `AXUniqueId`, `AXValue` and `frame`,
 * the keys iOS accessibility tooling uses, so harnesses written for iOS read
 * Android trees unchanged.
 */

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One node as the device server reports it. */
export interface AndroidNode {
  class?: string | null;
  package?: string | null;
  frame: Frame;
  visible: boolean;
  enabled: boolean;
  resourceId?: string;
  text?: string;
  contentDescription?: string;
  hint?: string;
  stateDescription?: string;
  roleDescription?: string;
  showingHint?: boolean;
  clickable?: boolean;
  longClickable?: boolean;
  checkable?: boolean;
  checked?: boolean;
  selected?: boolean;
  focused?: boolean;
  editable?: boolean;
  password?: boolean;
  scrollable?: boolean;
  children?: AndroidNode[];
}

export type AndroidWindowType =
  | "application"
  | "input-method"
  | "system"
  | "accessibility-overlay"
  | "split-screen-divider"
  | "magnification-overlay"
  | "unknown";

export interface AndroidWindow {
  id: number;
  type: AndroidWindowType;
  layer: number;
  active: boolean;
  focused: boolean;
  frame: Frame;
  title?: string;
  root: AndroidNode;
}

export interface ScreenSize {
  widthDp: number;
  heightDp: number;
}

/** One element of `describe-ui`'s output, plus Android detail. */
export interface UiElement {
  AXLabel: string | null;
  AXUniqueId: string | null;
  AXValue: string | null;
  AXFrame: string;
  frame: Frame;
  type: string;
  role: string;
  role_description: string;
  subrole: null;
  title: string | null;
  help: string | null;
  enabled: boolean;
  /** False for elements a tap can't reach: scrolled off screen, or under another window. */
  visible: boolean;
  traits: string[];
  custom_actions: string[];
  content_required: boolean;
  pid: null;
  children: UiElement[];
  /** What Android itself reported for this node. */
  android: {
    class: string | null;
    package: string | null;
    resourceId?: string;
    text?: string;
    contentDescription?: string;
    checked?: boolean;
    selected?: boolean;
    focused?: boolean;
    clickable?: boolean;
    scrollable?: boolean;
    windowType?: AndroidWindowType;
    windowTitle?: string;
  };
}

export interface DescribeOptions {
  /** Include every window, status and navigation bars too. Default false. */
  allWindows?: boolean;
}

/**
 * The windows `describe-ui` reports, back to front, each as one top-level
 * element: apps, dialogs, the keyboard and system sheets. The status and
 * navigation bars are left out (unless `allWindows`): on iOS they are not
 * part of the app's tree either, and their clock and signal icons would only
 * add ambiguous matches.
 */
export function describeWindows(
  windows: readonly AndroidWindow[],
  screen: ScreenSize,
  options: DescribeOptions = {},
): UiElement[] {
  const backToFront = [...windows].sort(
    (left, right) => left.layer - right.layer,
  );
  return backToFront
    .filter((window) => options.allWindows || !isSystemBar(window, screen))
    .map((window) => {
      const element = describeWindow(window);
      markCovered(element, coveringFrames(window, backToFront), screen);
      return element;
    });
}

/**
 * Frames of the windows drawn over this one — the keyboard, a dialog, the
 * system bars (even when they're left out of the output) — which take
 * every touch aimed at what lies beneath them.
 */
function coveringFrames(
  window: AndroidWindow,
  backToFront: readonly AndroidWindow[],
): Frame[] {
  return backToFront
    .filter(
      (other) =>
        other.layer > window.layer &&
        other.type !== "accessibility-overlay" &&
        other.type !== "magnification-overlay",
    )
    .map((other) => other.frame);
}

/**
 * Android reports an element under the keyboard or a dialog as visible:
 * visibility is decided per window. A tap there lands on whatever covers
 * it, so an element whose tap point is covered is reported not visible —
 * what iOS reports for an element under a sheet.
 */
function markCovered(
  element: UiElement,
  covering: readonly Frame[],
  screen: ScreenSize,
) {
  if (covering.length === 0) return;
  const visit = (current: UiElement) => {
    if (current.visible) {
      const point = onScreenCenter(current.frame, screen);
      if (
        !point ||
        covering.some((frame) => contains(frame, point.x, point.y))
      ) {
        current.visible = false;
      }
    }
    current.children.forEach(visit);
  };
  visit(element);
}

/** The center of the part of a frame that is on screen, if any part is. */
export function onScreenCenter(
  frame: Frame,
  screen: ScreenSize,
): { x: number; y: number } | undefined {
  const left = Math.max(frame.x, 0);
  const top = Math.max(frame.y, 0);
  const right = Math.min(frame.x + frame.width, screen.widthDp);
  const bottom = Math.min(frame.y + frame.height, screen.heightDp);
  if (right <= left || bottom <= top) return undefined;
  return { x: round((left + right) / 2), y: round((top + bottom) / 2) };
}

export const contains = (frame: Frame, x: number, y: number): boolean =>
  x >= frame.x &&
  x < frame.x + frame.width &&
  y >= frame.y &&
  y < frame.y + frame.height;

const round = (value: number): number => Math.round(value * 100) / 100;

function describeWindow(window: AndroidWindow): UiElement {
  const root = describeNode(window.root);
  root.android.windowType = window.type;
  if (window.title) root.android.windowTitle = window.title;
  if (window.type === "application") {
    // An app's top-level element is the application, labelled with its name.
    return {
      ...root,
      type: "Application",
      role: "AXApplication",
      role_description: "application",
      AXLabel: root.AXLabel ?? window.title ?? null,
    };
  }
  return root;
}

const SYSTEM_BAR_MAX_FRACTION = 0.15;

/**
 * A System UI window that is a thin strip along one edge of the screen:
 * the status bar, or the navigation bar — along the bottom in portrait,
 * down a side in landscape. Windows don't carry reliable titles, so it's
 * judged by shape. A heads-up notification grows the status bar window past
 * thin, so it stays in the tree.
 */
function isSystemBar(window: AndroidWindow, screen: ScreenSize): boolean {
  if (window.type !== "system" || window.root.package !== SYSTEM_UI_PACKAGE)
    return false;
  const { x, y, width, height } = window.frame;
  const edge = 0.5;
  const horizontalStrip =
    height <= screen.heightDp * SYSTEM_BAR_MAX_FRACTION &&
    (y <= edge || y + height >= screen.heightDp - edge);
  const verticalStrip =
    width <= screen.widthDp * SYSTEM_BAR_MAX_FRACTION &&
    (x <= edge || x + width >= screen.widthDp - edge);
  return horizontalStrip || verticalStrip;
}

const SYSTEM_UI_PACKAGE = "com.android.systemui";

/**
 * An element with a content description speaks for its subtree: TalkBack
 * reads the description, not the text inside, and on iOS the equivalent
 * accessible element hides its children from the tree entirely. Android
 * still reports those children, so a button described "Sign in" arrives
 * with a "Sign in" text child, and every label lookup turns ambiguous.
 * Drop descendants that only repeat the description: plain text, without
 * an ID, not tappable themselves, with nothing kept beneath them.
 */
function withoutEchoes(node: AndroidNode): AndroidNode {
  const spoken = node.contentDescription;
  if (!nonEmpty(spoken) || !node.children) return node;
  const prune = (children: readonly AndroidNode[]): AndroidNode[] =>
    children.flatMap((child) => {
      const kept = child.children ? prune(child.children) : [];
      const echoed = child.contentDescription ?? child.text;
      const isEcho =
        child.resourceId === undefined &&
        !child.clickable &&
        !child.editable &&
        !child.checkable &&
        kept.length === 0 &&
        nonEmpty(echoed) &&
        repeats(spoken!, echoed!);
      if (isEcho) return [];
      return [{ ...child, ...(child.children && { children: kept }) }];
    });
  return { ...node, children: prune(node.children) };
}

/**
 * Whether a child's text only repeats its parent's description: the whole
 * of it, or one of the comma-separated parts a joined description is made
 * of ("Alice, 2 unread"). A mere substring doesn't count — a "3" badge
 * inside "Inbox, 3 unread" is its own element.
 */
const repeats = (description: string, text: string): boolean =>
  description === text ||
  description.split(/,\s*/).some((part) => part === text);

export function describeNode(raw: AndroidNode): UiElement {
  const node = withoutEchoes(raw);
  const role = roleFor(node);
  const element: UiElement = {
    AXLabel: labelFor(node),
    AXUniqueId: node.resourceId ?? null,
    AXValue: valueFor(node),
    AXFrame: axFrame(node.frame),
    frame: node.frame,
    type: role.type,
    role: role.role,
    role_description: role.description,
    subrole: null,
    title: null,
    help: node.editable ? null : (node.hint ?? null),
    enabled: node.enabled,
    visible: node.visible,
    traits: [],
    custom_actions: [],
    content_required: false,
    pid: null,
    children: (node.children ?? []).map(describeNode),
    android: {
      class: node.class ?? null,
      package: node.package ?? null,
      ...(node.resourceId !== undefined && { resourceId: node.resourceId }),
      ...(node.text !== undefined && { text: node.text }),
      ...(node.contentDescription !== undefined && {
        contentDescription: node.contentDescription,
      }),
      ...(node.checkable && { checked: node.checked ?? false }),
      ...(node.selected && { selected: true }),
      ...(node.focused && { focused: true }),
      ...(node.clickable && { clickable: true }),
      ...(node.scrollable && { scrollable: true }),
    },
  };
  return element;
}

/**
 * iOS gives a control one spoken label; Android splits it between the
 * content description (what a screen reader announces) and the visible
 * text. The description wins, as it does for TalkBack. A text field's own
 * text is its value, never its label — its label is the description or the
 * placeholder, as with an iOS text field.
 */
function labelFor(node: AndroidNode): string | null {
  if (nonEmpty(node.contentDescription)) return node.contentDescription!;
  if (node.editable) return nonEmpty(node.hint) ? node.hint! : null;
  if (nonEmpty(node.text)) return node.text!;
  return null;
}

/**
 * A toggle's value is "1" or "0", as iOS accessibility reports switches. A text field's
 * value is its text, but null while it only shows its hint.
 */
function valueFor(node: AndroidNode): string | null {
  if (node.checkable) return node.checked ? "1" : "0";
  if (node.editable) {
    if (node.showingHint || !nonEmpty(node.text)) return null;
    return node.text!;
  }
  if (nonEmpty(node.stateDescription)) return node.stateDescription!;
  return null;
}

interface Role {
  type: string;
  role: string;
  description: string;
}

const role = (type: string, description: string): Role => ({
  type,
  role: `AX${type}`,
  description,
});

const BUTTON = role("Button", "button");
const STATIC_TEXT = role("StaticText", "text");
const TEXT_FIELD = role("TextField", "text field");
const SECURE_TEXT_FIELD = role("SecureTextField", "secure text field");
const SWITCH = role("Switch", "switch");
const CHECK_BOX = role("CheckBox", "checkbox");
const RADIO_BUTTON = role("RadioButton", "radio button");
const IMAGE = role("Image", "image");
const SLIDER = role("Slider", "slider");
const PROGRESS = role("ProgressIndicator", "progress indicator");
const SCROLL_VIEW = role("ScrollView", "scroll view");
const TAB = role("Tab", "tab");
const LINK = role("Link", "link");
const HEADING = role("Heading", "heading");
const GROUP = role("Group", "group");

/** Android widget class → element role. Checked by simple class name. */
const CLASS_ROLES: Record<string, Role> = {
  Button: BUTTON,
  ImageButton: BUTTON,
  TextView: STATIC_TEXT,
  EditText: TEXT_FIELD,
  AutoCompleteTextView: TEXT_FIELD,
  Switch: SWITCH,
  SwitchCompat: SWITCH,
  ToggleButton: SWITCH,
  CheckBox: CHECK_BOX,
  CheckedTextView: CHECK_BOX,
  RadioButton: RADIO_BUTTON,
  ImageView: IMAGE,
  SeekBar: SLIDER,
  ProgressBar: PROGRESS,
  ScrollView: SCROLL_VIEW,
  HorizontalScrollView: SCROLL_VIEW,
  RecyclerView: SCROLL_VIEW,
  ListView: SCROLL_VIEW,
  GridView: SCROLL_VIEW,
  ViewPager: SCROLL_VIEW,
  TabWidget: TAB,
};

/** React Native and Compose announce some roles only as a role description. */
const DESCRIPTION_ROLES: Record<string, Role> = {
  button: BUTTON,
  tab: TAB,
  link: LINK,
  header: HEADING,
  heading: HEADING,
  switch: SWITCH,
  checkbox: CHECK_BOX,
  "check box": CHECK_BOX,
  "radio button": RADIO_BUTTON,
  image: IMAGE,
  slider: SLIDER,
};

function roleFor(node: AndroidNode): Role {
  const described = node.roleDescription?.trim().toLowerCase();
  if (described && DESCRIPTION_ROLES[described])
    return DESCRIPTION_ROLES[described];
  if (node.editable) return node.password ? SECURE_TEXT_FIELD : TEXT_FIELD;
  const simpleName = node.class?.split(".").pop() ?? "";
  return CLASS_ROLES[simpleName] ?? GROUP;
}

const axFrame = ({ x, y, width, height }: Frame): string =>
  `{{${x}, ${y}}, {${width}, ${height}}}`;

const nonEmpty = (value: string | undefined): boolean =>
  value !== undefined && value.length > 0;

/** Every element of a forest, depth first, parents before children. */
export function flatten(elements: readonly UiElement[]): UiElement[] {
  const out: UiElement[] = [];
  const visit = (element: UiElement) => {
    out.push(element);
    element.children.forEach(visit);
  };
  elements.forEach(visit);
  return out;
}
