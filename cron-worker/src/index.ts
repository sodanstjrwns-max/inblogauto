/**
 * InBlog AutoPublish — Cron Trigger Worker (v7.8)
 * 
 * Cloudflare Pages는 Cron Trigger를 지원하지 않으므로,
 * 이 독립 Worker가 정해진 시간에 Pages API를 호출합니다.
 * 
 * ★ v7.8: async_mode=true로 호출
 * - Pages가 즉시 202 Accepted 반환 → Cron Worker 타임아웃 없음
 * - 실제 작업은 Pages의 waitUntil()로 백그라운드 실행
 * 
 * 스케줄: KST 07:00, 18:00 (하루 2회 × 1건 = 2건/일)
 */

export interface Env {
  TARGET_URL: string;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const startTime = Date.now();
    const targetUrl = env.TARGET_URL || 'https://inblogauto.pages.dev/api/cron/generate';
    
    console.log(`[cron-v7.8] 시작 — ${new Date().toISOString()}, cron: ${event.cron}`);

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'InBlog-Cron-Trigger/7.8',
        },
        body: JSON.stringify({
          count: 1,
          manual: false,
          auto_publish: true,
          async_mode: true,  // ★ Pages가 즉시 202 반환 + 백그라운드 실행
        }),
      });

      const elapsed = Date.now() - startTime;
      const text = await response.text().catch(() => '');
      let result: any;
      try { result = JSON.parse(text); } catch { result = null; }

      if (response.status === 202 && result?.accepted) {
        console.log(`[cron-v7.8] ✅ 202 Accepted (${elapsed}ms) — jobId: ${result.job_id}`);
      } else if (response.ok && result) {
        console.log(`[cron-v7.8] ✅ 동기완료 (${elapsed}ms): ${result.message || ''}`);
        if (result.results?.[0]) {
          console.log(`[cron-v7.8] 📝 "${result.results[0].title}" → ${result.results[0].inblog_url || ''}`);
        }
      } else {
        console.error(`[cron-v7.8] ❌ HTTP ${response.status} (${elapsed}ms): ${text.substring(0, 300)}`);
      }
    } catch (err: any) {
      console.error(`[cron-v7.8] ❌ 에러 (${Date.now() - startTime}ms): ${err.message}`);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        worker: 'inblog-cron-trigger',
        version: '7.8',
        mode: 'async_mode (202 Accepted)',
        target: env.TARGET_URL,
        schedule: ['KST 07:00 (UTC 22:00)', 'KST 18:00 (UTC 09:00)'],
        posts_per_trigger: 1,
        daily_total: 2,
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === '/trigger' && request.method === 'POST') {
      const targetUrl = env.TARGET_URL || 'https://inblogauto.pages.dev/api/cron/generate';
      const startTime = Date.now();
      
      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'InBlog-Cron-Trigger/7.8-manual',
          },
          body: JSON.stringify({
            count: 1,
            manual: true,
            auto_publish: true,
            async_mode: true,
          }),
        });

        const elapsed = Date.now() - startTime;
        const text = await response.text().catch(() => '');
        let result: any;
        try { result = JSON.parse(text); } catch { result = { raw: text.substring(0, 500) }; }

        return Response.json({
          triggered: true,
          http_status: response.status,
          async_accepted: response.status === 202,
          elapsed_ms: elapsed,
          result,
        });
      } catch (err: any) {
        return Response.json({ triggered: false, error: err.message }, { status: 500 });
      }
    }

    return new Response(
      'InBlog Cron Trigger Worker v7.8 (async_mode)\n\n' +
      'GET  /health  — 상태 확인\n' +
      'POST /trigger — 수동 트리거 (async, 즉시 202)\n',
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  },
};
