

function fmt만원(v) {
  if (v == null || isNaN(v)) return "—";
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}억`;
  return `${Math.round(v).toLocaleString()}만`;
}
function fmt만원월(v) {
  if (v == null || isNaN(v)) return "—";
  return `${Math.round(v).toLocaleString()}만/월`;
}


export { fmt만원, fmt만원월 };
