const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ ok: false, error: 'ใช้คำขอ POST เท่านั้น' }, 405);
  if (!env.GAS_WEB_APP_URL || !env.GAS_PROXY_SECRET) {
    return json({ ok: false, error: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ Google Sheets' }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'รูปแบบข้อมูลไม่ถูกต้อง' }, 400);
  }

  try {
    const upstream = await fetch(env.GAS_WEB_APP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, proxySecret: env.GAS_PROXY_SECRET }),
      redirect: 'follow',
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.ok ? 200 : upstream.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch {
    return json({ ok: false, error: 'เชื่อมต่อระบบข้อมูลไม่สำเร็จ ข้อมูลที่บันทึกไว้จะรอส่งเมื่ออินเทอร์เน็ตกลับมา' }, 502);
  }
}
