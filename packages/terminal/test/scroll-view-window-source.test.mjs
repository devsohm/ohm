import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ScrollView,
  VIEWPORT_WINDOW_SOURCE,
  isViewportWindowSource,
  stripAnsi,
} from "../dist/index.js";

function plainRows(rows) {
  return rows.map((row) => stripAnsi(row).trimEnd());
}

class WindowRows {
  [VIEWPORT_WINDOW_SOURCE] = true;
  fullRenders = 0;
  countWidths = [];
  windows = [];

  constructor(rowCount) {
    this.rowCount = rowCount;
  }

  render() {
    this.fullRenders += 1;
    throw new Error("full render must not be used");
  }

  viewportRowCount(width) {
    this.countWidths.push(width);
    return Number.isSafeInteger(this.rowCount) ? this.rowCount : this.rowCount(width);
  }

  renderViewportRows(width, startRow, height, requestRender) {
    this.windows.push({ width, startRow, height, requestRender });
    return Array.from({ length: height }, (_, offset) => `row ${startRow + offset}`);
  }

  invalidate() {}
}

describe("ScrollView window sources", () => {
  it("renders only the requested rows and maintains follow and scroll metrics", () => {
    const source = new WindowRows(1_000_000);
    const view = new ScrollView(source, { follow: "end", overscroll: "chain" });
    const requestRender = () => {};

    assert.deepEqual(
      plainRows(view.renderViewport(20, 4, requestRender)),
      ["row 999996", "row 999997", "row 999998", "row 999999"],
    );
    assert.equal(source.fullRenders, 0);
    assert.deepEqual(source.windows, [{ width: 20, startRow: 999_996, height: 4, requestRender }]);
    assert.equal(view.contentRows, 1_000_000);
    assert.equal(view.viewportRows, 4);
    assert.equal(view.maxScrollTop, 999_996);
    assert.equal(view.scrollTop, 999_996);

    assert.equal(view.scrollBy(-3), 0);
    assert.equal(view.isFollowingEnd, false);
    assert.deepEqual(
      plainRows(view.renderViewport(20, 4, requestRender)),
      ["row 999993", "row 999994", "row 999995", "row 999996"],
    );

    source.rowCount = 1_000_010;
    view.scrollToEnd();
    assert.deepEqual(
      plainRows(view.renderViewport(20, 4, requestRender)),
      ["row 1000006", "row 1000007", "row 1000008", "row 1000009"],
    );
    assert.equal(view.maxScrollTop, 1_000_006);
    assert.equal(source.fullRenders, 0);
  });

  it("remeasures row count when width changes", () => {
    const source = new WindowRows((width) => width < 8 ? 12 : 5);
    const view = new ScrollView(source, { follow: "end" });

    assert.deepEqual(plainRows(view.renderViewport(6, 3)), ["row 9", "row 10", "row 11"]);
    assert.equal(view.scrollTop, 9);
    assert.deepEqual(plainRows(view.renderViewport(8, 3)), ["row 2", "row 3", "row 4"]);
    assert.equal(view.scrollTop, 2);
    assert.deepEqual(source.countWidths, [6, 8]);
    assert.deepEqual(
      source.windows.map(({ width, startRow, height }) => ({ width, startRow, height })),
      [
        { width: 6, startRow: 9, height: 3 },
        { width: 8, startRow: 2, height: 3 },
      ],
    );
  });

  it("preserves the ordinary component path and image clipping guard", () => {
    const renders = [];
    const ordinary = {
      render(width) { renders.push(width); return ["zero", "one", "two"]; },
      invalidate() {},
    };
    const view = new ScrollView(ordinary);
    assert.equal(isViewportWindowSource(ordinary), false);
    assert.deepEqual(plainRows(view.renderViewport(6, 2)), ["zero", "one"]);
    assert.deepEqual(renders, [6]);

    const imageSource = new WindowRows(1);
    imageSource.renderViewportRows = () => ["\x1b_Ga=T,f=100,c=1,r=1;AAAA\x1b\\"];
    assert.equal(isViewportWindowSource(imageSource), true);
    assert.throws(
      () => new ScrollView(imageSource).renderViewport(6, 1),
      /Terminal image rows are not supported/u,
    );
    assert.equal(imageSource.fullRenders, 0);
  });
});
