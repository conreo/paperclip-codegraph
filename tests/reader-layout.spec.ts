import { describe, expect, it } from "vitest";

import {
  MIN_SOURCE_WIDTH,
  PANE_WIDTH,
  panesAreColumns,
  readerLayout,
  showsSidePanes,
} from "../src/ui/reader-layout.js";

/** Width at which three panes exactly fit. */
const THREE = PANE_WIDTH * 2 + MIN_SOURCE_WIDTH + 32;
/** Width at which two panes exactly fit, and three panes exactly fit. */
const TWO = PANE_WIDTH + MIN_SOURCE_WIDTH + 32;
const STACKING = Math.ceil(TWO);

describe("readerLayout", () => {
  it("uses three panes on a wide page", () => {
    expect(readerLayout(1600)).toBe("three-pane");
    expect(readerLayout(THREE)).toBe("three-pane");
  });

  it("drops to two panes before the columns get too thin to read", () => {
    // One pixel under the three-pane threshold is the boundary that matters: the
    // source column is what suffers first, and a squeezed code column wraps every
    // line.
    expect(readerLayout(THREE - 1)).toBe("two-pane");
    expect(readerLayout(STACKING)).toBe("two-pane");
  });

  it("stacks on a narrow column", () => {
    // The case that motivated this: a plugin page inside a pinned-sidebar layout
    // is narrow even on a large monitor.
    expect(readerLayout(STACKING - 1)).toBe("stacked");
    expect(readerLayout(700)).toBe("two-pane"); // still room for a pane + source
    expect(readerLayout(320)).toBe("stacked");
  });

  it("never claims three panes for an unmeasured container", () => {
    // Width is 0 on the first render. Returning the widest layout would render
    // three columns and then jump, so the safe middle is chosen instead.
    expect(readerLayout(0)).toBe("two-pane");
    expect(readerLayout(-10)).toBe("two-pane");
    expect(readerLayout(Number.NaN)).toBe("two-pane");
    expect(readerLayout(Number.POSITIVE_INFINITY)).toBe("two-pane");
  });

  it("keeps the source column above its minimum in the layouts that show it", () => {
    // The invariant behind the thresholds: whatever layout is chosen, the source
    // must have at least MIN_SOURCE_WIDTH once the panes are subtracted.
    for (let width = THREE; width <= 2000; width += 7) {
      const layout = readerLayout(width);
      const panes = layout === "three-pane" ? 2 : layout === "two-pane" ? 1 : 0;
      const source = width - 32 - panes * PANE_WIDTH;
      expect(source, `source too narrow at ${width} (${layout})`).toBeGreaterThanOrEqual(
        MIN_SOURCE_WIDTH,
      );
    }
  });

  it("reports pane placement consistently with the layout", () => {
    expect(panesAreColumns("three-pane")).toBe(true);
    expect(panesAreColumns("two-pane")).toBe(false);
    expect(showsSidePanes("stacked")).toBe(false);
    expect(showsSidePanes("two-pane")).toBe(true);
  });
});
