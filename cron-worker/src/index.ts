/**
 * InBlog AutoPublish — Cron Trigger Worker
 * 
 * Cloudflare Pages는 Cron Trigger를 지원하지 않으므로,
 * 이 독립 Worker가 정해진 시간에 Pages API를 호출합니다.
 * 
 * 스케줄: KST 07:00, 18:00 (하루 2회 × 1건 = 2건/일)
 */

export interface Env {
  TARGET_URL: string;
}

export default {
  // Cron Trigger 핸들러
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const startTime = Date.now();
    const targetUrl = env.TARGET_URL || 'https://inblogauto.pages.dev/api/cron/generate';
    
    console.log(`[cron-trigger] 시작 — ${new Date().toISOString()}`);
    console.log(`[cron-trigger] cron: ${event.cron}, target: ${targetUrl}`);

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'InBlog-Cron-Trigger/1.0',
        },
        body: JSON.stringify({
          count: 1,
          manual: false,
          auto_publish: true,
        }),
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'no body');
        console.error(`[cron-trigger] ❌ HTTP ${response.status} (${elapsed}ms): ${errorText.substring(0, 200)}`);
        return;
      }

      const result: any = await response.json().catch(() => null);
      if (result) {
        console.log(`[cron-trigger] ✅ 성공 (${elapsed}ms): ${result.message || JSON.stringify(result).substring(0, 200)}`);
        if (result.results?.[0]) {
          const r = result.results[0];
          console.log(`[cron-trigger] 📝 "${r.title}" → ${r.inblog_url || r.status}`);
        }
      } else {
        console.log(`[cron-trigger] ⚠️ 응답 파싱 실패 (${elapsed}ms) — status ${response.status}`);
      }
    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      console.error(`[cron-trigger] ❌ 에러 (${elapsed}ms): ${err.message}`);
    }
  },

  // HTTP 요청 핸들러 (상태 확인용)
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        worker: 'inblog-cron-trigger',
        target: env.TARGET_URL,
        schedule: ['KST 07:00 (UTC 22:00)', 'KST 18:00 (UTC 09:00)'],
        posts_per_trigger: 1,
        daily_total: 2,
        timestamp: new Date().toISOString(),
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 수동 트리거 (테스트용)
    if (url.pathname === '/trigger' && request.method === 'POST') {
      const targetUrl = env.TARGET_URL || 'https://inblogauto.pages.dev/api/cron/generate';
      
      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            count: 1,
            manual: true,
            auto_publish: true,
          }),
        });
        
        const text = await response.text();
        let result: any;
        try { result = JSON.parse(text); } catch { result = { raw: text }; }
        return new Response(JSON.stringify({
          triggered: true,
          status: response.status,
          result,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({
          triggered: false,
          error: err.message,
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('InBlog Cron Trigger Worker\n\nEndpoints:\n  GET /health — 상태 확인\n  POST /trigger — 수동 발행 트리거\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
