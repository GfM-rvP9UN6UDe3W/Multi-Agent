export function lowStock(inventory, threshold) {
  return [...inventory]
    .filter(([, stock]) => stock < threshold)
    .sort(([a, x], [b, y]) => x - y || a.localeCompare(b))
    .map(([name]) => name);
}
