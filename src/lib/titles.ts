// Section titles as the text layer gives them can carry small-caps artefacts:
// "T HE D ISCRETE N OISELESS C HANNEL", "A DAM ’ S UPDATE RULE". Join the split
// capitals back into words and set the result in title case, the way small caps
// read on the page. Titles without the pattern are returned unchanged.

// A lone capital (at the start or after a space — not after an apostrophe) followed by the rest of its word.
const SPLIT = /(^|\s)([A-Z]) (?=[A-Z]{2,})/g;

export function cleanTitle(title: string): string {
  const letters = title.replace(/[^A-Za-z]/g, "");
  // Only all-caps titles that start with a split capital (the small-caps signature).
  if (!letters || letters !== letters.toUpperCase() || !/^[A-Z] [A-Z]{2,}/.test(title.trim())) return title;
  const joined = title
    .replace(/\s*([’'])\s*([A-Z])\b/g, "$1$2")
    .replace(SPLIT, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  const small = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);
  return joined
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && small.has(w) ? w : w.replace(/^(\p{L})/u, (c) => c.toUpperCase())))
    .join(" ");
}

/** Text the search matches against: the title as given, plus the cleaned form. */
export function searchable(title: string): string {
  const clean = cleanTitle(title);
  return clean === title ? title : `${title} ${clean}`;
}
