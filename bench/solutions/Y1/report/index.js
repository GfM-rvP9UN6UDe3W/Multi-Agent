export function lowStock(inventory, threshold) {
  return [...inventory]
    .filter(([, stock]) => stock < threshold)
    .map(([name]) => name)
    .sort();
}
