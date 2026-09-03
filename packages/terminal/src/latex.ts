import { cellWidth } from "./internal-unicode.js";

const MAX_LATEX_SOURCE_LENGTH = 16_384;
const MAX_LATEX_DEPTH = 32;

const SYMBOLS = new Map<string, string>([
  ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["epsilon", "ε"],
  ["varepsilon", "ϵ"], ["zeta", "ζ"], ["eta", "η"], ["theta", "θ"], ["vartheta", "ϑ"],
  ["iota", "ι"], ["kappa", "κ"], ["lambda", "λ"], ["mu", "μ"], ["nu", "ν"], ["xi", "ξ"],
  ["omicron", "ο"], ["pi", "π"], ["varpi", "ϖ"], ["rho", "ρ"], ["varrho", "ϱ"],
  ["sigma", "σ"], ["varsigma", "ς"], ["tau", "τ"], ["upsilon", "υ"], ["phi", "φ"],
  ["varphi", "ϕ"], ["chi", "χ"], ["psi", "ψ"], ["omega", "ω"],
  ["digamma", "ϝ"], ["varkappa", "ϰ"], ["varbeta", "ϐ"], ["backepsilon", "϶"], ["varTheta", "ϴ"],
  ["Gamma", "Γ"], ["Delta", "Δ"], ["Theta", "Θ"], ["Lambda", "Λ"], ["Xi", "Ξ"],
  ["Pi", "Π"], ["Sigma", "Σ"], ["Upsilon", "Υ"], ["Phi", "Φ"], ["Psi", "Ψ"], ["Omega", "Ω"],
  ["infty", "∞"], ["partial", "∂"], ["nabla", "∇"], ["ell", "ℓ"], ["hbar", "ℏ"],
  ["imath", "ı"], ["jmath", "ȷ"], ["Re", "ℜ"], ["Im", "ℑ"], ["aleph", "ℵ"],
  ["forall", "∀"], ["exists", "∃"], ["nexists", "∄"], ["neg", "¬"], ["lnot", "¬"],
  ["land", "∧"], ["wedge", "∧"], ["lor", "∨"], ["vee", "∨"], ["oplus", "⊕"],
  ["otimes", "⊗"], ["cap", "∩"], ["cup", "∪"], ["setminus", "∖"], ["emptyset", "∅"],
  ["varnothing", "∅"], ["in", "∈"], ["notin", "∉"], ["ni", "∋"], ["subset", "⊂"],
  ["supset", "⊃"], ["subseteq", "⊆"], ["supseteq", "⊇"], ["sqsubseteq", "⊑"], ["sqsupseteq", "⊒"],
  ["le", "≤"], ["leq", "≤"], ["ge", "≥"], ["geq", "≥"], ["neq", "≠"], ["ne", "≠"],
  ["equiv", "≡"], ["approx", "≈"], ["sim", "∼"], ["simeq", "≃"], ["cong", "≅"],
  ["propto", "∝"], ["ll", "≪"], ["gg", "≫"], ["perp", "⊥"], ["parallel", "∥"],
  ["to", "→"], ["rightarrow", "→"], ["leftarrow", "←"], ["leftrightarrow", "↔"],
  ["Rightarrow", "⇒"], ["Leftarrow", "⇐"], ["Leftrightarrow", "⇔"], ["mapsto", "↦"],
  ["uparrow", "↑"], ["downarrow", "↓"], ["updownarrow", "↕"],
  ["longrightarrow", "⟶"], ["longleftarrow", "⟵"], ["longleftrightarrow", "⟷"],
  ["Longrightarrow", "⟹"], ["Longleftarrow", "⟸"], ["Longleftrightarrow", "⟺"],
  ["sum", "∑"], ["prod", "∏"], ["coprod", "∐"], ["int", "∫"], ["iint", "∬"],
  ["iiint", "∭"], ["oint", "∮"], ["bigcap", "⋂"], ["bigcup", "⋃"],
  ["times", "×"], ["div", "÷"], ["pm", "±"], ["mp", "∓"], ["cdot", "·"],
  ["circ", "∘"], ["bullet", "•"], ["star", "⋆"], ["ast", "∗"], ["ldots", "…"],
  ["cdots", "⋯"], ["vdots", "⋮"], ["ddots", "⋱"], ["therefore", "∴"], ["because", "∵"],
  ["angle", "∠"], ["degree", "°"], ["prime", "′"], ["dagger", "†"], ["ddagger", "‡"],
  ["langle", "⟨"], ["rangle", "⟩"], ["lceil", "⌈"], ["rceil", "⌉"],
  ["lfloor", "⌊"], ["rfloor", "⌋"], ["lvert", "|"], ["rvert", "|"],
  ["mid", "∣"], ["nmid", "∤"], ["vdash", "⊢"], ["dashv", "⊣"], ["models", "⊨"],
  ["prec", "≺"], ["succ", "≻"], ["preceq", "⪯"], ["succeq", "⪰"],
]);

const FUNCTIONS = new Set([
  "arccos", "arcsin", "arctan", "arg", "cos", "cosh", "cot", "coth", "csc", "deg", "det",
  "dim", "exp", "gcd", "hom", "inf", "ker", "lg", "lim", "liminf", "limsup", "ln", "log",
  "max", "min", "mod", "Pr", "sec", "sin", "sinh", "sup", "tan", "tanh",
]);

const WRAPPERS = new Set([
  "emph", "mathcal", "mathfrak", "mathrm", "operatorname", "text", "textbf", "textit", "textrm",
  "textsf", "texttt", "mbox",
]);

const MATH_ALPHABETS = new Map<string, MathAlphabet>([
  ["boldsymbol", "bold"], ["mathbf", "bold"], ["mathbb", "blackboard"], ["mathit", "italic"],
  ["mathsf", "sans"], ["mathtt", "monospace"],
]);

const IGNORED = new Set([
  "big", "Big", "bigg", "Bigg", "bigl", "Bigl", "biggl", "Biggl", "bigr", "Bigr", "biggr", "Biggr",
  "displaystyle", "left", "limits", "nolimits", "right", "scriptstyle", "scriptscriptstyle", "textstyle",
]);

const ACCENTS = new Map<string, string>([
  ["acute", "\u0301"], ["bar", "\u0304"], ["breve", "\u0306"], ["check", "\u030C"],
  ["ddot", "\u0308"], ["dot", "\u0307"], ["grave", "\u0300"], ["hat", "\u0302"],
  ["overline", "\u0305"], ["tilde", "\u0303"], ["vec", "\u20D7"],
]);

const WIDE_ACCENTS = new Map<string, string>([
  ["widehat", "\u0302"], ["widetilde", "\u0303"], ["underline", "\u0332"],
]);

const TRAILING_ACCENTS = new Map<string, string>([
  ["overleftarrow", "\u20D6"], ["overleftrightarrow", "\u20E1"], ["overrightarrow", "\u20D7"],
]);

type MathAlphabet = "blackboard" | "bold" | "italic" | "monospace" | "sans";

const BLACKBOARD_EXCEPTIONS = new Map([
  ["C", "ℂ"], ["H", "ℍ"], ["N", "ℕ"], ["P", "ℙ"], ["Q", "ℚ"], ["R", "ℝ"], ["Z", "ℤ"],
]);

const MATRIX_WRAPPERS = new Map<string, readonly [string, string]>([
  ["Bmatrix", ["{", "}"]], ["Vmatrix", ["‖", "‖"]], ["bmatrix", ["[", "]"]],
  ["pmatrix", ["(", ")"]], ["vmatrix", ["|", "|"]],
]);

const SUPERSCRIPT = new Map<string, string>(Object.entries({
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ",
  f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ",
  r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
}));

const SUBSCRIPT = new Map<string, string>(Object.entries({
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ",
  k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
  β: "ᵦ", γ: "ᵧ", ρ: "ᵨ", φ: "ᵩ", χ: "ᵪ",
}));

export interface RenderLatexOptions {
  display?: boolean;
}

class LatexParser {
  #index = 0;
  #depth = 0;

  constructor(
    private readonly source: string,
    private readonly displayMode: boolean,
  ) {}

  parse(): string {
    const value = this.#sequence();
    if (this.#index !== this.source.length) throw new Error("Unexpected LaTeX suffix");
    return value;
  }

  #sequence(stop?: string): string {
    let output = "";
    while (this.#index < this.source.length) {
      const character = this.source[this.#index]!;
      if (character === stop) break;
      if (character === "}") throw new Error("Unexpected closing group");
      if (character === "{") output += this.#group();
      else if (character === "\\") output += this.#command();
      else if (character === "^" || character === "_") output += this.#script(character === "^");
      else if (character === "%") this.#comment();
      else if (character === "$" || character === "&") throw new Error("Unexpected math delimiter");
      else { output += character; this.#index += 1; }
    }
    return output;
  }

  #group(): string {
    if (this.source[this.#index] !== "{" || this.#depth >= MAX_LATEX_DEPTH) throw new Error("Invalid LaTeX group");
    this.#index += 1;
    this.#depth += 1;
    const value = this.#sequence("}");
    this.#depth -= 1;
    if (this.source[this.#index] !== "}") throw new Error("Unclosed LaTeX group");
    this.#index += 1;
    return value;
  }

  #requiredGroup(): string {
    this.#skipWhitespace();
    if (this.source[this.#index] !== "{") throw new Error("Missing LaTeX argument");
    return this.#group();
  }

  #rawGroup(): string {
    this.#skipWhitespace();
    if (this.source[this.#index] !== "{") throw new Error("Missing LaTeX argument");
    const start = ++this.#index;
    const end = this.source.indexOf("}", start);
    if (end < 0 || this.source.slice(start, end).includes("{")) throw new Error("Invalid LaTeX argument");
    this.#index = end + 1;
    return this.source.slice(start, end);
  }

  #command(): string {
    this.#index += 1;
    const character = this.source[this.#index];
    if (character === undefined) throw new Error("Incomplete LaTeX command");
    if (!/[A-Za-z]/u.test(character)) {
      this.#index += 1;
      if (character === "\\") return this.displayMode ? "\n" : " ";
      if ([",", ";", ":", " "].includes(character)) return " ";
      if (character === "!") return "";
      if (["{", "}", "_", "%", "$", "&", "#"].includes(character)) return character;
      throw new Error("Unsupported LaTeX escape");
    }

    const start = this.#index;
    while (/[A-Za-z]/u.test(this.source[this.#index] ?? "")) this.#index += 1;
    const name = this.source.slice(start, this.#index);
    const symbol = SYMBOLS.get(name);
    if (symbol !== undefined) return symbol;
    if (FUNCTIONS.has(name)) return name;
    if (IGNORED.has(name)) return "";
    if (name === "operatorname" && this.source[this.#index] === "*") this.#index += 1;
    if (WRAPPERS.has(name)) return this.#requiredGroup();
    const alphabet = MATH_ALPHABETS.get(name);
    if (alphabet !== undefined) return mathAlphabet(this.#requiredGroup(), alphabet);
    if (name === "not") return this.#negated();
    if (name === "binom" || name === "dbinom" || name === "tbinom") {
      return `C(${this.#requiredGroup()}, ${this.#requiredGroup()})`;
    }
    if (name === "bmod") return "mod";
    if (name === "pmod") return `(mod ${this.#requiredGroup()})`;
    if (name === "overset" || name === "stackrel") {
      const above = this.#requiredGroup();
      return `${this.#requiredGroup()}${scriptValue(above, true)}`;
    }
    if (name === "underset") {
      const below = this.#requiredGroup();
      return `${this.#requiredGroup()}${scriptValue(below, false)}`;
    }
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const numerator = this.#requiredGroup();
      const denominator = this.#requiredGroup();
      return `${fractionPart(numerator)}/${fractionPart(denominator)}`;
    }
    if (name === "sqrt") {
      this.#skipWhitespace();
      let degree: string | undefined;
      if (this.source[this.#index] === "[") {
        const end = this.source.indexOf("]", this.#index + 1);
        if (end < 0) throw new Error("Unclosed root degree");
        degree = this.source.slice(this.#index + 1, end).trim();
        this.#index = end + 1;
      }
      const value = this.#requiredGroup();
      const root = degree === undefined || degree === "2" ? "√" : degree === "3" ? "∛" : degree === "4" ? "∜" : `${scriptValue(degree, true)}√`;
      return `${root}(${value})`;
    }
    const accent = ACCENTS.get(name);
    if (accent !== undefined) return `${this.#requiredGroup()}${accent}`.normalize("NFC");
    const wideAccent = WIDE_ACCENTS.get(name);
    if (wideAccent !== undefined) return decorateEach(this.#requiredGroup(), wideAccent);
    const trailingAccent = TRAILING_ACCENTS.get(name);
    if (trailingAccent !== undefined) return `${this.#requiredGroup()}${trailingAccent}`.normalize("NFC");
    if (name === "begin") return this.#environment();
    throw new Error("Unsupported LaTeX command");
  }

  #negated(): string {
    this.#skipWhitespace();
    let value: string;
    if (this.source[this.#index] === "\\") value = this.#command();
    else {
      value = this.source[this.#index] ?? "";
      this.#index += 1;
    }
    if (value === "") throw new Error("Missing negated relation");
    return new Map([
      ["=", "≠"], ["<", "≮"], [">", "≯"], ["≤", "≰"], ["≥", "≱"], ["≡", "≢"],
      ["∈", "∉"], ["∋", "∌"], ["⊂", "⊄"], ["⊃", "⊅"], ["⊆", "⊈"], ["⊇", "⊉"], ["∼", "≁"],
    ]).get(value) ?? `${value}\u0338`.normalize("NFC");
  }

  #environment(): string {
    const name = this.#rawGroup();
    const aligned = ["align", "align*", "aligned", "alignedat", "gather", "gather*", "gathered", "split"];
    const matrices = ["array", "matrix", "matrix*", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix"];
    const cases = ["cases", "dcases"];
    if (![...aligned, ...matrices, ...cases, "equation", "equation*", "displaymath"].includes(name)) {
      throw new Error("Unsupported LaTeX environment");
    }
    if (name === "alignedat" || name === "array") this.#rawGroup();
    const closing = `\\end{${name}}`;
    const end = this.source.indexOf(closing, this.#index);
    if (end < 0) throw new Error("Unclosed LaTeX environment");
    const body = this.source.slice(this.#index, end);
    this.#index = end + closing.length;
    if (["equation", "equation*", "displaymath"].includes(name)) return new LatexParser(body, this.displayMode).parse();
    const rows = splitEnvironmentRows(body).map((row) => splitEnvironmentCells(row)
      .map((cell) => normalizeLatexOutput(new LatexParser(cell, false).parse(), false))
      .filter((cell) => cell !== ""))
      .filter((row) => row.length > 0);
    if (cases.includes(name)) return formatCases(rows, this.displayMode);
    if (matrices.includes(name)) return formatMatrix(rows, name, this.displayMode);
    const selected = rows.map((row) => row.join(" "));
    return this.displayMode ? selected.join("\n") : selected.join("; ");
  }

  #script(superscript: boolean): string {
    this.#index += 1;
    this.#skipWhitespace();
    let value: string;
    if (this.source[this.#index] === "{") value = this.#group();
    else if (this.source[this.#index] === "\\") value = this.#command();
    else {
      value = this.source[this.#index] ?? "";
      this.#index += 1;
    }
    if (value === "") throw new Error("Missing LaTeX script");
    return scriptValue(value, superscript);
  }

  #comment(): void {
    const end = this.source.indexOf("\n", this.#index);
    this.#index = end < 0 ? this.source.length : end;
  }

  #skipWhitespace(): void {
    while (/\s/u.test(this.source[this.#index] ?? "")) this.#index += 1;
  }
}

function splitEnvironmentRows(source: string): string[] {
  const rows: string[] = [];
  let current = "";
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\" && source[index + 1] === "\\") {
      rows.push(current);
      current = "";
      index += 1;
    } else current += source[index];
  }
  rows.push(current);
  return rows;
}

function splitEnvironmentCells(source: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\\" && source[index + 1] === "&") { current += "\\&"; index += 1; }
    else if (source[index] === "&") { cells.push(current); current = ""; }
    else current += source[index];
  }
  cells.push(current);
  return cells;
}

function decorateEach(source: string, accent: string): string {
  return Array.from(source, (character) => /\s/u.test(character) ? character : `${character}${accent}`).join("").normalize("NFC");
}

function mathAlphabet(source: string, alphabet: MathAlphabet): string {
  return Array.from(source, (character) => {
    const blackboardException = BLACKBOARD_EXCEPTIONS.get(character);
    if (alphabet === "blackboard" && blackboardException !== undefined) return blackboardException;
    const code = character.codePointAt(0)!;
    if (code >= 0x41 && code <= 0x5a) {
      const starts = { blackboard: 0x1d538, bold: 0x1d400, italic: 0x1d434, monospace: 0x1d670, sans: 0x1d5a0 };
      return String.fromCodePoint(starts[alphabet] + code - 0x41);
    }
    if (code >= 0x61 && code <= 0x7a) {
      if (alphabet === "italic" && character === "h") return "ℎ";
      const starts = { blackboard: 0x1d552, bold: 0x1d41a, italic: 0x1d44e, monospace: 0x1d68a, sans: 0x1d5ba };
      return String.fromCodePoint(starts[alphabet] + code - 0x61);
    }
    if (code >= 0x30 && code <= 0x39 && alphabet !== "italic") {
      const starts = { blackboard: 0x1d7d8, bold: 0x1d7ce, monospace: 0x1d7f6, sans: 0x1d7e2 };
      return String.fromCodePoint(starts[alphabet] + code - 0x30);
    }
    return character;
  }).join("");
}

function formatMatrix(rows: string[][], name: string, displayMode: boolean): string {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) => Math.max(0, ...rows.map((row) => cellWidth(row[column] ?? ""))));
  const content = rows.map((row) => row.map((cell, column) =>
    `${cell}${" ".repeat(Math.max(0, widths[column]! - cellWidth(cell)))}`).join("  ").trimEnd());
  const wrapper = MATRIX_WRAPPERS.get(name);
  const lines = wrapper === undefined ? content : content.map((row) => `${wrapper[0]} ${row} ${wrapper[1]}`);
  return displayMode ? lines.join("\n") : lines.join("; ");
}

function formatCases(rows: string[][], displayMode: boolean): string {
  const content = rows.map((row) => row.join("  "));
  if (!displayMode) return `{ ${content.join("; ")}`;
  return content.map((row, index) => {
    const brace = content.length === 1 ? "{" : index === 0 ? "⎧" : index === content.length - 1 ? "⎩" : "⎨";
    return `${brace} ${row}`;
  }).join("\n");
}

interface RawArgument {
  end: number;
  source: string;
}

function rawArgumentAt(source: string, offset: number): RawArgument | undefined {
  let index = offset;
  while (/\s/u.test(source[index] ?? "")) index += 1;
  if (source[index] === "{") {
    const start = index + 1;
    let depth = 1;
    for (index = start; index < source.length; index += 1) {
      if (source[index] === "\\") { index += 1; continue; }
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}" && --depth === 0) return { end: index + 1, source: source.slice(start, index) };
      if (depth > MAX_LATEX_DEPTH) return undefined;
    }
    return undefined;
  }
  if (source[index] === "\\") {
    const match = /^\\[A-Za-z]+/u.exec(source.slice(index));
    if (match === null) return undefined;
    return { end: index + match[0].length, source: match[0] };
  }
  return source[index] === undefined ? undefined : { end: index + 1, source: source[index]! };
}

function parseFragment(source: string): string {
  return normalizeLatexOutput(new LatexParser(source, false).parse(), false);
}

function displayFraction(source: string): string | undefined {
  const command = /^\\(?:dfrac|frac|tfrac)\b/u.exec(source);
  if (command === null) return undefined;
  const numerator = rawArgumentAt(source, command[0].length);
  const denominator = numerator === undefined ? undefined : rawArgumentAt(source, numerator.end);
  if (numerator === undefined || denominator === undefined || source.slice(denominator.end).trim() !== "") return undefined;
  const above = parseFragment(numerator.source);
  const below = parseFragment(denominator.source);
  const width = Math.max(1, cellWidth(above), cellWidth(below));
  return `${above}\n${"─".repeat(width)}\n${below}`;
}

function displayLargeOperator(source: string): string | undefined {
  const command = /^\\(bigcap|bigcup|coprod|iint|iiint|int|oint|prod|sum)(?![A-Za-z])/u.exec(source);
  if (command === null) return undefined;
  let index = command[0].length;
  const limitCommand = /^\s*\\(?:limits|nolimits)\b/u.exec(source.slice(index));
  if (limitCommand !== null) index += limitCommand[0].length;
  let above: string | undefined;
  let below: string | undefined;
  for (let count = 0; count < 2; count += 1) {
    while (/\s/u.test(source[index] ?? "")) index += 1;
    const marker = source[index];
    if (marker !== "^" && marker !== "_") break;
    const argument = rawArgumentAt(source, index + 1);
    if (argument === undefined) return undefined;
    if (marker === "^") above = parseFragment(argument.source);
    else below = parseFragment(argument.source);
    index = argument.end;
  }
  if (above === undefined && below === undefined) return undefined;
  const bodySource = source.slice(index).trim();
  const body = bodySource === "" ? "" : parseFragment(bodySource);
  const operator = SYMBOLS.get(command[1]!)!;
  return [above, `${operator}${body === "" ? "" : ` ${body}`}`, below].filter((line) => line !== undefined).join("\n");
}

function scriptValue(source: string, superscript: boolean): string {
  const mapping = superscript ? SUPERSCRIPT : SUBSCRIPT;
  let output = "";
  for (const character of source) {
    const selected = mapping.get(character);
    if (selected === undefined) return `${superscript ? "⁽" : "₍"}${source}${superscript ? "⁾" : "₎"}`;
    output += selected;
  }
  return output;
}

function fractionPart(source: string): string {
  return /[\s+\-*/=<>]/u.test(source) ? `(${source})` : source;
}

function stripOuterDelimiters(source: string): string {
  const selected = source.trim();
  for (const [open, close] of [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]] as const) {
    if (selected.length > open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
      return selected.slice(open.length, -close.length).trim();
    }
  }
  return selected;
}

function normalizeLatexOutput(source: string, displayMode: boolean): string {
  const rows = source.split(/\r?\n/u).map((row) => {
    const expanded = row.replace(/\t/gu, " ");
    return (displayMode ? expanded : expanded.replace(/ +/gu, " ")).trim();
  }).filter((row) => row !== "");
  return (displayMode ? rows.join("\n") : rows.join(" ")).normalize("NFC");
}

function hasUnsafeControl(source: string): boolean {
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (
      code <= 0x08
      || code >= 0x0b && code <= 0x1f
      || code >= 0x7f && code <= 0x9f
    ) return true;
  }
  return false;
}

/** @internal Used by the Markdown component to distinguish conversion failure from unchanged output. */
export function renderLatexOrUndefined(source: string, options: RenderLatexOptions = {}): string | undefined {
  if (source.length === 0 || source.length > MAX_LATEX_SOURCE_LENGTH || hasUnsafeControl(source)) return undefined;
  try {
    const selected = stripOuterDelimiters(source);
    if (selected === "") return undefined;
    if (options.display === true) {
      const structured = displayFraction(selected) ?? displayLargeOperator(selected);
      if (structured !== undefined) return structured.length > MAX_LATEX_SOURCE_LENGTH * 4 ? undefined : structured;
    }
    const rendered = normalizeLatexOutput(new LatexParser(selected, options.display === true).parse(), options.display === true);
    return rendered === "" || rendered.length > MAX_LATEX_SOURCE_LENGTH * 4 ? undefined : rendered;
  } catch {
    return undefined;
  }
}

export function renderLatex(source: string, options: RenderLatexOptions = {}): string | undefined {
  return renderLatexOrUndefined(source, options);
}
