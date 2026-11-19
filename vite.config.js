import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';

function localApiProxy(apiUrl, secret) {
  return {
    name: 'jodyang-local-api-proxy',
    configureServer(server) {
      server.middlewares.use('/api', async (request, response, next) => {
        if (request.method !== 'POST') return next();
        if (!apiUrl || !secret) {
          response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ ok: false, error: 'ตั้งค่า GAS_WEB_APP_URL และ GAS_PROXY_SECRET ในไฟล์ .env.local ก่อน' }));
          return;
        }
        try {
          let raw = '';
          for await (const chunk of request) raw += chunk;
          const body = JSON.parse(raw || '{}');
          const upstream = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, proxySecret: secret }),
            redirect: 'follow',
          });
          const text = await upstream.text();
          response.writeHead(upstream.ok ? 200 : upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end(text);
        } catch {
          response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ ok: false, error: 'เชื่อมต่อ Google Sheets ไม่สำเร็จ' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [tailwindcss(), localApiProxy(env.GAS_WEB_APP_URL, env.GAS_PROXY_SECRET)],
    build: { sourcemap: false, assetsInlineLimit: 4096 },
  };
});
