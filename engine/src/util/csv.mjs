export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
export function csvRow(values) { return `${values.map(csvEscape).join(',')}\n`; }
