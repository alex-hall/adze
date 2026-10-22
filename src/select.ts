import {
  contains,
  flatten,
  onScreenCenter,
  type AxeElement,
  type ScreenSize,
} from "./tree.js";

export type SelectorKind = "id" | "label" | "value";

export interface Selector {
  kind: SelectorKind;
  text: string;
  /** Narrows matches to one AXe type (`Button`, `TextField`, ...), case-insensitively. */
  elementType?: string;
}

const FLAG_FOR: Record<SelectorKind, string> = {
  id: "--id",
  label: "--label",
  value: "--value",
};

/** No element matched; the message keeps AXe's wording, which callers match on. */
export class NoMatchError extends Error {
  constructor(selector: Selector) {
    super(
      `No accessibility element matched ${describeSelector(selector)}. ` +
        "Make sure the app is on the expected screen, then run " +
        "`adze describe-ui --serial <SERIAL>` and prefer --id when available.",
    );
    this.name = "NoMatchError";
  }
}

export class AmbiguousMatchError extends Error {
  constructor(selector: Selector, count: number) {
    super(
      `${count} accessibility elements matched ${describeSelector(selector)}. ` +
        "Narrow it with --element-type, or target an --id.",
    );
    this.name = "AmbiguousMatchError";
  }
}

export class OffScreenMatchError extends Error {
  constructor(selector: Selector) {
    super(
      `The element matching ${describeSelector(selector)} is off screen. ` +
        "Scroll it into view first.",
    );
    this.name = "OffScreenMatchError";
  }
}

const describeSelector = (selector: Selector): string =>
  `${FLAG_FOR[selector.kind]} '${selector.text}'` +
  (selector.elementType ? ` --element-type '${selector.elementType}'` : "");

/**
 * Finds the single element a selector names. Exact matches only, as in AXe.
 * Matches Android reports off screen (scrolled-away rows) don't count
 * toward ambiguity: one visible match is the target. Only when every match
 * is off screen does selection fail, saying so instead of "no match".
 */
export function selectElement(
  elements: readonly AxeElement[],
  selector: Selector,
): AxeElement {
  const matches = flatten(elements).filter((element) =>
    matchesSelector(element, selector),
  );
  const visible = matches.filter((element) => element.visible);
  if (visible.length === 1) return visible[0]!;
  if (visible.length > 1)
    throw new AmbiguousMatchError(selector, visible.length);
  if (matches.length > 0) throw new OffScreenMatchError(selector);
  throw new NoMatchError(selector);
}

function matchesSelector(element: AxeElement, selector: Selector): boolean {
  if (
    selector.elementType &&
    element.type.toLowerCase() !== selector.elementType.toLowerCase()
  ) {
    return false;
  }
  switch (selector.kind) {
    case "id":
      return element.AXUniqueId === selector.text;
    case "label":
      return element.AXLabel === selector.text;
    case "value":
      return element.AXValue === selector.text;
  }
}

/**
 * Where to touch an element: the center of the part of it that is on
 * screen. A row half under the bottom edge is tapped on its visible half.
 */
export function activationPoint(
  element: AxeElement,
  screen: ScreenSize,
): { x: number; y: number } {
  return (
    onScreenCenter(element.frame, screen) ?? {
      x: element.frame.x + element.frame.width / 2,
      y: element.frame.y + element.frame.height / 2,
    }
  );
}

/**
 * The deepest visible element whose frame contains the point — what
 * `describe-ui --point` reports. Later siblings and later windows are drawn
 * on top, so they win ties. A covered parent doesn't hide an uncovered
 * child.
 */
export function elementAt(
  elements: readonly AxeElement[],
  x: number,
  y: number,
): AxeElement | undefined {
  let found: AxeElement | undefined;
  const visit = (element: AxeElement) => {
    if (!contains(element.frame, x, y)) return;
    if (element.visible) found = element;
    element.children.forEach(visit);
  };
  elements.forEach(visit);
  return found;
}
