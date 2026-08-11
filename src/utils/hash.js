/**
 * Deterministic hash of a grid cell to [0, 1). Integer mixing rather than
 * sin-based hashing so the same cell gives the same answer forever, at any
 * distance from the origin, with no float precision drift.
 *
 * This is what lets a field be endless without existing: rocks, boats and the
 * sharks' patrol all decide what is where by hashing coordinates rather than by
 * keeping a list, so they cost no memory and come out identical every run.
 */
export function hashCell(i, j, salt) {
  let n = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(salt, 83492791);
  n = Math.imul(n ^ (n >>> 15), 2246822519);
  n = Math.imul(n ^ (n >>> 13), 3266489917);
  return ((n ^ (n >>> 16)) >>> 8) / 16777216;
}
