// A small, safe expression language for template configs: no eval, no Function.
// Source → tokens → Pratt parser → a tree of closures, compiled once and evaluated per frame.
//
//   numbers 1, .5, 2e-3 · names (params, template variables) · 'strings'
//   + − * / % ^ (right-assoc) · unary − + ! · < <= > >= == != · && || · c ? a : b
//   calls f(a, b) · indexing a[i] (vectors, matrix rows)
//   constants pi, tau, e, inf, true, false
//
// Pure TypeScript: imported by the app and by the Node pipeline (validation).

export type Value = number | string | Value[];

/** Variables and functions visible to an expression. Functions are called with evaluated arguments. */
export type Env = Record<string, Value | ((...args: Value[]) => Value) | undefined>;

export class ExprError extends Error {}

type Node = (env: Env) => Value;

export interface Compiled {
  (env: Env): Value;
  source: string;
  /** Names read as variables (not called). */
  names: Set<string>;
  /** Names called as functions. */
  calls: Set<string>;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export function num(v: Value | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? NaN : Number(v);
  return NaN;
}

const truthy = (v: Value) => (typeof v === "number" ? v !== 0 && !Number.isNaN(v) : typeof v === "string" ? v.length > 0 : v.length > 0);

const nums = (args: Value[]): number[] => args.flatMap((a) => (Array.isArray(a) ? a.flat(Infinity as 1) : [a])).map((a) => num(a as Value));

export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  tau: 2 * Math.PI,
  e: Math.E,
  inf: Infinity,
  true: 1,
  false: 0,
};

type Fn = { fn: (...a: Value[]) => Value; arity: [number, number] };
const f1 = (g: (x: number) => number): Fn => ({ fn: (a) => g(num(a)), arity: [1, 1] });

/** Built-in functions (templates add their own through the Env). */
export const FUNCTIONS: Record<string, Fn> = {
  sin: f1(Math.sin),
  cos: f1(Math.cos),
  tan: f1(Math.tan),
  asin: f1(Math.asin),
  acos: f1(Math.acos),
  atan: f1(Math.atan),
  sinh: f1(Math.sinh),
  cosh: f1(Math.cosh),
  tanh: f1(Math.tanh),
  exp: f1(Math.exp),
  ln: f1(Math.log),
  log: f1(Math.log),
  log2: f1(Math.log2),
  log10: f1(Math.log10),
  sqrt: f1(Math.sqrt),
  cbrt: f1(Math.cbrt),
  abs: f1(Math.abs),
  sign: f1(Math.sign),
  floor: f1(Math.floor),
  ceil: f1(Math.ceil),
  round: { fn: (x, d) => (d === undefined ? Math.round(num(x)) : Math.round(num(x) * 10 ** num(d)) / 10 ** num(d)), arity: [1, 2] },
  trunc: f1(Math.trunc),
  fact: f1((n) => {
    let r = 1;
    for (let i = 2; i <= Math.min(170, Math.floor(n)); i++) r *= i;
    return n < 0 ? NaN : r;
  }),
  choose: {
    fn: (n, k) => {
      const N = num(n);
      const K = num(k);
      if (K < 0 || K > N) return 0;
      let r = 1;
      for (let i = 1; i <= K; i++) r = (r * (N - K + i)) / i;
      return Math.round(r);
    },
    arity: [2, 2],
  },
  atan2: { fn: (y, x) => Math.atan2(num(y), num(x)), arity: [2, 2] },
  pow: { fn: (a, b) => num(a) ** num(b), arity: [2, 2] },
  hypot: { fn: (...a) => Math.hypot(...nums(a)), arity: [1, 99] },
  min: { fn: (...a) => Math.min(...nums(a)), arity: [1, 99] },
  max: { fn: (...a) => Math.max(...nums(a)), arity: [1, 99] },
  sum: { fn: (...a) => nums(a).reduce((s, x) => s + x, 0), arity: [1, 99] },
  mean: { fn: (...a) => ((xs) => xs.reduce((s, x) => s + x, 0) / xs.length)(nums(a)), arity: [1, 99] },
  clamp: { fn: (x, lo, hi) => Math.min(num(hi), Math.max(num(lo), num(x))), arity: [3, 3] },
  lerp: { fn: (a, b, t) => num(a) + (num(b) - num(a)) * num(t), arity: [3, 3] },
  step: f1((x) => (x >= 0 ? 1 : 0)),
  mod: { fn: (a, b) => ((num(a) % num(b)) + num(b)) % num(b), arity: [2, 2] },
  deg: f1((r) => (r * 180) / Math.PI),
  rad: f1((d) => (d * Math.PI) / 180),
  len: { fn: (a) => (Array.isArray(a) ? a.length : typeof a === "string" ? a.length : 1), arity: [1, 1] },
};

/** Special forms: arguments are evaluated lazily. */
const SPECIAL = new Set(["if", "repeat"]);

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Tok =
  | { t: "num"; v: number; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "name"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "end"; at: number };

const OPS = ["<=", ">=", "==", "!=", "&&", "||", "**", "+", "-", "*", "/", "%", "^", "<", ">", "!", "?", ":", "(", ")", ",", "[", "]"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const n = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (n) {
      out.push({ t: "num", v: Number(n[0]), at: i });
      i += n[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "name", v: id[0], at: i });
      i += id[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError(`unclosed string at ${i + 1} in "${src}"`);
      out.push({ t: "str", v: src.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    // Unicode niceties a model may write.
    const uni: Record<string, string> = { "×": "*", "·": "*", "÷": "/", "−": "-", "≤": "<=", "≥": ">=", "≠": "!=" };
    if (uni[c]) {
      out.push({ t: "op", v: uni[c], at: i });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected "${c}" at ${i + 1} in "${src}"`);
    out.push({ t: "op", v: op === "**" ? "^" : op, at: i });
    i += op.length;
  }
  out.push({ t: "end", at: src.length });
  return out;
}

// ---------------------------------------------------------------------------
// Parser (Pratt)
// ---------------------------------------------------------------------------

const BIN: Record<string, [number, boolean]> = {
  // op: [binding power, right-associative]
  "||": [2, false],
  "&&": [3, false],
  "==": [4, false],
  "!=": [4, false],
  "<": [5, false],
  "<=": [5, false],
  ">": [5, false],
  ">=": [5, false],
  "+": [6, false],
  "-": [6, false],
  "*": [7, false],
  "/": [7, false],
  "%": [7, false],
  "^": [9, true],
};
const TERNARY_BP = 1;
const UNARY_BP = 8;
const POSTFIX_BP = 10;

function arith(op: string, a: Value, b: Value): Value {
  if (op === "==") return typeof a === "string" || typeof b === "string" ? (String(a) === String(b) ? 1 : 0) : num(a) === num(b) ? 1 : 0;
  if (op === "!=") return typeof a === "string" || typeof b === "string" ? (String(a) !== String(b) ? 1 : 0) : num(a) !== num(b) ? 1 : 0;
  const x = num(a);
  const y = num(b);
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return x / y;
    case "%":
      return x % y;
    case "^":
      return x ** y;
    case "<":
      return x < y ? 1 : 0;
    case "<=":
      return x <= y ? 1 : 0;
    case ">":
      return x > y ? 1 : 0;
    case ">=":
      return x >= y ? 1 : 0;
  }
  return NaN;
}

export function compile(source: string): Compiled {
  if (typeof source !== "string" && typeof source !== "number") throw new ExprError(`expected an expression, got ${JSON.stringify(source)}`);
  const src = String(source);
  if (!src.trim()) throw new ExprError("empty expression");
  const toks = tokenize(src);
  let p = 0;
  const names = new Set<string>();
  const calls = new Set<string>();
  const peek = () => toks[p];
  const next = () => toks[p++];
  const where = (tk: Tok) => (tk.t === "end" ? `at the end of "${src}"` : `at ${tk.at + 1} in "${src}"`);
  const expect = (v: string) => {
    const tk = next();
    if (tk.t !== "op" || tk.v !== v) throw new ExprError(`expected "${v}" ${where(tk)}`);
  };

  function prefix(): Node {
    const tk = next();
    if (tk.t === "num") {
      const v = tk.v;
      return () => v;
    }
    if (tk.t === "str") {
      const v = tk.v;
      return () => v;
    }
    if (tk.t === "name") {
      const name = tk.v;
      const after = peek();
      if (after.t === "op" && after.v === "(") {
        next();
        const args: Node[] = [];
        if (!(peek().t === "op" && (peek() as { v: string }).v === ")")) {
          for (;;) {
            args.push(parse(0));
            const sep = next();
            if (sep.t === "op" && sep.v === ")") break;
            if (!(sep.t === "op" && sep.v === ",")) throw new ExprError(`expected "," or ")" ${where(sep)}`);
          }
        } else next();
        calls.add(name);
        return call(name, args);
      }
      names.add(name);
      if (name in CONSTANTS && !["e"].includes(name)) {
        const c = CONSTANTS[name];
        return (env) => {
          const v = env[name];
          return v === undefined || typeof v === "function" ? c : v;
        };
      }
      return (env) => {
        const v = env[name];
        if (v === undefined) {
          if (name in CONSTANTS) return CONSTANTS[name];
          throw new ExprError(`unknown name "${name}" in "${src}"`);
        }
        if (typeof v === "function") throw new ExprError(`"${name}" is a function; call it as ${name}(…) in "${src}"`);
        return v;
      };
    }
    if (tk.t === "op") {
      if (tk.v === "(") {
        const e = parse(0);
        expect(")");
        return e;
      }
      if (tk.v === "[") {
        const items: Node[] = [];
        if (!(peek().t === "op" && (peek() as { v: string }).v === "]")) {
          for (;;) {
            items.push(parse(0));
            const sep = next();
            if (sep.t === "op" && sep.v === "]") break;
            if (!(sep.t === "op" && sep.v === ",")) throw new ExprError(`expected "," or "]" ${where(sep)}`);
          }
        } else next();
        return (env) => items.map((n) => n(env));
      }
      if (tk.v === "-" || tk.v === "+" || tk.v === "!") {
        const e = parse(UNARY_BP);
        if (tk.v === "-") return (env) => -num(e(env));
        if (tk.v === "+") return (env) => num(e(env));
        return (env) => (truthy(e(env)) ? 0 : 1);
      }
    }
    throw new ExprError(`unexpected ${tk.t === "end" ? "end" : `"${(tk as { v: unknown }).v}"`} ${where(tk)}`);
  }

  function call(name: string, args: Node[]): Node {
    if (name === "if") {
      if (args.length !== 3) throw new ExprError(`if(condition, then, else) takes 3 arguments in "${src}"`);
      const [c, a, b] = args;
      return (env) => (truthy(c(env)) ? a(env) : b(env));
    }
    if (name === "repeat") {
      // repeat(n, expr): sum of expr evaluated n times (each evaluation sees fresh random draws).
      if (args.length !== 2) throw new ExprError(`repeat(n, expression) takes 2 arguments in "${src}"`);
      const [n, body] = args;
      return (env) => {
        const k = Math.min(100000, Math.max(0, Math.floor(num(n(env)))));
        let s = 0;
        for (let i = 0; i < k; i++) s += num(body(env));
        return s;
      };
    }
    const builtin = FUNCTIONS[name];
    if (builtin) {
      const [lo, hi] = builtin.arity;
      if (args.length < lo || args.length > hi)
        throw new ExprError(`${name}() takes ${lo === hi ? lo : `${lo}–${hi === 99 ? "many" : hi}`} argument${hi === 1 ? "" : "s"}, got ${args.length} in "${src}"`);
    }
    return (env) => {
      const f = env[name];
      if (typeof f === "function") return f(...args.map((a) => a(env)));
      if (builtin) return builtin.fn(...args.map((a) => a(env)));
      throw new ExprError(`unknown function "${name}" in "${src}"`);
    };
  }

  function parse(minBp: number): Node {
    let left = prefix();
    for (;;) {
      const tk = peek();
      if (tk.t !== "op") break;
      if (tk.v === "[" && POSTFIX_BP > minBp) {
        next();
        const idx = parse(0);
        expect("]");
        const base = left;
        left = (env) => {
          const a = base(env);
          const i = Math.floor(num(idx(env)));
          return Array.isArray(a) ? (a[i] ?? NaN) : NaN;
        };
        continue;
      }
      if (tk.v === "?" && TERNARY_BP > minBp) {
        next();
        const a = parse(0);
        expect(":");
        const b = parse(TERNARY_BP - 1);
        const c = left;
        left = (env) => (truthy(c(env)) ? a(env) : b(env));
        continue;
      }
      const bin = BIN[tk.v];
      if (!bin) break;
      const [bp, right] = bin;
      if (bp <= minBp) break;
      next();
      const rhs = parse(right ? bp - 1 : bp);
      const lhs = left;
      const op = tk.v;
      if (op === "&&") left = (env) => (truthy(lhs(env)) ? (truthy(rhs(env)) ? 1 : 0) : 0);
      else if (op === "||") left = (env) => (truthy(lhs(env)) ? 1 : truthy(rhs(env)) ? 1 : 0);
      else left = (env) => arith(op, lhs(env), rhs(env));
    }
    return left;
  }

  const root = parse(0);
  if (peek().t !== "end") throw new ExprError(`unexpected "${(peek() as { v: unknown }).v}" ${where(peek())}`);
  const fn = ((env: Env) => root(env)) as Compiled;
  fn.source = src;
  fn.names = names;
  fn.calls = calls;
  return fn;
}

/** Compile, or return the error message. */
export function tryCompile(source: unknown): Compiled | string {
  try {
    return compile(source as string);
  } catch (e) {
    return e instanceof ExprError ? e.message : String(e);
  }
}

/**
 * Problems with an expression given the names it may use: [] when fine. `vars` are readable names;
 * `fns` are extra functions the template provides.
 */
export function checkExpr(source: unknown, vars: Iterable<string>, fns: Iterable<string> = [], where = "expression"): string[] {
  if (typeof source === "number") return [];
  if (typeof source !== "string") return [`${where}: expected an expression string, got ${JSON.stringify(source)}`];
  const c = tryCompile(source);
  if (typeof c === "string") return [`${where}: ${c}`];
  const known = new Set(vars);
  const fnSet = new Set(fns);
  const out: string[] = [];
  for (const n of c.names) if (!known.has(n) && !(n in CONSTANTS)) out.push(`${where}: unknown name "${n}" in "${source}" (known: ${[...known].slice(0, 24).join(", ")})`);
  for (const f of c.calls) if (!(f in FUNCTIONS) && !SPECIAL.has(f) && !fnSet.has(f)) out.push(`${where}: unknown function "${f}" in "${source}"`);
  return out;
}

/** Evaluate to a number (NaN on any error). */
export function evalNum(c: Compiled | number | undefined, env: Env): number {
  if (c === undefined) return NaN;
  if (typeof c === "number") return c;
  try {
    return num(c(env));
  } catch {
    return NaN;
  }
}

/** Compile an expression-or-number config field; numbers pass through. Throws ExprError. */
export function compileField(v: unknown): Compiled | number {
  if (typeof v === "number") return v;
  return compile(v as string);
}

/** Names of all built-in functions (for prompts and validation). */
export const BUILTIN_FUNCTIONS = [...Object.keys(FUNCTIONS), ...SPECIAL];
