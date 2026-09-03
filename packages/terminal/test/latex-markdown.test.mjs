import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Marked, Markdown } from "../dist/components/markdown.js";
import { renderLatex } from "../dist/latex.js";

const identityTheme = {
  heading: (value) => value,
  link: (value) => value,
  linkUrl: (value) => value,
  code: (value) => value,
  codeBlock: (value) => value,
  codeBlockBorder: (value) => value,
  quote: (value) => value,
  quoteBorder: (value) => value,
  hr: (value) => value,
  listBullet: (value) => value,
  bold: (value) => value,
  italic: (value) => value,
  strikethrough: (value) => value,
  underline: (value) => value,
};

describe("Markdown parser access", () => {
  it("exposes an independently configurable parser", () => {
    const parser = new Marked({ gfm: true });
    assert.equal(parser.parseInline("**strong**"), "<strong>strong</strong>");
  });
});

describe("terminal LaTeX rendering", () => {
  it("renders common symbols, groups, fractions, roots, and scripts", () => {
    assert.equal(
      renderLatex(String.raw`\alpha + \beta \leq \frac{x^2}{\sqrt{y_1}}`),
      "α + β ≤ x²/√(y₁)",
    );
    assert.equal(
      renderLatex(String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`),
      "∑ᵢ₌₁ⁿ i = (n(n+1))/2",
    );
  });

  it("renders aligned display math as terminal rows", () => {
    assert.equal(
      renderLatex(String.raw`\begin{aligned} a &= b \\ c &= d \end{aligned}`, { display: true }),
      "a = b\nc = d",
    );
  });

  it("renders common structural commands and math alphabets", () => {
    assert.equal(
      renderLatex(String.raw`\mathbb{R} \subseteq \mathbf{A} \not\in \mathit{x}`),
      "ℝ ⊆ 𝐀 ∉ 𝑥",
    );
    assert.equal(
      renderLatex(String.raw`\binom{n}{k} \bmod m \pmod{q} \overset{f}{\to} \underset{x}{=}`),
      "C(n, k) mod m (mod q) →ᶠ =ₓ",
    );
    assert.equal(renderLatex(String.raw`\widehat{AB} \overrightarrow{xy}`), "ÂB̂ xy⃗");
    assert.equal(
      renderLatex(String.raw`\operatorname*{arg max}_{x} f(x) \stackrel{!}{=} \overleftrightarrow{AB}`),
      "arg maxₓ f(x) =⁽!⁾ AB⃡",
    );
    assert.equal(renderLatex(String.raw`\sum\limits_{i=1}^{n} i`), "∑ᵢ₌₁ⁿ i");
  });

  it("lays out standalone display fractions, matrices, and cases", () => {
    assert.equal(renderLatex(String.raw`\frac{a+b}{c}`, { display: true }), "a+b\n───\nc");
    assert.equal(renderLatex(String.raw`\frac{界}{a}`, { display: true }), "界\n──\na");
    assert.equal(
      renderLatex(String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`, { display: true }),
      "( a  b )\n( c  d )",
    );
    assert.equal(
      renderLatex(String.raw`\begin{cases} x^2 & x \ge 0 \\ -x & x < 0 \end{cases}`, { display: true }),
      "⎧ x²  x ≥ 0\n⎩ -x  x < 0",
    );
    assert.equal(renderLatex(String.raw`\sum_{i=1}^{n} i`, { display: true }), "n\n∑ i\ni=1");
    assert.equal(
      renderLatex(String.raw`\begin{split} x &= 1 \\ y &= 2 \end{split}`, { display: true }),
      "x = 1\ny = 2",
    );
    assert.equal(
      renderLatex(String.raw`\begin{matrix} \mathbf{A} & a \\ 界 & b \\ x & c \end{matrix}`, { display: true }),
      "𝐀   a\n界  b\nx   c",
    );
  });

  it("returns unsupported or malformed input unchanged", () => {
    for (const source of [
      String.raw`\futurecommand{x}`,
      String.raw`\frac{x}{`,
      "x\u0000y",
      "x\ry",
      "x\u0085y",
      "x\u009by",
      "x".repeat(16_385),
    ]) {
      assert.equal(renderLatex(source), undefined);
    }
  });
});

describe("Markdown math", () => {
  it("renders dollar delimiters by default", () => {
    const source = String.raw`Euler: $e^{i\pi} + 1 = 0$.

$$\sum_{i=1}^{n} i$$`;
    assert.deepEqual(
      new Markdown(source, 0, 0, identityTheme).render(80).map((line) => line.trimEnd()),
      ["Euler: e⁽iπ⁾ + 1 = 0.", "", "n", "∑ i", "i=1"],
    );
  });

  it("renders parenthesized and bracketed delimiters by default", () => {
    const source = String.raw`Inline \(x^2 + y^2\).

\[\frac{a+b}{c}\]`;
    assert.deepEqual(
      new Markdown(source, 0, 0, identityTheme).render(80).map((line) => line.trimEnd()),
      ["Inline x² + y².", "", "a+b", "───", "c"],
    );
  });

  it("preserves currency, shell variables, escapes, code, and unsupported text", () => {
    const source = "Price $5$, code `$x^2$`, escaped \\$7, unknown $\\futurecommand{x}$.";
    assert.deepEqual(
      new Markdown(source, 0, 0, identityTheme, undefined, { renderLatex: false }).render(100).map((line) => line.trimEnd()),
      [String.raw`Price $5$, code $x^2$, escaped $7, unknown $\futurecommand{x}$.`],
    );
    assert.deepEqual(
      new Markdown(source, 0, 0, identityTheme).render(100).map((line) => line.trimEnd()),
      [String.raw`Price $5$, code $x^2$, escaped $7, unknown $\futurecommand{x}$.`],
    );
    const ordinary = String.raw`Range $5-$10, variables $HOME:$USER, incomplete \(x+1, literal \$x.`;
    assert.deepEqual(
      new Markdown(ordinary, 0, 0, identityTheme).render(100).map((line) => line.trimEnd()),
      [String.raw`Range $5-$10, variables $HOME:$USER, incomplete \(x+1, literal $x.`],
    );
    const shellPaths = "$foo/$bar and Use $src/$dst";
    assert.deepEqual(
      new Markdown(shellPaths, 0, 0, identityTheme).render(100).map((line) => line.trimEnd()),
      [shellPaths],
    );
    const bracedShellPath = "Path ${foo}/${bar}; powers $x^2$; grouped ${x}/{y}$.";
    assert.deepEqual(
      new Markdown(bracedShellPath, 0, 0, identityTheme).render(100).map((line) => line.trimEnd()),
      ["Path ${foo}/${bar}; powers x²; grouped x/y."],
    );
    const protectedSource = "Escaped \\\\(x\\\\), incomplete \\[x+1, and:\n\n```math\n$x^2$\n```";
    const protectedOutput = new Markdown(protectedSource, 0, 0, identityTheme).render(100).map((line) => line.trimEnd());
    assert.equal(protectedOutput[0], String.raw`Escaped \(x\), incomplete \[x+1, and:`);
    assert.equal(protectedOutput.includes("  $x^2$"), true);
  });
});
