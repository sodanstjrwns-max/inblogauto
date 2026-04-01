/**
 * InBlog AutoPublish — Cron Trigger Worker (v7.9)
 * 
 * ★ v7.9: 외부 cron 서비스(cron-job.org) 대응
 * - GET /cron?key=SECRET 으로 외부에서 HTTP 호출 가능
 * - Cloudflare scheduled도 유지 (백업)
 * - 간단한 시크릿 키로 무단 호출 방지
 * 
 * 스케줄: KST 07:00, 18:00 (하루 2회 x 1건 = 2건/일)
 */

export interface Env {
  TARGET_URL: string;
  CRON_SECRET: string;  // 외부 cron 인증용 시크릿
}

// 공통: Pages generate API 호출
async function triggerGenerate(targetUrl: string, source: string): Promise<{
  ok: boolean;
  status: number;
  elapsed: number;
  result: any;
}> {
  const startTime = Date.now();
  
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `InBlog-Cron-Trigger/7.9-${source}`,
    },
    body: JSON.stringify({
      count: 1,
      manual: false,
      auto_publish: true,
      async_mode: true,
    }),
  });

  const elapsed = Date.now() - startTime;
  const text = await response.text().catch(() => '');
  let result: any;
  try { result = JSON.parse(text); } catch { result = { raw: text.substring(0, 500) }; }

  return { ok: response.ok || response.status === 202, status: response.status, elapsed, result };
}

export default {
  // Cloudflare scheduled (백업 - 작동하면 좋고, 안 해도 외부 cron이 커버)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const targetUrl = env.TARGET_URL || 'https://inblogauto.pages.dev/api/cron/generate';
    console.log(`[cron-v7.9] scheduled 시작 — ${new Date().toISOString()}, cron: ${event.cron}`);

    try {
      const { ok, status, elapsed, result } = await triggerGenerate(targetUrl, 'scheduled');
      if (ok) {
        console.log(`[cron-v7.9] scheduled ✅ ${status} (${elapsed}ms) — jobId: ${result?.job_id || 'sync'}`);
      } else {
        console.error(`[cron-v7.9] scheduled ❌ ${status} (${elapsed}ms)`);
      }
    } catch (err: any) {
      console.error(`[cron-v7.9] scheduled ❌ ${err.message}`);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const targetUrl = env.TARGET_URL || 'https://inblogauto.pages.dev/api/cron/generate';

    // === GET /health ===
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        worker: 'inblog-cron-trigger',
        version: '7.9',
        mode: 'external_cron + cloudflare_scheduled (backup)',
        target: env.TARGET_URL,
        schedule: ['KST 07:00 (UTC 22:00)', 'KST 18:00 (UTC 09:00)'],
        posts_per_trigger: 1,
        daily_total: 2,
        has_secret: !!env.CRON_SECRET,
        timestamp: new Date().toISOString(),
      });
    }

    // === GET /cron?key=SECRET — 외부 cron 서비스용 (핵심!) ===
    if (url.pathname === '/cron') {
      const key = url.searchParams.get('key');
      const secret = env.CRON_SECRET || '';
      
      // 시크릿 검증
      if (!secret || key !== secret) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }

      try {
        const { ok, status, elapsed, result } = await triggerGenerate(targetUrl, 'external-cron');
        console.log(`[cron-v7.9] external ✅ ${status} (${elapsed}ms) — jobId: ${result?.job_id || 'sync'}`);
        
        return Response.json({
          triggered: true,
          source: 'external-cron',
          http_status: status,
          async_accepted: status === 202,
          elapsed_ms: elapsed,
          job_id: result?.job_id || null,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        console.error(`[cron-v7.9] external ❌ ${err.message}`);
        return Response.json({ triggered: false, error: err.message }, { status: 500 });
      }
    }

    // === POST /trigger — 수동 테스트용 ===
    if (url.pathname === '/trigger' && request.method === 'POST') {
      try {
        const { ok, status, elapsed, result } = await triggerGenerate(targetUrl, 'manual');
        return Response.json({
          triggered: true,
          http_status: status,
          async_accepted: status === 202,
          elapsed_ms: elapsed,
          result,
        });
      } catch (err: any) {
        return Response.json({ triggered: false, error: err.message }, { status: 500 });
      }
    }

    return new Response(
      'InBlog Cron Trigger Worker v7.9\n\n' +
      'GET  /health           — 상태 확인\n' +
      'GET  /cron?key=SECRET  — 외부 cron 트리거 (cron-job.org용)\n' +
      'POST /trigger          — 수동 트리거\n',
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  },
};
