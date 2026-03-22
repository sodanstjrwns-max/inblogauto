import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { keywordRoutes } from './routes/keywords'
import { contentRoutes } from './routes/contents'
import { publishRoutes } from './routes/publish'
import { cronHandler } from './routes/cron'
import { scheduleRoutes } from './routes/schedule'
import { settingsRoutes } from './routes/settings'
import { dashboardRoutes } from './routes/dashboard'
export type Bindings = {
  DB: D1Database
  CLAUDE_API_KEY: string
  INBLOG_API_KEY: string
  THUMBNAIL_API_KEY: string
  AI?: any  // Cloudflare Workers AI (optional)
  R2?: R2Bucket  // Cloudflare R2 Storage (optional)
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS
app.use('/api/*', cors())

// API Routes
app.route('/api/keywords', keywordRoutes)
app.route('/api/contents', contentRoutes)
app.route('/api/publish', publishRoutes)
app.route('/api/schedule', scheduleRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/dashboard', dashboardRoutes)

// Cron endpoint (Cloudflare Cron Trigger calls this)
app.route('/api/cron/generate', cronHandler)

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

// SPA - serve index.html for all non-API routes
app.get('*', (c) => {
  return c.html(getIndexHtml())
})

function getIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Inblog AutoPublish</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/locale/ko.js"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            colors: {
              primary: { 50:'#eff6ff',100:'#dbeafe',200:'#bfdbfe',300:'#93c5fd',400:'#60a5fa',500:'#3b82f6',600:'#2563eb',700:'#1d4ed8',800:'#1e40af',900:'#1e3a8a' },
              success: { 50:'#f0fdf4',500:'#22c55e',600:'#16a34a' },
              warning: { 50:'#fffbeb',500:'#f59e0b',600:'#d97706' },
              danger: { 50:'#fef2f2',500:'#ef4444',600:'#dc2626' }
            }
          }
        }
      }
    </script>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
      body { font-family: 'Inter', sans-serif; }
      .sidebar-link { transition: all 0.2s ease; }
      .sidebar-link:hover, .sidebar-link.active { background: rgba(59,130,246,0.1); color: #2563eb; }
      .card { background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
      .badge { display: inline-flex; align-items: center; padding: 2px 10px; border-radius: 9999px; font-size: 12px; font-weight: 500; }
      .badge-success { background: #f0fdf4; color: #16a34a; }
      .badge-warning { background: #fffbeb; color: #d97706; }
      .badge-danger { background: #fef2f2; color: #dc2626; }
      .badge-info { background: #eff6ff; color: #2563eb; }
      .toast { position: fixed; top: 20px; right: 20px; z-index: 9999; animation: slideIn 0.3s ease; }
      @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 50; display: flex; align-items: center; justify-content: center; }
      .spinner { border: 3px solid #e5e7eb; border-top: 3px solid #3b82f6; border-radius: 50%; width: 20px; height: 20px; animation: spin 0.8s linear infinite; display: inline-block; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .tab-btn { padding: 8px 16px; border-bottom: 2px solid transparent; cursor: pointer; transition: all 0.2s; }
      .tab-btn:hover { color: #2563eb; }
      .tab-btn.active { color: #2563eb; border-bottom-color: #2563eb; font-weight: 600; }
      .stat-card { transition: transform 0.2s; }
      .stat-card:hover { transform: translateY(-2px); }
    </style>
</head>
<body class="bg-gray-50 min-h-screen">
    <div id="app" class="flex min-h-screen">
      <!-- Sidebar -->
      <aside id="sidebar" class="w-64 bg-white border-r border-gray-200 flex flex-col fixed h-full z-40">
        <div class="p-5 border-b border-gray-100">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 bg-primary-600 rounded-lg flex items-center justify-center">
              <i class="fas fa-pen-nib text-white text-sm"></i>
            </div>
            <div>
              <h1 class="text-base font-bold text-gray-900">AutoPublish</h1>
              <p class="text-xs text-gray-400">SEO 자동 발행</p>
            </div>
          </div>
        </div>
        <nav class="flex-1 p-3 space-y-1">
          <a href="#" onclick="navigate('dashboard')" class="sidebar-link active flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm" data-page="dashboard">
            <i class="fas fa-chart-line w-5 text-center"></i> 대시보드
          </a>
          <a href="#" onclick="navigate('keywords')" class="sidebar-link flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-600" data-page="keywords">
            <i class="fas fa-key w-5 text-center"></i> 키워드 관리
          </a>
          <a href="#" onclick="navigate('schedule')" class="sidebar-link flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-600" data-page="schedule">
            <i class="fas fa-clock w-5 text-center"></i> 스케줄러
          </a>
          <a href="#" onclick="navigate('history')" class="sidebar-link flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-600" data-page="history">
            <i class="fas fa-history w-5 text-center"></i> 발행 이력
          </a>
          <a href="#" onclick="navigate('settings')" class="sidebar-link flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-600" data-page="settings">
            <i class="fas fa-cog w-5 text-center"></i> 설정
          </a>
        </nav>
        <div class="p-3 border-t border-gray-100">
          <div class="bg-primary-50 rounded-lg p-3 text-xs text-primary-700">
            <i class="fas fa-robot mr-1"></i> 자동 발행 <span id="auto-status" class="font-semibold text-primary-600">활성화</span>
          </div>
        </div>
      </aside>

      <!-- Main Content -->
      <main class="flex-1 ml-64">
        <header class="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sticky top-0 z-30">
          <div>
            <h2 id="page-title" class="text-lg font-semibold text-gray-900">대시보드</h2>
            <p id="page-subtitle" class="text-sm text-gray-500">오늘의 발행 현황을 확인하세요</p>
          </div>
          <div class="flex items-center gap-3">
            <button onclick="manualGenerate()" class="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 transition flex items-center gap-2">
              <i class="fas fa-magic"></i> 수동 생성
            </button>
          </div>
        </header>
        <div id="page-content" class="p-6">
          <!-- Dynamic content loaded here -->
        </div>
      </main>
    </div>

    <div id="toast-container"></div>
    <div id="modal-container"></div>

    <script>
    // ===== State =====
    let currentPage = 'dashboard';
    let keywordsData = [];
    let contentsData = [];
    let historyData = [];
    let dashboardData = {};
    let scheduleData = {};
    let settingsData = {};

    // ===== API Helper =====
    async function api(path, options = {}) {
      try {
        const res = await fetch('/api' + path, {
          headers: { 'Content-Type': 'application/json', ...options.headers },
          ...options
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'API Error');
        return data;
      } catch(e) {
        showToast(e.message, 'error');
        throw e;
      }
    }

    // ===== Toast =====
    function showToast(msg, type = 'success') {
      const colors = { success: 'bg-green-500', error: 'bg-red-500', warning: 'bg-yellow-500', info: 'bg-blue-500' };
      const icons = { success: 'check-circle', error: 'exclamation-circle', warning: 'exclamation-triangle', info: 'info-circle' };
      const el = document.createElement('div');
      el.className = 'toast ' + colors[type] + ' text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 text-sm';
      el.innerHTML = '<i class="fas fa-' + icons[type] + '"></i> ' + msg;
      document.getElementById('toast-container').appendChild(el);
      setTimeout(() => el.remove(), 3000);
    }

    // ===== Navigation =====
    function navigate(page) {
      currentPage = page;
      document.querySelectorAll('.sidebar-link').forEach(el => {
        el.classList.remove('active');
        el.classList.add('text-gray-600');
      });
      const activeLink = document.querySelector('[data-page="'+page+'"]');
      if(activeLink) { activeLink.classList.add('active'); activeLink.classList.remove('text-gray-600'); }
      loadPage(page);
    }

    async function loadPage(page) {
      const titles = {
        dashboard: ['대시보드', '오늘의 발행 현황을 확인하세요'],
        keywords: ['키워드 관리', '치과 키워드 데이터베이스를 관리합니다'],
        schedule: ['스케줄러', '자동 발행 스케줄을 설정합니다'],
        history: ['발행 이력', '콘텐츠 생성 및 발행 이력을 확인합니다'],
        settings: ['설정', 'API 키 및 사이트 설정을 관리합니다']
      };
      document.getElementById('page-title').textContent = titles[page][0];
      document.getElementById('page-subtitle').textContent = titles[page][1];
      
      const content = document.getElementById('page-content');
      content.innerHTML = '<div class="flex items-center justify-center py-20"><div class="spinner"></div><span class="ml-3 text-gray-500">로딩 중...</span></div>';
      
      try {
        switch(page) {
          case 'dashboard': await renderDashboard(); break;
          case 'keywords': await renderKeywords(); break;
          case 'schedule': await renderSchedule(); break;
          case 'history': await renderHistory(); break;
          case 'settings': await renderSettings(); break;
        }
      } catch(e) {
        content.innerHTML = '<div class="text-center py-20 text-gray-500"><i class="fas fa-exclamation-triangle text-4xl mb-4 text-yellow-400"></i><p>페이지를 불러오는 중 오류가 발생했습니다.</p><p class="text-sm mt-2">' + e.message + '</p></div>';
      }
    }

    // ===== Dashboard =====
    async function renderDashboard() {
      const data = await api('/dashboard/stats');
      dashboardData = data;
      const kwStats = data.keyword_stats || {};
      const seoDist = data.seo_distribution || {};
      const dailyRpt = data.daily_report || {};
      const c = document.getElementById('page-content');
      c.innerHTML = \`
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div class="card p-5 stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm text-gray-500">오늘 발행</p>
                <p class="text-2xl font-bold text-gray-900 mt-1">\${data.today_published || 0}<span class="text-base font-normal text-gray-400">/\${data.today_scheduled || 3}</span></p>
              </div>
              <div class="w-12 h-12 bg-primary-50 rounded-xl flex items-center justify-center">
                <i class="fas fa-paper-plane text-primary-500 text-lg"></i>
              </div>
            </div>
            <div class="mt-3 bg-gray-100 rounded-full h-2">
              <div class="bg-primary-500 h-2 rounded-full transition-all" style="width: \${data.today_scheduled ? Math.min(100, data.today_published/data.today_scheduled*100) : 0}%"></div>
            </div>
          </div>
          <div class="card p-5 stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm text-gray-500">총 발행 / 대기</p>
                <p class="text-2xl font-bold text-gray-900 mt-1">\${data.total_published || 0}<span class="text-base font-normal text-gray-400"> / \${data.draft_count || 0}</span></p>
              </div>
              <div class="w-12 h-12 bg-success-50 rounded-xl flex items-center justify-center">
                <i class="fas fa-layer-group text-success-500 text-lg"></i>
              </div>
            </div>
            <p class="text-xs text-gray-400 mt-2">총 \${data.total_contents || 0}건 생성됨</p>
          </div>
          <div class="card p-5 stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm text-gray-500">평균 SEO 점수</p>
                <p class="text-2xl font-bold \${(data.avg_seo_score||0)>=80?'text-green-600':(data.avg_seo_score||0)>=60?'text-yellow-600':'text-red-600'} mt-1">\${data.avg_seo_score || 0}<span class="text-base font-normal text-gray-400">점</span></p>
              </div>
              <div class="w-12 h-12 bg-warning-50 rounded-xl flex items-center justify-center">
                <i class="fas fa-star text-warning-500 text-lg"></i>
              </div>
            </div>
            <p class="text-xs text-gray-400 mt-2">우수 \${seoDist.excellent||0} | 양호 \${seoDist.good||0} | 보통 \${seoDist.average||0} | 개선필요 \${seoDist.poor||0}</p>
          </div>
          <div class="card p-5 stat-card">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm text-gray-500">발행 성공률</p>
                <p class="text-2xl font-bold \${(data.success_rate||0)>=90?'text-green-600':(data.success_rate||0)>=70?'text-yellow-600':'text-red-600'} mt-1">\${data.success_rate || 0}<span class="text-base font-normal text-gray-400">%</span></p>
              </div>
              <div class="w-12 h-12 bg-green-50 rounded-xl flex items-center justify-center">
                <i class="fas fa-check-circle text-green-500 text-lg"></i>
              </div>
            </div>
            <p class="text-xs text-gray-400 mt-2">실패 \${data.failed_count||0}건</p>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <div class="card p-5 lg:col-span-2">
            <div class="flex items-center justify-between mb-4">
              <h3 class="font-semibold text-gray-900"><i class="fas fa-chart-area mr-2 text-primary-500"></i>발행 추이</h3>
              <div class="flex gap-2">
                <button onclick="switchChartPeriod('week')" class="chart-period-btn text-xs px-3 py-1 rounded-full bg-primary-100 text-primary-700 font-medium" data-period="week">7일</button>
                <button onclick="switchChartPeriod('month')" class="chart-period-btn text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-500" data-period="month">30일</button>
              </div>
            </div>
            <canvas id="trendChart" height="200"></canvas>
          </div>
          <div class="card p-5">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-chart-pie mr-2 text-primary-500"></i>카테고리 분포</h3>
            <canvas id="categoryChart" height="200"></canvas>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          <div class="card p-5">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-database mr-2 text-primary-500"></i>키워드 현황</h3>
            <div class="space-y-3">
              <div class="flex justify-between text-sm"><span class="text-gray-500">전체 키워드</span><span class="font-semibold">\${kwStats.total||0}개</span></div>
              <div class="flex justify-between text-sm"><span class="text-gray-500">활성 키워드</span><span class="font-semibold text-green-600">\${kwStats.active||0}개</span></div>
              <div class="flex justify-between text-sm"><span class="text-gray-500">미사용 키워드</span><span class="font-semibold text-blue-600">\${kwStats.unused||0}개</span></div>
              <div class="flex justify-between text-sm"><span class="text-gray-500">총 사용 횟수</span><span class="font-semibold">\${kwStats.total_uses||0}회</span></div>
              <div class="border-t pt-3 mt-3">
                <p class="text-xs font-medium text-gray-500 mb-2">카테고리별 소진율</p>
                \${renderKwUsageBars(kwStats.usage_by_category || {})}
              </div>
            </div>
          </div>
          <div class="card p-5">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-clock mr-2 text-primary-500"></i>다음 발행 예정</h3>
            <div class="space-y-3">\${renderUpcoming(data.upcoming || [])}</div>
          </div>
          <div class="card p-5">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-exclamation-triangle mr-2 text-warning-500"></i>최근 실패</h3>
            <div class="space-y-3">\${renderFailures(data.recent_failures || [])}</div>
          </div>
        </div>

        \${(data.recent_success && data.recent_success.length) ? \`
        <div class="card p-5">
          <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-check-double mr-2 text-green-500"></i>최근 성공 발행</h3>
          <div class="space-y-2">
            \${data.recent_success.map(s => \`
              <div class="flex items-center justify-between p-3 bg-green-50 rounded-lg">
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-gray-800 truncate">\${s.title || s.keyword_text}</p>
                  <p class="text-xs text-gray-400">\${s.keyword_text} · SEO \${s.seo_score||0}점 · \${s.published_at ? dayjs(s.published_at).format('MM/DD HH:mm') : ''}</p>
                </div>
                \${s.inblog_url ? '<a href="'+s.inblog_url+'" target="_blank" class="text-xs text-green-600 hover:text-green-700 whitespace-nowrap ml-2"><i class="fas fa-external-link-alt mr-1"></i>보기</a>' : ''}
              </div>
            \`).join('')}
          </div>
        </div>
        \` : ''}
      \`;
      renderCharts(data);
    }

    function renderKwUsageBars(usageByCategory) {
      const cats = { implant:'임플란트', orthodontics:'교정', general:'일반', prevention:'예방', local:'지역' };
      const colors = { implant:'blue', orthodontics:'purple', general:'green', prevention:'yellow', local:'red' };
      return Object.entries(cats).map(([k,name]) => {
        const d = usageByCategory[k] || {total:0,used:0,rate:0};
        return \`<div class="mb-2"><div class="flex justify-between text-xs mb-1"><span class="text-gray-600">\${name}</span><span class="text-gray-400">\${d.used}/\${d.total} (\${d.rate}%)</span></div><div class="bg-gray-100 rounded-full h-1.5"><div class="bg-\${colors[k]}-500 h-1.5 rounded-full" style="width:\${d.rate}%"></div></div></div>\`;
      }).join('');
    }

    function renderUpcoming(items) {
      if(!items.length) return '<p class="text-sm text-gray-400 text-center py-4">예정된 발행이 없습니다</p>';
      return items.map(i => \`
        <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
          <div>
            <p class="text-sm font-medium text-gray-800">\${i.keyword || i.keyword_text || '-'}</p>
            <p class="text-xs text-gray-400">\${i.category || ''}</p>
          </div>
          <span class="badge badge-info">\${i.scheduled_time || '예정'}</span>
        </div>
      \`).join('');
    }

    function renderFailures(items) {
      if(!items.length) return '<p class="text-sm text-gray-400 text-center py-4">실패 이력 없음 <i class="fas fa-check-circle text-green-400 ml-1"></i></p>';
      return items.map(i => \`
        <div class="flex items-center justify-between p-3 bg-red-50 rounded-lg">
          <div>
            <p class="text-sm font-medium text-gray-800">\${i.keyword_text || '-'}</p>
            <p class="text-xs text-red-400">\${i.error_message || '알 수 없는 오류'}</p>
          </div>
          <button onclick="retryPublish(\${i.id})" class="text-xs bg-red-500 text-white px-3 py-1 rounded-lg hover:bg-red-600">재시도</button>
        </div>
      \`).join('');
    }

    function renderCharts(data) {
      // Trend chart (7일 기본, 30일 전환 가능)
      const tCtx = document.getElementById('trendChart');
      if(tCtx) {
        window._trendChart = new Chart(tCtx, {
          type: 'line',
          data: {
            labels: data.weekly_labels || [],
            datasets: [{
              label: '발행 건수',
              data: data.weekly_counts || [],
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.1)',
              fill: true,
              tension: 0.4,
              pointRadius: 4,
              pointBackgroundColor: '#3b82f6'
            }]
          },
          options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
        });
      }
      // Category chart
      const cCtx = document.getElementById('categoryChart');
      if(cCtx) {
        const catLabels = { implant: '임플란트', orthodontics: '교정/미용', general: '일반치료', prevention: '예방/관리', local: '지역/병원' };
        const catData = data.category_counts || {};
        const hasData = Object.values(catData).some(v => v > 0);
        new Chart(cCtx, {
          type: 'doughnut',
          data: {
            labels: hasData ? Object.keys(catData).map(k => catLabels[k] || k) : ['아직 데이터 없음'],
            datasets: [{
              data: hasData ? Object.values(catData) : [1],
              backgroundColor: hasData ? ['#3b82f6','#8b5cf6','#22c55e','#f59e0b','#ef4444'] : ['#e5e7eb']
            }]
          },
          options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } }
        });
      }
    }

    function switchChartPeriod(period) {
      document.querySelectorAll('.chart-period-btn').forEach(b => {
        b.className = 'chart-period-btn text-xs px-3 py-1 rounded-full ' + (b.dataset.period === period ? 'bg-primary-100 text-primary-700 font-medium' : 'bg-gray-100 text-gray-500');
      });
      if(window._trendChart && dashboardData) {
        const labels = period === 'month' ? dashboardData.monthly_labels : dashboardData.weekly_labels;
        const counts = period === 'month' ? dashboardData.monthly_counts : dashboardData.weekly_counts;
        window._trendChart.data.labels = labels || [];
        window._trendChart.data.datasets[0].data = counts || [];
        window._trendChart.update();
      }
    }

    // ===== Keywords =====
    async function renderKeywords() {
      const data = await api('/keywords?limit=100');
      keywordsData = data.keywords || [];
      const cats = { implant:'임플란트', orthodontics:'교정/미용', general:'일반치료', prevention:'예방/관리', local:'지역/병원' };
      const c = document.getElementById('page-content');
      c.innerHTML = \`
        <div class="card p-5 mb-6">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="flex items-center gap-3">
              <div class="relative">
                <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
                <input id="kw-search" type="text" placeholder="키워드 검색..." class="pl-9 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-primary-200 focus:border-primary-400 outline-none w-64" oninput="filterKeywords()">
              </div>
              <select id="kw-cat-filter" class="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-200 outline-none" onchange="filterKeywords()">
                <option value="">전체 카테고리</option>
                \${Object.entries(cats).map(([k,v]) => '<option value="'+k+'">'+v+'</option>').join('')}
              </select>
            </div>
            <div class="flex gap-2">
              <button onclick="showAddKeywordModal()" class="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 transition"><i class="fas fa-plus mr-1"></i> 키워드 추가</button>
            </div>
          </div>
        </div>
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">키워드</th>
                  <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">카테고리</th>
                  <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">검색의도</th>
                  <th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">우선순위</th>
                  <th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">사용횟수</th>
                  <th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">상태</th>
                  <th class="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">액션</th>
                </tr>
              </thead>
              <tbody id="kw-tbody" class="divide-y divide-gray-100">
                \${renderKeywordRows(keywordsData)}
              </tbody>
            </table>
          </div>
          <div class="px-4 py-3 bg-gray-50 text-sm text-gray-500 flex justify-between items-center">
            <span>총 <b id="kw-count">\${keywordsData.length}</b>개 키워드</span>
            <div class="flex gap-2">
              <button onclick="loadMoreKeywords()" class="text-primary-600 hover:text-primary-700 text-sm font-medium">더 보기 →</button>
            </div>
          </div>
        </div>
      \`;
    }

    function renderKeywordRows(keywords) {
      const cats = { implant:'임플란트', orthodontics:'교정/미용', general:'일반치료', prevention:'예방/관리', local:'지역/병원' };
      const catColors = { implant:'blue', orthodontics:'purple', general:'green', prevention:'yellow', local:'red' };
      const intents = { info:'정보', cost:'비용', comparison:'비교', review:'후기' };
      if(!keywords.length) return '<tr><td colspan="7" class="px-4 py-8 text-center text-gray-400">키워드가 없습니다</td></tr>';
      return keywords.map(kw => \`
        <tr class="hover:bg-gray-50">
          <td class="px-4 py-3"><span class="text-sm font-medium text-gray-800">\${kw.keyword}</span></td>
          <td class="px-4 py-3"><span class="badge" style="background:var(--tw-\${catColors[kw.category]||'gray'}-50)">\${cats[kw.category]||kw.category}</span></td>
          <td class="px-4 py-3"><span class="text-sm text-gray-600">\${intents[kw.search_intent]||kw.search_intent}</span></td>
          <td class="px-4 py-3 text-center"><span class="text-sm font-medium \${kw.priority>=80?'text-green-600':kw.priority>=50?'text-yellow-600':'text-gray-400'}">\${kw.priority}</span></td>
          <td class="px-4 py-3 text-center"><span class="text-sm text-gray-500">\${kw.used_count}</span></td>
          <td class="px-4 py-3 text-center">\${kw.is_active ? '<span class="badge badge-success">활성</span>' : '<span class="badge badge-danger">비활성</span>'}</td>
          <td class="px-4 py-3 text-center">
            <button onclick="toggleKeyword(\${kw.id},\${kw.is_active?0:1})" class="text-gray-400 hover:text-gray-600 text-sm px-2" title="\${kw.is_active?'비활성화':'활성화'}"><i class="fas fa-\${kw.is_active?'pause':'play'}"></i></button>
            <button onclick="deleteKeyword(\${kw.id})" class="text-gray-400 hover:text-red-500 text-sm px-2" title="삭제"><i class="fas fa-trash"></i></button>
          </td>
        </tr>
      \`).join('');
    }

    async function filterKeywords() {
      const search = document.getElementById('kw-search').value.toLowerCase();
      const cat = document.getElementById('kw-cat-filter').value;
      let filtered = keywordsData.filter(kw => {
        if(search && !kw.keyword.toLowerCase().includes(search)) return false;
        if(cat && kw.category !== cat) return false;
        return true;
      });
      document.getElementById('kw-tbody').innerHTML = renderKeywordRows(filtered);
      document.getElementById('kw-count').textContent = filtered.length;
    }

    async function loadMoreKeywords() {
      const data = await api('/keywords?limit=500&offset=' + keywordsData.length);
      if(data.keywords && data.keywords.length) {
        keywordsData = [...keywordsData, ...data.keywords];
        filterKeywords();
        showToast(data.keywords.length + '개 키워드 추가 로드');
      } else {
        showToast('더 이상 키워드가 없습니다', 'info');
      }
    }

    function showAddKeywordModal() {
      const cats = { implant:'임플란트', orthodontics:'교정/미용', general:'일반치료', prevention:'예방/관리', local:'지역/병원' };
      const modal = document.getElementById('modal-container');
      modal.innerHTML = \`
        <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
          <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 class="text-lg font-semibold mb-4"><i class="fas fa-plus-circle text-primary-500 mr-2"></i>키워드 추가</h3>
            <div class="space-y-4">
              <div><label class="text-sm font-medium text-gray-700 mb-1 block">키워드</label><input id="add-kw" type="text" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-200 outline-none" placeholder="예: 임플란트 비용"></div>
              <div><label class="text-sm font-medium text-gray-700 mb-1 block">카테고리</label><select id="add-cat" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">\${Object.entries(cats).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('')}</select></div>
              <div><label class="text-sm font-medium text-gray-700 mb-1 block">검색 의도</label><select id="add-intent" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"><option value="info">정보</option><option value="cost">비용</option><option value="comparison">비교</option></select></div>
              <div><label class="text-sm font-medium text-gray-700 mb-1 block">우선순위 (1~100)</label><input id="add-pri" type="number" value="50" min="1" max="100" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"></div>
            </div>
            <div class="flex justify-end gap-2 mt-6">
              <button onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">취소</button>
              <button onclick="addKeyword()" class="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700">추가</button>
            </div>
          </div>
        </div>
      \`;
    }

    async function addKeyword() {
      const kw = document.getElementById('add-kw').value.trim();
      if(!kw) return showToast('키워드를 입력하세요', 'warning');
      await api('/keywords', { method: 'POST', body: JSON.stringify({
        keyword: kw,
        category: document.getElementById('add-cat').value,
        search_intent: document.getElementById('add-intent').value,
        priority: parseInt(document.getElementById('add-pri').value) || 50
      })});
      closeModal();
      showToast('키워드가 추가되었습니다');
      renderKeywords();
    }

    async function toggleKeyword(id, active) {
      await api('/keywords/' + id, { method: 'PATCH', body: JSON.stringify({ is_active: active }) });
      showToast(active ? '키워드 활성화' : '키워드 비활성화');
      renderKeywords();
    }

    async function deleteKeyword(id) {
      if(!confirm('이 키워드를 삭제하시겠습니까?')) return;
      await api('/keywords/' + id, { method: 'DELETE' });
      showToast('키워드가 삭제되었습니다');
      renderKeywords();
    }

    // ===== Schedule =====
    async function renderSchedule() {
      const data = await api('/schedule');
      scheduleData = data;
      const c = document.getElementById('page-content');
      c.innerHTML = \`
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="card p-6">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-clock mr-2 text-primary-500"></i>발행 시간 설정</h3>
            <div class="space-y-4">
              <div>
                <label class="text-sm font-medium text-gray-700 mb-2 block">일일 발행 건수</label>
                <select id="sch-count" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" onchange="updateSchedulePreview()">
                  <option value="1" \${data.posts_per_day==1?'selected':''}>1건/일</option>
                  <option value="2" \${data.posts_per_day==2?'selected':''}>2건/일</option>
                  <option value="3" \${data.posts_per_day==3?'selected':''}>3건/일 (권장)</option>
                  <option value="5" \${data.posts_per_day==5?'selected':''}>5건/일</option>
                </select>
              </div>
              <div>
                <label class="text-sm font-medium text-gray-700 mb-2 block">발행 시간대</label>
                <div id="sch-times" class="space-y-2">
                  \${(data.publish_times||['07:00','12:00','18:00']).map((t,i) => \`
                    <div class="flex items-center gap-2">
                      <span class="text-xs text-gray-400 w-6">\${i+1}.</span>
                      <input type="time" value="\${t}" class="sch-time border border-gray-200 rounded-lg px-3 py-2 text-sm flex-1">
                    </div>
                  \`).join('')}
                </div>
              </div>
              <button onclick="saveSchedule()" class="w-full bg-primary-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition mt-4">
                <i class="fas fa-save mr-1"></i> 저장
              </button>
            </div>
          </div>
          <div class="card p-6">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-chart-pie mr-2 text-primary-500"></i>카테고리 배분</h3>
            <div class="space-y-4">
              \${renderCategoryWeights(data.category_weights || {implant:30,orthodontics:20,general:25,prevention:15,local:10})}
              <div class="pt-3 border-t border-gray-100">
                <div class="flex justify-between text-sm"><span class="text-gray-500">합계</span><span id="weight-total" class="font-semibold text-gray-900">100%</span></div>
              </div>
            </div>
          </div>
        </div>

        <div class="card p-6 mt-6">
          <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-calendar-alt mr-2 text-primary-500"></i>자동화 플로우</h3>
          <div class="flex flex-wrap gap-3 items-center text-sm">
            <div class="bg-blue-50 text-blue-700 px-4 py-2 rounded-lg"><i class="fas fa-alarm-clock mr-1"></i> 매일 06:50 트리거</div>
            <i class="fas fa-arrow-right text-gray-300"></i>
            <div class="bg-purple-50 text-purple-700 px-4 py-2 rounded-lg"><i class="fas fa-key mr-1"></i> 키워드 자동 선택</div>
            <i class="fas fa-arrow-right text-gray-300"></i>
            <div class="bg-green-50 text-green-700 px-4 py-2 rounded-lg"><i class="fas fa-robot mr-1"></i> AI 콘텐츠 생성</div>
            <i class="fas fa-arrow-right text-gray-300"></i>
            <div class="bg-orange-50 text-orange-700 px-4 py-2 rounded-lg"><i class="fas fa-image mr-1"></i> 썸네일 생성</div>
            <i class="fas fa-arrow-right text-gray-300"></i>
            <div class="bg-red-50 text-red-700 px-4 py-2 rounded-lg"><i class="fas fa-check-circle mr-1"></i> SEO 점수 검증</div>
            <i class="fas fa-arrow-right text-gray-300"></i>
            <div class="bg-teal-50 text-teal-700 px-4 py-2 rounded-lg"><i class="fas fa-paper-plane mr-1"></i> 인블로그 발행</div>
          </div>
        </div>
      \`;
    }

    function renderCategoryWeights(weights) {
      const cats = { implant:['임플란트','blue'], orthodontics:['교정/미용','purple'], general:['일반치료','green'], prevention:['예방/관리','yellow'], local:['지역/병원','red'] };
      return Object.entries(cats).map(([k,[name,color]]) => \`
        <div>
          <div class="flex justify-between text-sm mb-1"><span class="text-gray-700">\${name}</span><span class="cat-weight-val text-gray-500">\${weights[k]||0}%</span></div>
          <input type="range" min="0" max="100" step="5" value="\${weights[k]||0}" data-cat="\${k}" class="cat-weight w-full accent-\${color}-500" oninput="this.previousElementSibling.querySelector('.cat-weight-val').textContent=this.value+'%';updateWeightTotal()">
        </div>
      \`).join('');
    }

    function updateWeightTotal() {
      const total = [...document.querySelectorAll('.cat-weight')].reduce((s,el) => s + parseInt(el.value), 0);
      const el = document.getElementById('weight-total');
      if(el) { el.textContent = total + '%'; el.className = 'font-semibold ' + (total===100?'text-green-600':'text-red-600'); }
    }

    async function saveSchedule() {
      const times = [...document.querySelectorAll('.sch-time')].map(el => el.value).filter(Boolean);
      const weights = {};
      document.querySelectorAll('.cat-weight').forEach(el => { weights[el.dataset.cat] = parseInt(el.value); });
      await api('/schedule', { method: 'PUT', body: JSON.stringify({
        posts_per_day: parseInt(document.getElementById('sch-count').value),
        publish_times: times,
        category_weights: weights
      })});
      showToast('스케줄이 저장되었습니다');
    }

    // ===== History =====
    async function renderHistory() {
      const data = await api('/contents?limit=50');
      contentsData = data.contents || [];
      const c = document.getElementById('page-content');
      c.innerHTML = \`
        <div class="card p-5 mb-6">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="flex gap-2">
              <button onclick="filterHistory('')" class="tab-btn active" data-filter="">전체</button>
              <button onclick="filterHistory('published')" class="tab-btn" data-filter="published">발행됨</button>
              <button onclick="filterHistory('draft')" class="tab-btn" data-filter="draft">생성됨</button>
              <button onclick="filterHistory('failed')" class="tab-btn" data-filter="failed">실패</button>
            </div>
            <span class="text-sm text-gray-500">총 <b>\${contentsData.length}</b>건</span>
          </div>
        </div>
        <div id="history-list" class="space-y-4">
          \${renderHistoryItems(contentsData)}
        </div>
      \`;
    }

    function renderHistoryItems(items) {
      if(!items.length) return '<div class="card p-8 text-center text-gray-400"><i class="fas fa-inbox text-4xl mb-3"></i><p>발행 이력이 없습니다</p></div>';
      const statusMap = { published:['발행됨','success'], draft:['생성됨','info'], scheduled:['예약됨','warning'], failed:['실패','danger'], generating:['생성중','info'] };
      return items.map(item => {
        const [sLabel, sColor] = statusMap[item.status] || ['알수없음','info'];
        return \`
        <div class="card p-5 hover:shadow-md transition">
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-2">
                <span class="badge badge-\${sColor}">\${sLabel}</span>
                <span class="text-xs text-gray-400">\${dayjs(item.created_at).format('YYYY-MM-DD HH:mm')}</span>
                \${item.seo_score ? '<span class="text-xs font-medium '+(item.seo_score>=80?'text-green-600':'text-red-500')+'">SEO '+item.seo_score+'점</span>' : ''}
              </div>
              <h4 class="font-medium text-gray-900 truncate">\${item.title || '(제목 없음)'}</h4>
              <p class="text-sm text-gray-500 mt-1 truncate">\${item.meta_description || ''}</p>
              <div class="flex items-center gap-3 mt-2 text-xs text-gray-400">
                <span><i class="fas fa-key mr-1"></i>\${item.keyword_text}</span>
                <span><i class="fas fa-font mr-1"></i>\${item.word_count || 0}자</span>
                \${item.thumbnail_url ? '<span><i class="fas fa-image mr-1"></i>썸네일</span>' : ''}
              </div>
            </div>
            <div class="flex gap-2 flex-shrink-0">
              <button onclick="previewContent(\${item.id})" class="text-gray-400 hover:text-primary-500 p-2" title="미리보기"><i class="fas fa-eye"></i></button>
              \${item.status==='draft' ? '<button onclick="publishContent('+item.id+')" class="text-gray-400 hover:text-green-500 p-2" title="발행"><i class="fas fa-paper-plane"></i></button>' : ''}
            </div>
          </div>
        </div>
      \`;}).join('');
    }

    function filterHistory(status) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-filter="'+status+'"]').classList.add('active');
      const filtered = status ? contentsData.filter(i => i.status === status) : contentsData;
      document.getElementById('history-list').innerHTML = renderHistoryItems(filtered);
    }

    async function previewContent(id) {
      const data = await api('/contents/' + id);
      const item = data.content || data;
      const modal = document.getElementById('modal-container');
      modal.innerHTML = \`
        <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
          <div class="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[80vh] overflow-y-auto p-6">
            <div class="flex justify-between items-start mb-4">
              <div>
                <h3 class="text-lg font-semibold text-gray-900">\${item.title}</h3>
                <p class="text-sm text-gray-500 mt-1">\${item.meta_description || ''}</p>
              </div>
              <button onclick="closeModal()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times text-lg"></i></button>
            </div>
            \${item.thumbnail_url ? '<img src="'+item.thumbnail_url+'" class="w-full rounded-lg mb-4 max-h-64 object-cover">' : ''}
            <div class="flex gap-2 mb-4 flex-wrap">
              <span class="badge badge-info">SEO \${item.seo_score || 0}점</span>
              <span class="badge badge-info">\${item.word_count || 0}자</span>
              <span class="badge badge-info">\${item.keyword_text}</span>
            </div>
            <div class="prose prose-sm max-w-none border-t pt-4">\${item.content_html || '<p class="text-gray-400">콘텐츠가 없습니다</p>'}</div>
            <div class="flex gap-2 mt-4 pt-4 border-t">
              \${item.status==='draft'?'<button onclick="publishContent('+item.id+');closeModal()" class="bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700"><i class="fas fa-paper-plane mr-1"></i> 발행</button>':''}
              <button onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">닫기</button>
            </div>
          </div>
        </div>
      \`;
    }

    // ===== Settings =====
    async function renderSettings() {
      const data = await api('/settings');
      settingsData = data.settings || {};
      const c = document.getElementById('page-content');
      const getValue = (key) => (settingsData.find(s=>s.key===key)||{}).value || '';
      c.innerHTML = \`
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="card p-6">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-plug mr-2 text-primary-500"></i>인블로그 API</h3>
            <div class="space-y-4">
              <div><label class="text-sm font-medium text-gray-700 mb-1 block">API 키</label><div class="flex gap-2"><input id="set-inblog-key" type="password" value="\${getValue('inblog_api_key')}" class="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono" placeholder="Bearer token"><button onclick="verifyInblogKey()" class="bg-green-600 text-white px-3 py-2 rounded-lg text-xs font-medium hover:bg-green-700 whitespace-nowrap"><i class="fas fa-check-circle mr-1"></i>검증</button></div></div>
              <div id="inblog-verify-result" class="hidden p-3 rounded-lg text-sm"></div>
            </div>
          </div>
          <div class="card p-6">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-robot mr-2 text-primary-500"></i>Claude API</h3>
            <div class="space-y-4">
              <div><label class="text-sm font-medium text-gray-700 mb-1 block">API 키</label><input id="set-claude-key" type="password" value="\${getValue('claude_api_key')}" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono" placeholder="sk-ant-..."></div>
            </div>
          </div>
          <div class="card p-6">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-hospital mr-2 text-primary-500"></i>병원 설정</h3>
            <div class="space-y-4">
              <div><label class="text-sm font-medium text-gray-700 mb-1 block">병원명 <span class="text-xs text-gray-400">(내부 관리용, 콘텐츠에 노출 안 됨)</span></label><input id="set-clinic-name" type="text" value="\${getValue('clinic_name')}" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="OO치과"></div>
              <div><label class="text-sm font-medium text-gray-700 mb-1 block">지역</label><input id="set-clinic-region" type="text" value="\${getValue('clinic_region')}" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="서울 강남구"></div>
            </div>
          </div>
          <div class="card p-6">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-bell mr-2 text-primary-500"></i>알림 설정</h3>
            <div class="space-y-4">
              <div><label class="text-sm font-medium text-gray-700 mb-1 block">알림 이메일</label><input id="set-email" type="email" value="\${getValue('notification_email')}" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="admin@clinic.com"></div>
              <div class="flex items-center gap-3">
                <label class="text-sm font-medium text-gray-700">자동 발행</label>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input id="set-auto" type="checkbox" class="sr-only peer" \${getValue('auto_publish')==='true'?'checked':''}>
                  <div class="w-11 h-6 bg-gray-200 rounded-full peer peer-checked:bg-primary-600 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                </label>
              </div>
            </div>
          </div>
          <div class="card p-6 lg:col-span-2">
            <h3 class="font-semibold text-gray-900 mb-4"><i class="fas fa-gavel mr-2 text-primary-500"></i>의료 면책 문구</h3>
            <textarea id="set-disclaimer" rows="3" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">\${getValue('medical_disclaimer')}</textarea>
            <p class="text-xs text-gray-400 mt-1">모든 포스트 하단에 자동 삽입됩니다.</p>
          </div>
        </div>
        <div class="mt-6 flex justify-end">
          <button onclick="saveSettings()" class="bg-primary-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition"><i class="fas fa-save mr-1"></i> 전체 설정 저장</button>
        </div>
      \`;
    }

    async function verifyInblogKey() {
      const key = document.getElementById('set-inblog-key').value;
      const resultDiv = document.getElementById('inblog-verify-result');
      if(!key) { showToast('인블로그 API 키를 입력하세요', 'warning'); return; }
      resultDiv.className = 'p-3 rounded-lg text-sm bg-gray-50 text-gray-600';
      resultDiv.innerHTML = '<div class="spinner"></div> 검증 중...';
      try {
        const res = await api('/publish/verify', { method: 'POST', body: JSON.stringify({ api_key: key }) });
        resultDiv.className = 'p-3 rounded-lg text-sm bg-green-50 text-green-700';
        resultDiv.innerHTML = '<i class="fas fa-check-circle mr-1"></i> <strong>연결 성공!</strong> 블로그: ' + res.subdomain + '.inblog.ai | 권한: ' + res.scopes.join(', ') + (res.warning ? '<br><span class="text-yellow-600"><i class="fas fa-exclamation-triangle mr-1"></i>' + res.warning + '</span>' : '');
        showToast('인블로그 API 키 검증 성공!', 'success');
      } catch(e) {
        resultDiv.className = 'p-3 rounded-lg text-sm bg-red-50 text-red-700';
        resultDiv.innerHTML = '<i class="fas fa-times-circle mr-1"></i> ' + e.message;
      }
    }

    async function saveSettings() {
      const settings = [
        { key: 'inblog_api_key', value: document.getElementById('set-inblog-key').value },
        { key: 'claude_api_key', value: document.getElementById('set-claude-key').value },
        { key: 'clinic_name', value: document.getElementById('set-clinic-name').value },
        { key: 'clinic_region', value: document.getElementById('set-clinic-region').value },
        { key: 'notification_email', value: document.getElementById('set-email').value },
        { key: 'auto_publish', value: document.getElementById('set-auto').checked ? 'true' : 'false' },
        { key: 'medical_disclaimer', value: document.getElementById('set-disclaimer').value }
      ];
      await api('/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
      showToast('설정이 저장되었습니다');
    }

    // ===== Actions =====
    async function manualGenerate() {
      if(!confirm('수동으로 콘텐츠를 생성하시겠습니까?\\n키워드 1개가 자동 선택되어 생성됩니다.')) return;
      showToast('콘텐츠 생성 중...', 'info');
      try {
        const res = await api('/cron/generate', { method: 'POST', body: JSON.stringify({ count: 1, manual: true }) });
        showToast('콘텐츠가 생성되었습니다! (SEO: ' + (res.results?.[0]?.seo_score || '?') + '점)');
        if(currentPage === 'dashboard') renderDashboard();
        else if(currentPage === 'history') renderHistory();
      } catch(e) {}
    }

    async function publishContent(id) {
      showToast('발행 중...', 'info');
      try {
        await api('/publish/' + id, { method: 'POST' });
        showToast('발행되었습니다!');
        if(currentPage === 'history') renderHistory();
      } catch(e) {}
    }

    async function retryPublish(logId) {
      showToast('재시도 중...', 'info');
      try {
        await api('/publish/retry/' + logId, { method: 'POST' });
        showToast('재시도 완료');
        if(currentPage === 'dashboard') renderDashboard();
      } catch(e) {}
    }

    function closeModal() {
      document.getElementById('modal-container').innerHTML = '';
    }

    // ===== Init =====
    dayjs.locale('ko');
    navigate('dashboard');
    </script>
</body>
</html>`
}

export default app

// ===== Cloudflare Cron Trigger Handler =====
// wrangler.jsonc에서 [triggers] crons = ["50 21 * * *"] (UTC 21:50 = KST 06:50)
// Cloudflare Pages Functions에서는 scheduled 이벤트를 이렇게 처리
export const onRequest = app.fetch

export async function scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
  // Cron이 실행되면 내부적으로 /api/cron/generate POST를 호출
  const url = 'http://localhost/api/cron/generate'
  const request = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 0, manual: false, auto_publish: true })
  })

  try {
    const response = await app.fetch(request, env, ctx)
    const result = await response.json() as any
    console.log(`[Cron] 자동 발행 완료: ${result.message || JSON.stringify(result)}`)
  } catch (e: any) {
    console.error(`[Cron] 자동 발행 실패:`, e.message)
  }
}
