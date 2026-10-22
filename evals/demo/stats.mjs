export function stats(values) {
  const total = values.reduce((a, b) => a + b, 0);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  return { count: values.length, total, min, max };
}
