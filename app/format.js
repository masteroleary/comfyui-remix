// ── Numbers, as a person reads them ────────────────────────────────────────
// Two formatters, shared rather than copied. They were local to the Clean page
// until Restore needed the same pair on the Settings page, and a second copy of
// fmtBytes is the kind of thing that quietly disagrees with the first — one of
// them rounds at 10, the other does not, and the same folder then reports two
// different sizes on two pages that are describing the same files.

export const fmtNum = n => (n || 0).toLocaleString();

// Binary units, because that is what a filesystem reports. Two decimals below 10
// and none above: "8.24 GB" is a number worth reading, "8.24 KB" is noise, and
// "1024.00 MB" is a unit that should have carried.
export function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i > 0 && v < 10 ? 2 : 0) + ' ' + u[i];
}
