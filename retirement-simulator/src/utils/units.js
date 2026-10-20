// Canonical model money is 만원. Text editing never snaps to slider increments.
export function parseNumericDraft(text, { value, min = -Infinity, max = Infinity, scale = 1, integer = false } = {}) {
  const cleaned = text.trim().replaceAll(',', '');
  if (!cleaned || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return { valid: false, value, error: '숫자를 입력해주세요.' };
  const number = Number(cleaned) * scale;
  if (!Number.isFinite(number)) return { valid: false, value, error: '유한한 숫자를 입력해주세요.' };
  if (integer && !Number.isInteger(number)) return { valid: false, value, error: '정수로 입력해주세요.' };
  if (number < min || number > max) return { valid: false, value, error: `${min.toLocaleString()}~${max.toLocaleString()} 범위로 입력해주세요.` };
  return { valid: true, value: Math.round(number * 1e8) / 1e8, error: '' };
}
