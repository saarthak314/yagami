// How readout values are set for the reader.

const SUPER: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };

/** "4e+9" → "4×10⁹", "1.5e-7" → "1.5×10⁻⁷". Floating-point residue (|x| around 1e-16, e.g. 5.551e-17) → "0". */
function sci(mantissa: string, exp: string): string {
  const e = Number(exp);
  if (e >= -18 && e <= -16) return "0";
  return `${mantissa}×10${String(e).replace(/./g, (ch) => SUPER[ch] ?? ch)}`;
}

/** A readout as shown: exponent notation set as ×10ⁿ (digits kept exactly — the checks read them), float residue as 0. */
export function formatReadout(value: string | number): string {
  if (typeof value === "number") {
    if (value !== 0 && Math.abs(value) < 1e-15 && Math.abs(value) >= 1e-18) return "0";
    const s = String(value);
    if (!/e/i.test(s)) return s;
    const m = /^(-?\d+(?:\.\d+)?)e([+-]?\d+)$/i.exec(s);
    return m ? sci(m[1], m[2]) : s;
  }
  return value.replace(/(?<![\w.])(-?\d+(?:\.\d+)?)e([+-]?\d+)\b/gi, (_, m: string, e: string) => sci(m, e));
}
