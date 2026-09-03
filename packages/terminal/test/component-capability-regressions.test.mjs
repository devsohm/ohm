import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Image,
  ScrollView,
  SelectList,
  SettingsList,
  encodeITerm2,
  resetCapabilitiesCache,
  setCapabilities,
  stripAnsi,
  visibleWidth,
} from "../dist/index.js";

class Lines {
  constructor(lines) { this.lines = lines; }
  render(width) { return this.lines.map((line) => line.slice(0, width)); }
  invalidate() {}
}

const selectTheme = {
  selectedPrefix: (value) => value,
  selectedText: (value) => value,
  description: (value) => value,
  scrollInfo: (value) => value,
  noMatch: (value) => value,
};

const settingsTheme = {
  label: (value) => value,
  value: (value) => value,
  description: (value) => value,
  cursor: "> ",
  hint: (value) => value,
};

describe("extended component controls", () => {
  it("scrolls to an arbitrary row and can suppress follow-at-end", () => {
    const content = new Lines(["zero", "one", "two", "three", "four", "five"]);
    const view = new ScrollView(content, { follow: "end" });

    view.renderViewport(8, 2);
    assert.equal(view.scrollTop, 4);

    view.scrollTo(2);
    assert.equal(view.scrollTop, 2);
    assert.equal(view.isFollowingEnd, false);

    view.scrollTo(999, { disableFollow: true });
    assert.equal(view.scrollTop, 4);
    assert.equal(view.isFollowingEnd, false);
    content.lines.push("six");
    view.renderViewport(8, 2);
    assert.equal(view.scrollTop, 4);
    assert.equal(view.isFollowingEnd, false);
  });

  it("changes scrollbar layout at runtime and applies a bounded custom style", () => {
    const widths = [];
    const child = {
      render(width) {
        widths.push(width);
        return ["one", "two", "three"];
      },
      invalidate() {},
    };
    const view = new ScrollView(child, {
      scrollbar: "never",
      scrollbarStyle: () => "#",
    });

    assert.equal(view.getContentWidth(6), 6);
    view.setScrollbar("always");
    assert.equal(view.scrollbar, "always");
    assert.equal(view.getContentWidth(6), 5);
    const rows = view.renderViewport(6, 2);
    assert.deepEqual(widths, [5]);
    assert.equal(rows.some((row) => stripAnsi(row).endsWith("#")), true);
    assert.equal(rows.every((row) => visibleWidth(row) === 6), true);

    view.setScrollbar("hidden");
    assert.equal(view.scrollbar, "hidden");
    assert.equal(view.getContentWidth(6), 6);
    assert.equal(view.isScrollbarVisible, false);
    view.dispose();
  });

  it("filters select lists programmatically and bounds primary-column hooks", () => {
    const contexts = [];
    const list = new SelectList([
      { value: "alpha", label: "A", description: "first" },
      { value: "beta", label: "Beta", description: "second" },
    ], 2, selectTheme, {
      enableSearch: true,
      minPrimaryColumnWidth: 5,
      maxPrimaryColumnWidth: 5,
      truncatePrimary(context) {
        contexts.push(context);
        return `${context.text.slice(0, Math.max(0, context.maxWidth - 1))}~`;
      },
    });

    list.setFilter("beta");
    assert.equal(list.getSelectedItem()?.value, "beta");
    const row = stripAnsi(list.render(20)[0]);
    assert.match(row, /^> Beta~\s{2}second$/u);
    assert.equal(visibleWidth(row), 15);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].text, "Beta");
    assert.equal(contexts[0].maxWidth, 5);
    assert.equal(contexts[0].columnWidth, 5);
    assert.equal(contexts[0].isSelected, true);
    assert.equal(contexts[0].width, 5);
    assert.equal(contexts[0].selected, true);

    list.setFilter("");
    const aligned = list.render(20).map(stripAnsi);
    assert.equal(aligned[0].indexOf("first"), aligned[1].indexOf("second"));
  });

  it("updates and selects settings programmatically", () => {
    const changes = [];
    const settings = new SettingsList([
      { id: "one", label: "One", currentValue: "off", values: ["off", "on"] },
      { id: "two", label: "Two", currentValue: "cold" },
      { id: "three", label: "Three", currentValue: "old" },
    ], 2, settingsTheme, (id, value) => changes.push([id, value]), () => {});

    settings.updateValue("three", "new");
    settings.selectItem("three");
    const rows = settings.render(30).map(stripAnsi);
    assert.equal(rows.some((row) => row.startsWith("> Three: new")), true);

    settings.selectItem("one");
    settings.updateValue("one", "on");
    settings.handleInput("\r");
    assert.deepEqual(changes, [["one", "off"]]);
  });

  it("opens settings submenus, delegates input, applies results, and navigates after close", () => {
    const changes = [];
    const received = [];
    let finish;
    let openedWith;
    let nextOpened = 0;
    const submenu = {
      render: () => ["submenu"],
      handleInput: (data) => received.push(data),
      invalidate() {},
    };
    const settings = new SettingsList([
      {
        id: "mode",
        label: "Mode",
        currentValue: "basic",
        submenu(currentValue, done) {
          openedWith = currentValue;
          finish = done;
          return submenu;
        },
      },
      {
        id: "next",
        label: "Next",
        currentValue: "ready",
        submenu() {
          nextOpened += 1;
          return { render: () => ["next submenu"], invalidate() {} };
        },
      },
    ], 2, settingsTheme, (id, value) => changes.push([id, value]), () => {});

    settings.handleInput("\r");
    assert.equal(openedWith, "basic");
    assert.deepEqual(settings.render(20), ["submenu"]);
    settings.handleInput("x");
    assert.deepEqual(received, ["x"]);

    finish("advanced", { navigateTo: "next" });
    assert.deepEqual(changes, [["mode", "advanced"]]);
    assert.equal(nextOpened, 1);
    assert.deepEqual(settings.render(30), ["next submenu"]);
  });

  it("does not reopen a synchronous submenu when its navigation target is filtered out", () => {
    let opened = 0;
    const settings = new SettingsList([
      {
        id: "visible",
        label: "Visible",
        currentValue: "ready",
        submenu(_currentValue, done) {
          opened += 1;
          done(undefined, { navigateTo: "hidden" });
          return { render: () => ["completed"], invalidate() {} };
        },
      },
      { id: "hidden", label: "Hidden", currentValue: "ready", values: ["ready"] },
    ], 2, settingsTheme, () => {}, () => {}, { enableSearch: true });

    for (const character of "Visible") settings.handleInput(character);
    settings.handleInput("\r");

    assert.equal(opened, 1);
    assert.match(stripAnsi(settings.render(30)[0]), /^> Visible: ready/u);
  });

  it("bounds synchronous settings submenu navigation cycles", () => {
    const openings = [];
    const component = { render: () => ["submenu"], invalidate() {} };
    const settings = new SettingsList([
      {
        id: "a",
        label: "A",
        currentValue: "one",
        submenu(_currentValue, done) {
          openings.push("a");
          done(undefined, { navigateTo: "b" });
          return component;
        },
      },
      {
        id: "b",
        label: "B",
        currentValue: "two",
        submenu(_currentValue, done) {
          openings.push("b");
          done(undefined, { navigateTo: "a" });
          return component;
        },
      },
    ], 2, settingsTheme, () => {}, () => {});

    assert.doesNotThrow(() => settings.handleInput("\r"));
    assert.deepEqual(openings, ["a", "b"]);

    let sameTargetOpenings = 0;
    const sameTarget = new SettingsList([{
      id: "same",
      label: "Same",
      currentValue: "value",
      submenu(_currentValue, done) {
        sameTargetOpenings += 1;
        done(undefined, { navigateTo: "same" });
        return component;
      },
    }], 1, settingsTheme, () => {}, () => {});
    assert.doesNotThrow(() => sameTarget.handleInput("\r"));
    assert.equal(sameTargetOpenings, 1);
  });
});

describe("image identity and sizing flags", () => {
  it("retains the allocated image id across Kitty renders", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    try {
      const image = new Image(
        "AAAA",
        "image/png",
        { fallbackColor: (value) => value },
        {},
        { widthPx: 9, heightPx: 18 },
      );
      assert.equal(image.getImageId(), undefined);
      const first = image.render(8)[0];
      const id = image.getImageId();
      assert.equal(Number.isSafeInteger(id), true);
      assert.match(first, new RegExp(`(?:^|,)i=${id}(?:,|;)`, "u"));
      assert.match(image.render(8)[0], new RegExp(`(?:^|,)i=${id}(?:,|;)`, "u"));
    } finally {
      resetCapabilitiesCache();
    }
  });

  it("can request stretched iTerm images without changing the default encoding", () => {
    const stretched = encodeITerm2("AAAA", { columns: 2, rows: 3, preserveAspectRatio: false });
    const natural = encodeITerm2("AAAA", { columns: 2, rows: 3, preserveAspectRatio: true });
    assert.match(stretched, /;preserveAspectRatio=0:/u);
    assert.doesNotMatch(natural, /preserveAspectRatio/u);

    setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
    try {
      const image = new Image(
        "AAAA",
        "image/png",
        { fallbackColor: (value) => value },
        { preserveAspectRatio: false },
        { widthPx: 18, heightPx: 36 },
      );
      assert.match(image.render(8).join(""), /;preserveAspectRatio=0:/u);
      assert.equal(image.getImageId(), undefined);
    } finally {
      resetCapabilitiesCache();
    }
  });
});
