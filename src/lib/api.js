export async function api(action, payload = {}) {
  if (!navigator.onLine) throw new Error('ออฟไลน์อยู่ ระบบจะเก็บรายการไว้ส่งภายหลัง');
  const response = await fetch('/api/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('ระบบข้อมูลตอบกลับไม่ถูกต้อง'); }
  if (!response.ok || result.ok === false) {
    const error = new Error(result.error || 'ทำรายการไม่สำเร็จ');
    error.api = response.ok;
    error.details = result;
    throw error;
  }
  return result;
}
