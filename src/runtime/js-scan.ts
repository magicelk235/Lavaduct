// A small JavaScript scanner: brace matching and string/template/comment/regex
// skipping. It imports nothing, so input/stage.ts can use it without pulling in
// shim.ts and paths.ts, which persist's bundle must never reach.

/**
 * Lexing walk shared by matchBalanced and pushArrayElementCount so the two
 * can never disagree about what is code. Invokes onCode(c, i) for every character
 * outside string/template/comment/regex content. Template literals get full
 * `${…}` handling: interpolations re-enter code mode, nested templates included
 * (MetaMask's 1MB chunk 6078 nests templates two deep).
 * Returns the index where onCode returned true, else -1 (end of input reached,
 * or an unterminated construct). `onLiteral(i)`, when given, hears the index of
 * each string literal's opening quote and each code-level template's backtick.
 */
export function walkCode(src: string, start: number, onCode: (c: string, i: number) => boolean, onLiteral?: (i: number) => void): number {
  // Context stack: "T" = inside template-literal text; a number = inside a `${}`
  // interpolation, holding its open-brace count so the matching "}" hands control
  // back to the surrounding template text instead of being reported as code.
  const stack: Array<"T" | number> = [];
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    const top = stack.length ? stack[stack.length - 1] : undefined;
    if (top === "T") {
      if (c === "\\") { i++; continue; }
      if (c === "`") { stack.pop(); continue; }
      if (c === "$" && src[i + 1] === "{") { stack.push(0); i++; continue; }
      continue;
    }
    if (c === "`") { onLiteral?.(i); stack.push("T"); continue; }
    if (typeof top === "number") {
      if (c === "}") {
        if (top === 0) { stack.pop(); continue; } // closes the ${ — resume template text
        stack[stack.length - 1] = top - 1;
      } else if (c === "{") {
        stack[stack.length - 1] = top + 1;
      }
    }
    if (c === '"' || c === "'") {
      onLiteral?.(i);
      // skip the string literal
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === c) break;
        i++;
      }
      continue;
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      // Always a comment: a regex literal's first body char can never be `/` or `*`
      // (RegularExpressionFirstChar excludes both), so `//` and `/*` are comments
      // regardless of expression position.
      if (src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        if (nl < 0) return -1;
        i = nl;
      } else {
        const close = src.indexOf("*/", i + 2);
        if (close < 0) return -1;
        i = close + 1;
      }
      continue;
    }
    if (c === "/" && startsRegexAt(src, i, start)) {
      // A regex literal whose body doesn't start with `/`/`*` (e.g. /\//, /a-z/).
      i = skipRegex(src, i);
      if (i < 0) return -1;
      continue;
    }
    if (onCode(c, i)) return i;
  }
  return -1;
}

/**
 * Given the index of an opening "(", "[" or "{" in `src`, return the index just
 * PAST its matching closer, honoring nesting and skipping string/template/comment/
 * regex content (see walkCode). Returns -1 if no balanced close is found. A closer
 * inside a template interpolation still counts — interpolations are code.
 */
export function matchBalanced(src: string, open: number): number {
  const opener = src[open];
  const closer = opener === "(" ? ")" : opener === "[" ? "]" : "}";
  let depth = 0;
  const at = walkCode(src, open, (c) => {
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return true;
    }
    return false;
  });
  return at < 0 ? -1 : at + 1;
}

/** matchBalancedParen for a "{" (a block, an object, or the brace of a `${`). */
export function matchBalancedBrace(src: string, open: number): number {
  let depth = 0;
  const at = walkCode(src, open, (c) => {
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return true;
    }
    return false;
  });
  return at < 0 ? -1 : at + 1;
}

/** Indexes of every string literal's opening quote and every template's opening backtick. */
export function literalStarts(src: string): Set<number> {
  const starts = new Set<number>();
  walkCode(src, 0, () => false, (i) => starts.add(i));
  return starts;
}

// Keywords a regex literal can directly follow (`return/,/.test(x)` is how terser
// emits it). An identifier ending just before the `/` that ISN'T one of these means
// division (`n / 2`).
const REGEX_PRECEDING_KEYWORDS: Record<string, true> = {
  return: true, typeof: true, instanceof: true, in: true, of: true, new: true, delete: true,
  void: true, throw: true, case: true, do: true, else: true, yield: true, await: true,
};

// Does the `/` at src[slashIdx] begin a regex literal (vs division)? Looks back at
// the previous significant char: operators/openers/commas can't end a value, so a
// regex follows; an identifier char means division UNLESS the whole word is a
// keyword like `return`. Conservative: when unsure, treats `/` as division.
function startsRegexAt(src: string, slashIdx: number, floor: number): boolean {
  let j = slashIdx - 1;
  while (j >= floor && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j--;
  if (j < floor) return true; // expression start
  const c = src[j];
  if ("(,=:[!&|?{};+-*%^~<>".indexOf(c) >= 0) return true;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= floor && /[A-Za-z0-9_$]/.test(src[k])) k--;
    // A word matching a keyword is only the keyword when it's NOT a member name:
    // `o.return / 2` is division (property `return`), not `return /regex/`. Look
    // past whitespace before the word — a `.` (dot or `?.`) means member access.
    let d = k;
    while (d >= floor && (src[d] === " " || src[d] === "\t" || src[d] === "\n" || src[d] === "\r")) d--;
    if (src[d] === ".") return false;
    return Object.hasOwn(REGEX_PRECEDING_KEYWORDS, src.slice(k + 1, j + 1));
  }
  return false;
}

// Given index `start` at the opening `/` of a regex literal, return the index of its
// closing `/`, honoring `\` escapes and `[...]` character classes (where `/` is not a
// delimiter). Returns -1 if unterminated.
function skipRegex(src: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return i;
    else if (ch === "\n") return -1;
  }
  return -1;
}
