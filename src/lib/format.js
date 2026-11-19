export const money = (value, digits = 2) => Number(value || 0).toLocaleString('th-TH', {
  minimumFractionDigits: 0,
  maximumFractionDigits: digits,
});

export const number = (value, digits = 1) => Number(value || 0).toLocaleString('th-TH', {
  minimumFractionDigits: 0,
  maximumFractionDigits: digits,
});

export function dateKey(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function dateLabel(value, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!value) return '—';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('th-TH', options);
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

export function initials(value = '') {
  return escapeHtml(String(value).trim().slice(0, 1) || 'จ');
}

export function id() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function exportCsv(filename, rows) {
  const csv = rows.map((row) => row.map((cell) => {
    const value = String(cell ?? '').replace(/"/g, '""');
    return `"${value}"`;
  }).join(',')).join('\r\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const todayText = () => new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' });
