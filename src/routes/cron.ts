import { Hono } from 'hono'
import type { Bindings } from '../index'
import { classifyContentType, getTypeGuide, buildSystemPrompt, calculateSeoScore } from './contents'
import { verifyInblogApiKey, syncTags, createInblogPost, publishInblogPost, getAuthorId } from './publish'
import { injectSchemaToHtml, insertInternalLinks, sendNotification } from './enhancements'
import { autoReplenishKeywords } from './keyword-discovery'

const cronApp = new Hono<{ Bindings: Bindings }>()

// ===== 충청권 도시 로테이션 =====
const CHUNGCHEONG_CITIES = [
  '대전', '세종', '청주', '천안', '아산',
  '서산', '당진', '논산', '공주', '보령',
  '제천', '충주', '홍성', '예산', '음성',
  '진천', '괴산', '옥천', '영동', '금산'
]

// DB에서 마지막으로 사용한 도시 인덱스를 가져와 다음 도시 반환
async function getNextRegion(db: D1Database): Promise<{ region: string; index: number }> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'region_rotation_index'").first()
  let currentIndex = parseInt(row?.value as string || '0')
  if (isNaN(currentIndex) || currentIndex >= CHUNGCHEONG_CITIES.length) currentIndex = 0
  
  const region = CHUNGCHEONG_CITIES[currentIndex]
  const nextIndex = (currentIndex + 1) % CHUNGCHEONG_CITIES.length
  
  // 다음 인덱스 저장
  if (row) {
    await db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'region_rotation_index'").bind(String(nextIndex)).run()
  } else {
    await db.prepare("INSERT INTO settings (key, value, description) VALUES ('region_rotation_index', ?, '충청권 도시 로테이션 인덱스')").bind(String(nextIndex)).run()
  }
  
  return { region, index: currentIndex }
}

// ===== 콘텐츠 유형 로테이션 (균등 배분 - 비용/가격 제외) =====
const CONTENT_TYPE_ROTATION: Array<'B' | 'C' | 'D' | 'E' | 'F'> = ['B', 'C', 'E', 'D', 'F', 'B', 'E', 'C', 'F', 'B']

// ===== 제목 공식 다양화 시스템 v4 — SpamBrain 패턴 회피 =====
// 핵심 원칙: "[키워드] + [감정어] + [지역명]" 공식 반복 금지
// → 10가지 이상의 제목 공식을 키워드 의도(intent)별로 매핑
// → 지역명은 제목에서 완전 제거, 본문에만 자연 삽입

const TITLE_FORMULAS: Record<string, { patterns: string[]; examples: (kw: string) => string[] }> = {
  // 통증/공포 관련
  pain_fear: {
    patterns: [
      '~할 때 알아야 할 3가지',
      '~전에 반드시 확인하세요',
      '~경험자가 말하는 현실적 이야기',
      '~공포, 알고 나면 별거 아닙니다',
      '2026년 ~가이드: 전문의가 정리한 핵심',
      '~때문에 잠 못 이루는 분께 드리는 답변',
      '~오해와 진실, 데이터로 확인하기',
    ],
    examples: (kw) => [
      `${kw} 받기 전에 알아야 할 3가지`,
      `${kw} 전에 반드시 확인하세요 — 전문의 체크리스트`,
      `${kw} 경험자가 말하는 현실적 이야기`,
      `${kw} 공포, 알고 나면 별거 아닙니다 — 실제 데이터 공개`,
      `2026년 ${kw} 완전 가이드: 전문의가 정리한 핵심`,
      `${kw} 때문에 잠 못 이루는 분께 드리는 답변`,
      `${kw} 오해와 진실 — 발생률 2~3%의 실체`,
    ]
  },
  // 선택/비교 관련
  comparison: {
    patterns: [
      '~차이점 한눈에 비교하기',
      '~선택 기준: 이것만 알면 됩니다',
      '~결정 전 체크리스트 5가지',
      '~장단점 비교표 — 2026년 최신판',
      '~고민이라면 이 기준으로 판단하세요',
      '~뭘 골라야 할지 모르겠다면 읽어보세요',
    ],
    examples: (kw) => [
      `${kw} 차이점 한눈에 비교하기`,
      `${kw} 선택 기준: 이것만 알면 됩니다`,
      `${kw} 결정 전 체크리스트 5가지`,
      `${kw} 장단점 비교표 — 2026년 최신판`,
      `${kw} 고민이라면 이 기준으로 판단하세요`,
      `${kw} 뭘 골라야 할지 모르겠다면 읽어보세요`,
    ]
  },
  // 과정/방법
  process: {
    patterns: [
      '~전체 과정, 첫 방문부터 완료까지',
      '~이렇게 진행됩니다 — 단계별 설명',
      '~타임라인: 당일부터 6개월 후까지',
      '~전에 꼭 준비해야 할 것들',
      '~A부터 Z까지 전문의가 알려드립니다',
      '~절차가 궁금하다면 이 글 하나로 충분합니다',
    ],
    examples: (kw) => [
      `${kw} 전체 과정 — 첫 방문부터 완료까지`,
      `${kw}, 이렇게 진행됩니다 — 단계별 설명`,
      `${kw} 타임라인: 당일부터 6개월 후까지`,
      `${kw} 전에 꼭 준비해야 할 것들 — 2026년 기준`,
      `${kw} A부터 Z까지, 전문의가 정리한 핵심`,
      `${kw} 절차가 궁금하다면 이 글 하나로 충분합니다`,
    ]
  },
  // 필요성/판단
  necessity: {
    patterns: [
      '~미루면 생기는 일, 솔직히 말씀드립니다',
      '~해야 할까 말아야 할까? 판단 기준 정리',
      '~안 하면 어떻게 될까? 5년 후 시나리오',
      '~시기를 놓치면 달라지는 것들',
      '~고민 중이라면 이 글을 먼저 읽으세요',
      '~지금이 적기인지 확인하는 자가진단법',
    ],
    examples: (kw) => [
      `${kw} 미루면 생기는 일 — 솔직히 말씀드립니다`,
      `${kw}, 해야 할까 말아야 할까? 판단 기준 정리`,
      `${kw} 안 하면 어떻게 될까? 5년 후 시나리오`,
      `${kw} 시기를 놓치면 달라지는 것들`,
      `${kw} 고민 중이라면 이 글을 먼저 읽으세요`,
      `${kw}, 지금이 적기인지 확인하는 자가진단법`,
    ]
  },
  // 회복/관리
  recovery: {
    patterns: [
      '~후 회복 일지: 1일차부터 한 달까지',
      '~후 이런 증상, 정상일까 위험 신호일까?',
      '~후 관리법 — 회복 빠른 사람들의 공통점',
      '~다음 날 겪는 것들과 대처법',
      '~후 음식, 운동, 일상생활 복귀 타임라인',
      '~회복 중 하면 안 되는 것 5가지',
    ],
    examples: (kw) => [
      `${kw} 후 회복 일지: 1일차부터 한 달까지`,
      `${kw} 후 이런 증상, 정상일까 위험 신호일까?`,
      `${kw} 후 관리법 — 회복 빠른 사람들의 공통점`,
      `${kw} 다음 날 겪는 것들과 현실적 대처법`,
      `${kw} 후 음식, 운동, 일상 복귀 타임라인`,
      `${kw} 회복 중 하면 안 되는 것 5가지`,
    ]
  },
  // 일반 (fallback)
  general: {
    patterns: [
      '~에 대해 가장 많이 묻는 질문 7가지',
      '~완전 정리 — 2026년 최신 기준',
      '~첫 경험이라면 이것부터 확인하세요',
      '~핵심만 정리: 전문의가 쓴 환자용 안내서',
      '~알아야 할 모든 것, 한 글에 담았습니다',
      '~검색하다 지친 분을 위한 팩트 정리',
    ],
    examples: (kw) => [
      `${kw}에 대해 가장 많이 묻는 질문 7가지`,
      `${kw} 완전 정리 — 2026년 최신 기준`,
      `${kw} 첫 경험이라면 이것부터 확인하세요`,
      `${kw} 핵심만 정리: 전문의가 쓴 환자용 안내서`,
      `${kw} 알아야 할 모든 것, 한 글에 담았습니다`,
      `${kw} 검색하다 지친 분을 위한 팩트 정리`,
    ]
  }
}

// ===== 환자 페르소나 시스템 — 같은 키워드도 독자가 다르면 글이 달라진다 =====
const PATIENT_PERSONAS = [
  { age: '20대 대학생', trait: '처음 치과 치료를 받는', situation: '시험 기간이라 빨리 해결하고 싶은', context: '시간이 부족하고 비용 부담이 큰 학생' },
  { age: '30대 직장인', trait: '바쁜 일상 속에서 치과를 미루다 온', situation: '연차 내기가 어려워 주말 진료를 알아보는', context: '시간 효율과 빠른 복귀가 중요한 직장인' },
  { age: '40대 워킹맘', trait: '아이와 본인 치과 치료를 동시에 고민하는', situation: '남편에게 차마 말 못하고 혼자 검색 중인', context: '가사와 육아 사이에서 치료 시기를 고민하는 어머니' },
  { age: '50대 자영업자', trait: '이를 악물고 일하다 더 이상 참을 수 없어진', situation: '가게를 오래 비울 수 없어서 걱정하는', context: '매출 걱정과 건강 걱정 사이에서 갈등하는 사장님' },
  { age: '60대 은퇴자', trait: '당뇨/혈압약을 복용 중인', situation: '자녀가 걱정되니까 치과 가라고 하는', context: '전신 질환과 치과 치료의 관계가 걱정되는 어르신' },
  { age: '70대 어르신', trait: '틀니가 불편해서 고정식을 알아보는', situation: '식사할 때마다 불편하고 손자 앞에서 당당하고 싶은', context: '씹는 즐거움을 되찾고 싶은 어르신' },
  { age: '30대 임산부', trait: '임신 중 잇몸 출혈이 심해진', situation: '태아에게 영향이 갈까 봐 두려운', context: '태아 안전과 본인 치료 사이에서 고민하는 예비맘' },
  { age: '40대 남성', trait: '치과 공포증이 심한', situation: '이미 한 번 안 좋은 경험이 있어서 더 무서운', context: '과거 트라우마로 치과를 수년간 피해온 분' },
  { age: '50대 여성', trait: '갱년기 이후 치아가 약해진 것을 느끼는', situation: '거울 볼 때마다 자신감이 떨어지는', context: '호르몬 변화로 구강 건강이 급변한 분' },
  { age: '20대 사회초년생', trait: '첫 월급으로 미뤘던 치과 치료를 결심한', situation: '어디서부터 시작해야 할지 모르는', context: '치과 시스템 자체가 낯설고 두려운 사회초년생' },
]

function getPatientPersona(keyword: string, contentId: number): typeof PATIENT_PERSONAS[0] {
  // 키워드 해시 + contentId로 매번 다른 페르소나 선택
  const hash = keyword.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const idx = (hash + contentId) % PATIENT_PERSONAS.length
  return PATIENT_PERSONAS[idx]
}

// 키워드 → 의도(intent) 자동 분류
function classifyKeywordIntent(keyword: string, contentType: string): string {
  const kw = keyword.toLowerCase()
  
  // 통증/공포 키워드
  if (/통증|아프|무서|공포|두려|겁|수술|발치|마취|피/.test(kw)) return 'pain_fear'
  
  // 선택/비교 키워드
  if (/종류|차이|비교|선택|vs|어떤|추천|좋은|장단점/.test(kw)) return 'comparison'
  
  // 과정/방법/기간 키워드
  if (/과정|방법|기간|순서|절차|진행|시간|단계/.test(kw)) return 'process'
  
  // 필요성/판단 키워드
  if (/필요|해야|안 하면|미루|방치|무시|놔두|빼야/.test(kw)) return 'necessity'
  
  // 회복/관리 키워드
  if (/회복|관리|후기|주의|음식|식사|부기|붓기|세척|정상/.test(kw)) return 'recovery'
  
  // 콘텐츠 타입 기반 fallback
  if (contentType === 'E') return 'pain_fear'      // 불안/공포 해소
  if (contentType === 'D') return 'comparison'       // 비교/선택
  if (contentType === 'B') return 'process'          // 시술 과정
  if (contentType === 'C') return 'recovery'         // 회복/주의
  if (contentType === 'F') return 'necessity'        // 적응증/필요성
  
  return 'general'
}

async function getNextTitleFormula(
  db: D1Database, keyword: string, contentType: string
): Promise<{ pattern: string; example: string; emotion: string; intent: string }> {
  const intent = classifyKeywordIntent(keyword, contentType)
  const formulaSet = TITLE_FORMULAS[intent] || TITLE_FORMULAS.general
  
  // 같은 intent 내에서 로테이션 (DB 카운터)
  const rotKey = `title_formula_idx_${intent}`
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(rotKey).first()
  let idx = parseInt(row?.value as string || '0')
  if (isNaN(idx) || idx >= formulaSet.patterns.length) idx = 0
  
  const pattern = formulaSet.patterns[idx]
  const example = formulaSet.examples(keyword)[idx]
  const nextIdx = (idx + 1) % formulaSet.patterns.length
  
  if (row) {
    await db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?").bind(String(nextIdx), rotKey).run()
  } else {
    await db.prepare("INSERT INTO settings (key, value, description) VALUES (?, ?, ?)").bind(rotKey, String(nextIdx), `제목 공식 로테이션 v4 (${intent})`).run()
  }
  
  return { pattern, example, emotion: intent, intent }
}

async function getNextContentType(db: D1Database): Promise<{ type: 'B' | 'C' | 'D' | 'E' | 'F'; index: number }> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'content_type_rotation_index'").first()
  let currentIndex = parseInt(row?.value as string || '0')
  if (isNaN(currentIndex) || currentIndex >= CONTENT_TYPE_ROTATION.length) currentIndex = 0
  
  const type = CONTENT_TYPE_ROTATION[currentIndex]
  const nextIndex = (currentIndex + 1) % CONTENT_TYPE_ROTATION.length
  
  if (row) {
    await db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'content_type_rotation_index'").bind(String(nextIndex)).run()
  } else {
    await db.prepare("INSERT INTO settings (key, value, description) VALUES ('content_type_rotation_index', ?, '콘텐츠 유형 로테이션 인덱스')").bind(String(nextIndex)).run()
  }
  
  return { type, index: currentIndex }
}

// ===== 내부 링크용 기존 발행글 조회 =====
async function getPublishedPosts(db: D1Database, excludeKeyword?: string): Promise<{ title: string; slug: string; keyword: string; category: string }[]> {
  // 인블로그에 실제 존재하는 글만 참조 (publish_logs에 inblog_url이 있고 status=published인 것만)
  // 삭제된 테스트 포스팅의 죽은 링크 방지
  const rows = await db.prepare(
    `SELECT c.title, c.slug, c.keyword_text as keyword, k.category 
     FROM contents c 
     LEFT JOIN keywords k ON c.keyword_id = k.id
     INNER JOIN publish_logs pl ON pl.content_id = c.id AND pl.status = 'published' AND pl.inblog_url IS NOT NULL
     WHERE c.status = 'published' AND c.is_live = 1
     ORDER BY c.created_at DESC LIMIT 30`
  ).all()
  return (rows.results || []).map((r: any) => ({
    title: r.title,
    slug: r.slug,
    keyword: r.keyword,
    category: r.category || 'general'
  }))
}

// POST /api/cron/generate - 자동/수동 콘텐츠 생성 + 선택적 자동 발행
cronApp.post('/', async (c) => {
  try {
  const body = await c.req.json().catch(() => ({}))
  const requestedCount = (body as any).count || 0
  const isManual = (body as any).manual || false
  const autoPublishOverride = (body as any).auto_publish // true/false 직접 지정

  // 스케줄 설정
  const schedule: any = await c.env.DB.prepare("SELECT * FROM schedules WHERE name = 'default'").first()
  const postsPerDay = schedule?.posts_per_day || 5
  
  // ===== 새벽 한방 발행 전략 =====
  // Cloudflare Cron Trigger가 새벽(KST 02:00~05:30)에 5번 호출
  // 각 호출 시 1건씩 생성+발행 → Workers 타임아웃 걱정 없음
  // 수동 호출 시에는 지정 건수 사용
  let count: number
  if (requestedCount > 0) {
    count = requestedCount // 수동: 지정 건수
  } else if (!isManual) {
    // Cron 자동 호출: 항상 1건씩 (타임아웃 안전)
    // 하루 총 발행 수는 cron 호출 횟수(5회)로 제어
    count = 1
  } else {
    count = postsPerDay // 슬롯 미지정 수동: 전체
  }
  const categoryWeights = JSON.parse(schedule?.category_weights || '{"implant":30,"orthodontics":25,"general":25,"prevention":15,"local":5}')

  // 자동 발행 설정 확인
  if (!isManual) {
    const autoRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'auto_publish'").first()
    if (autoRow?.value === 'false') {
      return c.json({ message: '자동 발행이 비활성화되어 있습니다.', results: [] })
    }
  }

  // Claude API 키 확인
  const claudeKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'claude_api_key'").first()
  const claudeApiKey = claudeKeyRow?.value as string || c.env.CLAUDE_API_KEY || ''
  if (!claudeApiKey) {
    return c.json({ error: 'Claude API 키가 설정되지 않았습니다.' }, 400)
  }

  // 설정값 로드
  const disclaimerRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'medical_disclaimer'").first()
  const regionRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'clinic_region'").first()
  const minScoreRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'seo_min_score'").first()
  const autoPublishRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'auto_publish'").first()
  const inblogKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()

  const disclaimer = disclaimerRow?.value as string || '본 글은 일반적인 의료 정보를 제공하기 위한 목적으로 작성되었습니다. 개인의 구강 상태에 따라 진단과 치료 방법이 달라질 수 있으므로, 정확한 진단과 치료 계획은 반드시 치과의사와 상담하시기 바랍니다.'
  const regionSetting = regionRow?.value as string || '' // settings에서 고정 지역 (비어있으면 로테이션 사용)
  const minScore = parseInt(minScoreRow?.value as string || '80')
  const shouldAutoPublish = autoPublishOverride !== undefined
    ? autoPublishOverride
    : (autoPublishRow?.value === 'true')
  const inblogApiKey = inblogKeyRow?.value as string || c.env.INBLOG_API_KEY || ''

  // ===== 키워드 자동 보충 (매일 Cron 실행 시 잔여량 체크) =====
  let replenishResult: any = null
  try {
    replenishResult = await autoReplenishKeywords(c.env.DB, {
      postsPerDay: postsPerDay,
      thresholdDays: 30,  // 30일 미만이면 보충
      targetDays: 90      // 90일분(450개)까지 채움
    })
    if (replenishResult.triggered) {
      console.log(`[키워드 자동 보충] ${replenishResult.saved}개 추가 (${replenishResult.reason})`)
    }
  } catch (e: any) {
    console.error('[키워드 자동 보충 실패]', e.message)
  }

  // ===== 중복 키워드 방지: 이미 콘텐츠가 있는 키워드 ID 수집 =====
  const usedKeywordRows = await c.env.DB.prepare(
    "SELECT DISTINCT keyword_id FROM contents WHERE keyword_id IS NOT NULL"
  ).all()
  const usedKeywordIds = new Set((usedKeywordRows.results || []).map((r: any) => r.keyword_id))

  // 키워드 자동 선택 (카테고리 가중치 기반 + 중복 제외)
  const totalWeight = Object.values(categoryWeights).reduce((s: number, v: any) => s + (v as number), 0)
  const keywords: any[] = []

  // 차단 키워드 필터 (비용/보험 + 후기/추천 + 쓰레기 키워드)
  const COST_INSURANCE_FILTER = /비용|가격|할부|할인|보험|실비|실손|급여|비급여|건강보험|얼마|가격대|잘하는\s*(곳|치과)|추천\s*(병원|치과)|후기|리뷰|맛집|환절기|황사|알레르기|구내염|마스크\s*구취/

  // ===== 가중치 기반 카테고리 할당 (count가 작을 때도 정확히 동작) =====
  // Largest Remainder Method: 소수점 이하를 버리지 않고, 나머지가 큰 순서대로 1개씩 배분
  const catEntries = Object.entries(categoryWeights)
  const rawShares = catEntries.map(([cat, w]) => ({
    cat,
    raw: count * ((w as number) / totalWeight),
    floor: Math.floor(count * ((w as number) / totalWeight)),
    remainder: (count * ((w as number) / totalWeight)) % 1
  }))
  let allocated = rawShares.reduce((s, r) => s + r.floor, 0)
  // 나머지가 큰 순서로 +1씩 배분
  rawShares.sort((a, b) => b.remainder - a.remainder)
  for (const share of rawShares) {
    if (allocated >= count) break
    if (share.remainder > 0) {
      share.floor += 1
      allocated += 1
    }
  }
  // 그래도 부족하면 (count=1인데 모든 remainder가 0인 극단적 경우) 가중치 최대 카테고리에 1 배분
  if (allocated < count) {
    const maxCat = rawShares.reduce((a, b) => (categoryWeights[a.cat] > categoryWeights[b.cat] ? a : b))
    maxCat.floor += (count - allocated)
  }

  for (const { cat, floor: catCount } of rawShares) {
    if (catCount === 0) continue

    // 우선: 아직 콘텐츠가 없는 키워드 (비용/보험 키워드 제외)
    const results = await c.env.DB.prepare(
      `SELECT * FROM keywords 
       WHERE is_active = 1 AND category = ?
       ORDER BY used_count ASC, priority DESC, RANDOM()
       LIMIT ?`
    ).bind(cat, catCount * 5).all() // 5배로 가져와서 비용/보험 필터링 후 선별
    
    const allResults = (results.results || []).filter((k: any) => !COST_INSURANCE_FILTER.test(k.keyword))
    const filtered = allResults.filter((k: any) => !usedKeywordIds.has(k.id))
    const fallback = allResults.filter((k: any) => usedKeywordIds.has(k.id))
    // 미사용 키워드 우선, 부족하면 기사용 키워드도 허용
    keywords.push(...filtered.slice(0, catCount), ...fallback.slice(0, Math.max(0, catCount - filtered.length)))
  }

  // 부족하면 추가 (중복 방지 필터 적용)
  if (keywords.length < count) {
    const excludeIds = keywords.map((k: any) => k.id).join(',') || '0'
    const extra = await c.env.DB.prepare(
      `SELECT * FROM keywords 
       WHERE is_active = 1 AND id NOT IN (${excludeIds})
       ORDER BY used_count ASC, priority DESC, RANDOM()
       LIMIT ?`
    ).bind((count - keywords.length) * 3).all()
    // 비용/보험 키워드 제외 + 미사용 우선
    const extraAll = (extra.results || []).filter((k: any) => !COST_INSURANCE_FILTER.test(k.keyword))
    const extraFiltered = extraAll.filter((k: any) => !usedKeywordIds.has(k.id))
    const extraFallback = extraAll.filter((k: any) => usedKeywordIds.has(k.id))
    keywords.push(...extraFiltered, ...extraFallback)
  }

  const selectedKeywords = keywords.slice(0, count)
  const results: any[] = []
  console.log(`[Cron] count=${count}, keywords pool=${keywords.length}, selected=${selectedKeywords.length}, isManual=${isManual}`)

  // Inblog API 정보 사전 검증 (자동 발행 시)
  let inblogApiInfo: any = null
  if (shouldAutoPublish && inblogApiKey) {
    try {
      inblogApiInfo = await verifyInblogApiKey(inblogApiKey)
    } catch (e: any) {
      console.error('Inblog API 키 검증 실패:', e.message)
    }
  }

  // 각 키워드별 콘텐츠 생성
  for (const kw of selectedKeywords) {
    try {
      // 콘텐츠 유형: 키워드 자동 분류 + 로테이션 강제 배분 (균등화)
      const classified = classifyContentType(kw.keyword, kw.search_intent || 'info')
      const rotatedType = await getNextContentType(c.env.DB)
      // 키워드가 명확히 특정 유형(E=불안, C=회복)이면 그걸 존중, 아니면 로테이션
      const finalType = (classified.type === 'E' || classified.type === 'C' || classified.type === 'D') 
        ? classified.type 
        : rotatedType.type
      const typeGuide = getTypeGuide(finalType)
      // classified 정보도 최종 유형으로 업데이트
      classified.type = finalType as any
      classified.label = finalType === 'B' ? '시술 과정/방법' : finalType === 'C' ? '회복/주의사항' : finalType === 'D' ? '비교/선택' : finalType === 'E' ? '불안/공포 해소' : '적응증/필요성'

      // 충청권 도시 로테이션 — 매 콘텐츠마다 다른 도시
      const regionInfo = regionSetting 
        ? { region: regionSetting, index: -1 }  // settings에 고정 지역이 있으면 그걸 사용
        : await getNextRegion(c.env.DB)          // 없으면 충청권 로테이션
      const region = regionInfo.region

      // ===== v3: 지역 콘텐츠 중복 방지 — 같은 키워드가 14일 내 다른 도시로 발행되었는지 체크 =====
      const recentSameKeyword = await c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM contents 
         WHERE keyword_text = ? AND created_at > datetime('now', '-14 days')`
      ).bind(kw.keyword).first()
      if ((recentSameKeyword?.cnt as number) > 0 && !isManual) {
        console.log(`[v3 중복방지] 키워드 "${kw.keyword}"가 14일 내 이미 발행됨, 스킵`)
        // used_count 올리지 않고 다음 키워드로
        continue
      }

      // 내부 링크용 기존 발행글 목록 조회
      const existingPosts = await getPublishedPosts(c.env.DB, kw.keyword)

      // 제목 공식 v4 — 키워드 의도(intent) 기반 다양화
      const titleFormula = await getNextTitleFormula(c.env.DB, kw.keyword, classified.type)
      console.log(`[제목v4] intent=${titleFormula.intent}, pattern="${titleFormula.pattern}" (${kw.keyword})`)

      // 환자 페르소나 선택 — 같은 키워드도 페르소나에 따라 내용이 달라진다
      const todayCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM contents WHERE created_at > datetime('now', '-1 day')"
      ).first()
      const persona = getPatientPersona(kw.keyword, (todayCount?.cnt as number) || 0)
      console.log(`[페르소나] ${persona.age} / ${persona.trait} (${kw.keyword})`)

      // Claude API 호출 (1회 — 내부에서 Opus→Sonnet 자동 폴백)
      let bestContent: any = null
      let attempts = 1

      try {
        const generated = await callClaude(
          claudeApiKey, kw.keyword, region, disclaimer,
          classified.type, typeGuide, classified.question, classified.emotion,
          existingPosts, titleFormula, persona
        )
        const seoScore = calculateSeoScore(generated, kw.keyword)
        bestContent = { ...generated, seo_score: seoScore, attempts }
      } catch (e: any) {
        throw e  // 폴백까지 전부 실패 → 에러 전파
      }

      if (!bestContent) throw new Error('콘텐츠 생성 실패')

      // === 0.5단계: 비용/보험 콘텐츠 후처리 (Claude가 여전히 삽입할 경우 제거) ===
      const COST_REMOVAL_PATTERNS = [
        /보험\s*적용[^<]{0,100}/g,
        /실비[^<]{0,50}/g,
        /급여[^<]{0,50}/g,
        /비급여[^<]{0,50}/g,
        /건강보험[^<]{0,80}/g,
        /\d+만\s*원[^<]{0,50}/g,
        /<details[^>]*>[\s\S]*?(보험|실비|급여|비용|가격|만\s*원)[\s\S]*?<\/details>/gi,
      ]
      let cleanedHtml = bestContent.content_html
      for (const pat of COST_REMOVAL_PATTERNS) {
        // FAQ details 태그 전체 제거 (비용 관련)
        cleanedHtml = cleanedHtml.replace(pat, '')
      }
      bestContent.content_html = cleanedHtml

      // === 1단계: 콘텐츠를 먼저 DB에 저장 (이미지 없이) ===
      let finalHtml = bestContent.content_html
      
      const insertResult = await c.env.DB.prepare(
        `INSERT INTO contents (keyword_id, keyword_text, title, slug, meta_description, content_html, tags, faq_json, thumbnail_url, thumbnail_prompt, seo_score, word_count, generation_attempts, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, 'draft')`
      ).bind(
        kw.id, kw.keyword, bestContent.title, bestContent.slug,
        bestContent.meta_description, finalHtml,
        JSON.stringify(bestContent.tags), JSON.stringify(bestContent.faq),
        bestContent.seo_score, bestContent.word_count, bestContent.attempts
      ).run()

      const contentId = insertResult.meta.last_row_id as number

      // === 2단계: AI 이미지 생성 (썸네일 + 본문 이미지) ===
      let thumbnailUrl = ''
      
      // 2-A: 썸네일 (1200×630, OG 이미지용)
      try {
        const thumbResult = await generateAIImage(
          c.env, kw.keyword, kw.category || 'general', 'thumbnail', classified.type, contentId
        )
        thumbnailUrl = thumbResult.url
        
        if (thumbnailUrl.startsWith('data:')) {
          console.warn('[이미지] data URI 감지 → Pollinations 폴백 강제 전환')
          const seed = Math.abs(Date.now() % 999999)
          const encodedPrompt = encodeURIComponent(`Clean modern dental medical illustration about ${kw.keyword}, soft pastel colors, no text`.substring(0, 180))
          thumbnailUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1200&height=630&seed=${seed}&nologo=true`
        }
      } catch (imgErr: any) {
        console.error('이미지 생성 실패, 폴백 사용:', imgErr.message)
        thumbnailUrl = `https://placehold.co/1200x630/e8f4fd/2563eb?text=${encodeURIComponent(kw.keyword)}&font=sans-serif`
      }

      // 2-B: 본문 내 이미지 자동 삽입 (IMAGE_SLOT 마커 교체)
      // Claude가 <!-- IMAGE_SLOT:설명 --> 마커를 삽입, 여기서 실제 이미지로 교체
      const imageSlotRegex = /<!--\s*IMAGE_SLOT:(.*?)\s*-->/g
      const imageSlots: { marker: string; description: string }[] = []
      let slotMatch
      while ((slotMatch = imageSlotRegex.exec(finalHtml)) !== null) {
        imageSlots.push({ marker: slotMatch[0], description: slotMatch[1].trim() })
      }
      
      // 최대 2장까지 본문 이미지 생성 (Workers 타임아웃 대응)
      const maxBodyImages = Math.min(imageSlots.length, 2)
      for (let imgIdx = 0; imgIdx < maxBodyImages; imgIdx++) {
        const slot = imageSlots[imgIdx]
        try {
          const bodyImgResult = await generateBodyImage(
            c.env, kw.keyword, slot.description, contentId, imgIdx, classified.type
          )
          if (bodyImgResult.url) {
            const altText = slot.description || `${kw.keyword} 관련 의료 일러스트`
            const imgHtml = `<figure style="margin:24px 0"><img src="${bodyImgResult.url}" alt="${altText}" style="width:100%;border-radius:8px;max-height:500px;object-fit:cover" loading="lazy"><figcaption style="text-align:center;font-size:13px;color:#888;margin-top:8px">▲ ${altText}</figcaption></figure>`
            finalHtml = finalHtml.replace(slot.marker, imgHtml)
            console.log(`[본문이미지] ${imgIdx + 1}/${maxBodyImages} 삽입 완료: ${altText.substring(0, 40)}`)
          }
        } catch (bodyImgErr: any) {
          console.warn(`[본문이미지] ${imgIdx + 1} 생성 실패, 마커 제거:`, bodyImgErr.message)
          finalHtml = finalHtml.replace(slot.marker, '')
        }
      }
      // 남은 미처리 슬롯 제거
      finalHtml = finalHtml.replace(/<!--\s*IMAGE_SLOT:.*?\s*-->/g, '')

      // === 3단계: 이미지 URL을 HTML에 삽입하고 DB 업데이트 ===
      finalHtml = `<figure style="margin:0 0 24px 0"><img src="${thumbnailUrl}" alt="${kw.keyword} 대표 이미지" style="width:100%;border-radius:8px;max-height:400px;object-fit:cover" loading="lazy"></figure>` + finalHtml

      // === 3.5단계: 내부 링크 자동 삽입 ===
      if (existingPosts.length > 0) {
        const postListForLinks = existingPosts.map((p, idx) => ({
          id: idx, title: p.title, slug: p.slug, keyword: p.keyword, category: p.category
        }))
        const { html: linkedHtml } = insertInternalLinks(
          finalHtml, kw.keyword, postListForLinks, kw.category || 'general', 3
        )
        finalHtml = linkedHtml
      }

      // === 3.6단계: FAQ Schema(JSON-LD) + Article Schema 자동 삽입 ===
      finalHtml = injectSchemaToHtml(finalHtml, JSON.stringify(bestContent.faq), {
        title: bestContent.title,
        meta_description: bestContent.meta_description,
        slug: bestContent.slug,
        keyword_text: kw.keyword,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        word_count: bestContent.word_count,
        thumbnail_url: thumbnailUrl
      })

      // === 3.7단계: 목차(TOC) 자동 생성 — H2 앵커 기반, Featured Snippet 최적화 ===
      const tocH2Matches = [...finalHtml.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)]
      if (tocH2Matches.length >= 3) {
        // H2에 id 속성 추가 (앵커 링크용)
        let tocItems = ''
        let h2Index = 0
        finalHtml = finalHtml.replace(/<h2([^>]*)>(.*?)<\/h2>/gi, (match, attrs, text) => {
          const cleanText = text.replace(/<[^>]*>/g, '').trim()
          const anchorId = `section-${h2Index}`
          h2Index++
          tocItems += `<li style="margin:4px 0"><a href="#${anchorId}" style="color:#2563eb;text-decoration:none;font-size:15px">${cleanText}</a></li>\n`
          // id가 이미 있으면 교체, 없으면 추가
          if (/id=/.test(attrs)) {
            return `<h2${attrs.replace(/id="[^"]*"/, `id="${anchorId}"`)}>${text}</h2>`
          }
          return `<h2 id="${anchorId}"${attrs}>${text}</h2>`
        })

        // 목차 HTML (썸네일 바로 뒤, 본문 시작 전에 삽입)
        const tocHtml = `<nav style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:12px;padding:20px 24px;margin:0 0 28px 0">
<p style="font-weight:700;font-size:16px;color:#0369a1;margin:0 0 12px 0">📋 이 글의 목차</p>
<ol style="margin:0;padding-left:20px;line-height:1.8">
${tocItems}</ol>
</nav>\n`
        
        // 썸네일 figure 태그 바로 뒤에 삽입
        const thumbEnd = finalHtml.indexOf('</figure>')
        if (thumbEnd !== -1) {
          finalHtml = finalHtml.slice(0, thumbEnd + 9) + '\n' + tocHtml + finalHtml.slice(thumbEnd + 9)
        } else {
          finalHtml = tocHtml + finalHtml
        }
        console.log(`[TOC] 목차 ${tocH2Matches.length}개 항목 삽입 완료`)
      }

      // === 3.8단계: 소프트 CTA 자동 삽입 (의료 면책 조항 바로 위) ===
      const CTA_TEMPLATES = [
        {
          emoji: '💬',
          heading: '이 글이 도움이 되셨나요?',
          body: `${kw.keyword}에 대해 더 궁금한 점이 있으시다면, 가까운 치과에 방문하여 전문의와 상담해보세요. 정확한 진단을 받으면 막연한 걱정이 구체적인 계획으로 바뀝니다.`,
          action: '📌 이 글을 저장해두시면 나중에 치과 방문 시 참고하실 수 있습니다.'
        },
        {
          emoji: '🔖',
          heading: '다음에 치과 방문하실 때 기억하세요',
          body: `오늘 읽으신 ${kw.keyword} 정보를 바탕으로, 치과에서 "제 경우에는 어떤가요?"라고 한 번 물어보세요. 본인의 상황에 맞는 구체적인 답변을 받으실 수 있습니다.`,
          action: '📌 궁금한 점을 미리 메모해서 가시면 상담이 훨씬 효율적입니다.'
        },
        {
          emoji: '✅',
          heading: '마지막으로 한 가지 더',
          body: `${kw.keyword}에 관한 정보는 시간이 지나면 달라질 수 있습니다. 최신 치료법과 본인에게 맞는 방법은 반드시 전문의와 직접 확인하시기 바랍니다.`,
          action: '📌 주변에 같은 고민을 가진 분이 계시다면 이 글을 공유해주세요.'
        }
      ]
      const ctaIndex = contentId % CTA_TEMPLATES.length
      const cta = CTA_TEMPLATES[ctaIndex]
      const ctaHtml = `\n<div style="background:linear-gradient(135deg,#f0f9ff 0%,#e0f2fe 100%);border:1px solid #bae6fd;border-radius:12px;padding:24px 28px;margin:32px 0 24px 0">
<p style="font-weight:700;font-size:17px;color:#0369a1;margin:0 0 12px 0">${cta.emoji} ${cta.heading}</p>
<p style="font-size:15px;color:#334155;line-height:1.7;margin:0 0 12px 0">${cta.body}</p>
<p style="font-size:14px;color:#0369a1;margin:0;font-weight:500">${cta.action}</p>
</div>\n`
      // 의료 면책 div 앞에 삽입
      const disclaimerDivIdx = finalHtml.indexOf('<div style="background:#f0f7ff')
      if (disclaimerDivIdx !== -1) {
        finalHtml = finalHtml.slice(0, disclaimerDivIdx) + ctaHtml + finalHtml.slice(disclaimerDivIdx)
      } else {
        // 면책 div 없으면 schema script 앞에 삽입
        const schemaIdx = finalHtml.indexOf('<script type="application/ld+json">')
        if (schemaIdx !== -1) {
          finalHtml = finalHtml.slice(0, schemaIdx) + ctaHtml + finalHtml.slice(schemaIdx)
        } else {
          finalHtml += ctaHtml
        }
      }
      console.log(`[CTA] 소프트 CTA 삽입 완료 (템플릿 #${ctaIndex + 1})`)

      // DB 업데이트 (이미지 URL + 내부 링크 + Schema + TOC + CTA 포함 최종 HTML)
      await c.env.DB.prepare(
        `UPDATE contents SET content_html = ?, thumbnail_url = ? WHERE id = ?`
      ).bind(finalHtml, thumbnailUrl, contentId).run()

      // 키워드 사용횟수 업데이트
      await c.env.DB.prepare(
        "UPDATE keywords SET used_count = used_count + 1, last_used_at = datetime('now') WHERE id = ?"
      ).bind(kw.id).run()

      // === 자동 발행 ===
      let publishStatus = 'draft'
      let inblogUrl = ''
      let inblogPostId = ''

      if (shouldAutoPublish && inblogApiKey && inblogApiInfo) {
        try {
          // 태그 동기화
          const syncedTags = await syncTags(inblogApiKey, bestContent.tags || [])
          const tagIds = syncedTags.map((t: any) => t.id)

          // 작성자 ID 가져오기 ("대표원장 문석준")
          const authorId = await getAuthorId(inblogApiKey)

          // Inblog에 포스트 생성 — 작성자 포함
          const createResult = await createInblogPost(inblogApiKey, {
            title: bestContent.title,
            slug: bestContent.slug,
            description: bestContent.meta_description,
            content_html: finalHtml,
            meta_description: bestContent.meta_description,
            image: thumbnailUrl
          }, tagIds, authorId)

          inblogPostId = createResult.id

          // 즉시 발행
          await publishInblogPost(inblogApiKey, inblogPostId, 'publish')

          inblogUrl = `https://${inblogApiInfo.subdomain}.inblog.ai/${bestContent.slug}`
          publishStatus = 'published'

          // 발행 로그 기록
          await c.env.DB.prepare(
            `INSERT INTO publish_logs (content_id, inblog_post_id, inblog_url, status, scheduled_at, published_at)
             VALUES (?, ?, ?, 'published', datetime('now'), datetime('now'))`
          ).bind(contentId, inblogPostId, inblogUrl).run()

          // 콘텐츠 상태 업데이트
          await c.env.DB.prepare(
            `UPDATE contents SET status = 'published', updated_at = datetime('now') WHERE id = ?`
          ).bind(contentId).run()

          // === 검색엔진 즉시 색인 요청 ===
          try {
            await requestSearchEngineIndexing(inblogUrl, c.env.DB)
            console.log(`[색인요청] ${inblogUrl} → Bing/Naver/Google 전송 완료`)
          } catch (indexErr: any) {
            console.warn(`[색인요청] 실패 (무시): ${indexErr.message}`)
          }

        } catch (pubErr: any) {
          console.error(`자동 발행 실패 (${kw.keyword}):`, pubErr.message)
          // 발행 실패해도 콘텐츠 생성은 성공으로 기록
          await c.env.DB.prepare(
            `INSERT INTO publish_logs (content_id, status, error_message, scheduled_at)
             VALUES (?, 'failed', ?, datetime('now'))`
          ).bind(contentId, pubErr.message).run()
        }
      }

      results.push({
        content_id: contentId,
        keyword: kw.keyword,
        title: bestContent.title,
        seo_score: bestContent.seo_score,
        content_type: classified.type,
        content_type_label: classified.label,
        region: region,
        status: publishStatus,
        inblog_url: inblogUrl || null,
        inblog_post_id: inblogPostId || null,
        thumbnail: thumbnailUrl
      })
    } catch (e: any) {
      results.push({ keyword: kw.keyword, error: e.message, status: 'failed' })
    }
  }

  const successCount = results.filter(r => !r.error).length
  const publishedCount = results.filter(r => r.status === 'published').length
  const failedCount = results.filter(r => r.error).length

  // === 알림 전송 ===
  try {
    if (successCount > 0) {
      await sendNotification(c.env.DB, {
        type: publishedCount > 0 ? 'publish_success' : 'cron_complete',
        title: `콘텐츠 ${isManual ? '수동' : '자동'} 생성 완료`,
        message: `${successCount}/${count}건 생성, ${publishedCount}건 발행${failedCount > 0 ? `, ${failedCount}건 실패` : ''}`,
        details: results.map((r: any) => ({
          keyword: r.keyword,
          seo_score: r.seo_score,
          status: r.status || (r.error ? 'failed' : 'draft'),
          inblog_url: r.inblog_url
        })),
        url: 'https://inblogauto.pages.dev'
      })
    }
    if (failedCount > 0) {
      await sendNotification(c.env.DB, {
        type: 'publish_failed',
        title: `⚠️ 콘텐츠 생성 실패 알림`,
        message: `${failedCount}건 실패: ${results.filter((r: any) => r.error).map((r: any) => r.keyword).join(', ')}`,
        details: results.filter((r: any) => r.error)
      })
    }
  } catch (notifErr: any) {
    console.error('알림 전송 실패:', notifErr.message)
  }

  return c.json({
    message: `${successCount}/${count}건 생성, ${publishedCount}건 자동 발행 완료`,
    auto_publish: shouldAutoPublish,
    keyword_replenish: replenishResult ? {
      triggered: replenishResult.triggered,
      saved: replenishResult.saved,
      reason: replenishResult.reason
    } : null,
    results,
    debug: { count, selectedKeywords: selectedKeywords.length, keywordsPool: keywords.length, isManual }
  })
  } catch (outerErr: any) {
    return c.json({ error: 'Cron 라우트 오류: ' + (outerErr?.message || String(outerErr)), stack: outerErr?.stack?.substring(0, 500) }, 500)
  }
})

// ===== Claude API 호출 (v4 — 제목 다양화 + 페르소나 + 지역명 본문만) =====
async function callClaude(
  apiKey: string, keyword: string, region: string, disclaimer: string,
  contentType: string, typeGuide: string, patientQuestion: string, emotion?: string,
  existingPosts?: { title: string; slug: string; keyword: string; category: string }[],
  titleFormula?: { pattern: string; example: string; emotion: string },
  persona?: { age: string; trait: string; situation: string; context: string }
) {
  const systemPrompt = buildSystemPrompt(keyword, contentType as any, typeGuide, patientQuestion, disclaimer, emotion)

  // 내부 링크용 기존 글 목록 (관련성 높은 것만 전달)
  let internalLinksBlock = ''
  if (existingPosts && existingPosts.length > 0) {
    const postList = existingPosts.slice(0, 15).map(p => 
      `- "${p.title}" → https://bdbddc.inblog.ai/${p.slug} (키워드: ${p.keyword})`
    ).join('\n')
    internalLinksBlock = `
## 내부 링크 삽입 (필수 — SEO 핵심)
아래는 이미 발행된 관련 글 목록입니다. 본문 중 자연스러운 맥락에서 **2~3개**를 선택하여 <a> 태그로 삽입하세요.
- "관련 글: [제목](URL)" 형태가 아닌, **문맥 속에 자연스럽게** 링크를 녹여야 합니다
- 예시: "임플란트 수술 후 관리가 궁금하시다면 <a href='URL'>임플란트 수명과 관리법</a>을 참고하세요"
- 같은 키워드의 글은 제외하고, 관련 치료/연관 정보를 가진 글을 선택하세요

기존 발행 글:
${postList}
`
  }

  // 환자 페르소나 블록 (핵심: 독자가 다르면 글이 달라진다)
  const personaBlock = persona ? `
## 🎯 이 글의 독자 (환자 페르소나) — 반드시 이 사람을 상상하며 쓰세요
- **연령/직업**: ${persona.age}
- **특징**: ${persona.trait}
- **상황**: ${persona.situation}
- **맥락**: ${persona.context}

이 페르소나를 반영하는 방법:
- 도입부에서 이 환자의 상황을 자연스럽게 묘사 ("${persona.age}인 분이 ${persona.situation}")
- 이 환자가 특히 궁금해할 포인트를 중심으로 서술
- 이 환자의 생활 패턴에 맞는 실용적 조언 포함
- FAQ에 이 페르소나가 할 법한 질문 1~2개 포함
- ⚠️ 페르소나를 억지로 반복 언급하지 말고, 글의 톤과 관점에 자연스럽게 녹이세요
` : ''

  const userPrompt = `키워드: ${keyword}
콘텐츠 유형: ${contentType === 'A' ? '비용/가격 정보' : contentType === 'B' ? '시술 과정/방법' : contentType === 'C' ? '회복/주의사항' : contentType === 'D' ? '비교/선택' : '불안/공포 해소'}
환자의 감정: ${emotion || '불안·걱정'}
환자가 검색하게 된 마음: ${patientQuestion}
${personaBlock}
🎯 **제목 작성 가이드 v4** — 패턴 반복을 깨는 다양한 제목
- 이번 제목 공식: "${titleFormula?.pattern || '~에 대해 알아야 할 것'}"
- 예시: "${titleFormula?.example || `${keyword} 완전 정리 — 2026년 최신 기준`}"
- ⚠️ **제목에 지역명을 넣지 마세요** (지역명은 본문에만 자연스럽게 삽입)
- ⚠️ **"~무서울까?" "~아플까?" "~괜찮을까?" 패턴만 쓰지 마세요** — 위 공식을 따르세요
- 키워드 의미와 어울리는, 환자가 실제 검색창에 칠 법한 자연스러운 문장이어야 합니다
- 숫자 또는 연도(2026)를 포함하면 CTR이 높아집니다

${region ? `## 지역 정보 (본문에만 자연 삽입 — 제목 금지)
지역: ${region}
- ⚠️ **제목, 메타 디스크립션에 지역명 넣지 마세요** — 본문에서만 자연스럽게
- 본문 중 2~3곳에 자연스럽게 지역 맥락 녹이기:
  * "${region} 지역에서 이 치료를 고려하신다면..."
  * "${region}에서도 최근 이 시술을 받는 분이 늘고 있습니다"
  * "가까운 ${region} 치과에서..."
- 지역 인구 특성이나 생활 패턴을 자연스럽게 반영 (억지 언급 금지)
- slug에는 지역 영문명 포함 (예: daejeon, cheongju 등)` : ''}
연도: 2026년
${internalLinksBlock}
핵심 방향:
- 환자의 불안과 걱정을 먼저 인정하고, 구체적 정보로 해소하세요
- 비용이나 가격 정보보다 실제 치료 과정, 통증, 회복에 집중하세요
- 환자가 읽고 나서 "이 정도면 괜찮겠다"라고 느낄 수 있어야 합니다
- "치과에서 이렇게 질문해보세요" 같은 임파워먼트 문장을 포함하세요

⛔ 절대 금지: "만원", "만 원", "가격", "비용", "보험 적용", "보험", "실비", "실손", "급여", "비급여", "건강보험", "할부", "할인", "무료 상담", "무료 검진", "수가", "본인부담", "의료비", "치료비" — 이 단어들을 title, content_html, meta_description, FAQ 어디에도 절대 쓰지 마세요. 비용 관련 FAQ 질문도 포함 금지.

위 규칙에 따라 유효한 JSON만 출력하세요.`

  // Opus → Sonnet 자동 폴백 전략
  // Workers 유료 플랜 6분(360초) 제한 고려
  // Opus 4.6: 240초 (4분) — 한국어 긴 글 생성에 충분한 시간
  // Sonnet 4: 120초 (2분) — 폴백 모델, 더 빠름
  const models = [
    { id: 'claude-opus-4-6', timeout: 240000, label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-20250514', timeout: 120000, label: 'Sonnet 4' },
  ]

  let lastError = ''
  for (const model of models) {
    try {
      console.log(`[Claude] ${model.label} 시도 중... (timeout: ${model.timeout / 1000}s)`)
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model.id,
          max_tokens: 6000,
          messages: [{ role: 'user', content: userPrompt }],
          system: systemPrompt
        }),
        signal: AbortSignal.timeout(model.timeout)
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        lastError = `Claude API ${response.status} (${model.label}): ${errText.slice(0, 200)}`
        console.warn(`[Claude] ${model.label} 실패: ${lastError}`)
        continue // 다음 모델로 폴백
      }

      const data: any = await response.json()
      const text = data.content?.[0]?.text || ''
      console.log(`[Claude] ${model.label} 응답 길이: ${text.length}자, 앞 200자: ${text.substring(0, 200)}`)
      
      // JSON 추출: 코드블록 제거 후 최외곽 {..} 추출
      // Claude가 ```json ... ``` 로 감싸거나 직접 JSON을 출력함
      let cleanText = text.trim()
      // 1) ```json ... ``` 코드블록 전체 제거 (여러 종류 대응)
      // 패턴: ``` 또는 ```json 으로 시작, ``` 으로 끝
      const codeBlockMatch = cleanText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
      if (codeBlockMatch) {
        cleanText = codeBlockMatch[1].trim()
      }
      // 여전히 ``` 잔여물이 있으면 제거
      cleanText = cleanText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '')
      
      // 2) 최외곽 JSON 객체 추출 ({로 시작해서 }로 끝나는 가장 큰 블록)
      const firstBrace = cleanText.indexOf('{')
      const lastBrace = cleanText.lastIndexOf('}')
      let jsonStr = ''
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = cleanText.substring(firstBrace, lastBrace + 1)
      }
      
      if (!jsonStr) {
        lastError = `JSON 파싱 실패 (${model.label}) — 응답: ${text.substring(0, 300)}`
        console.warn(`[Claude] ${lastError}`)
        continue
      }

      // JSON 파싱 시도 — content_html 내부의 특수문자로 인한 파싱 오류 복구
      let parsed: any
      try {
        parsed = JSON.parse(jsonStr)
      } catch (parseErr: any) {
        console.warn(`[Claude] ${model.label} JSON 직접 파싱 실패: ${parseErr.message}, 복구 시도...`)
        // content_html 필드를 수동 추출하여 복구
        try {
          const titleMatch = jsonStr.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
          const slugMatch = jsonStr.match(/"slug"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
          const metaMatch = jsonStr.match(/"meta_description"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
          const htmlMatch = jsonStr.match(/"content_html"\s*:\s*"([\s\S]*?)"\s*,\s*"tags"/s)
          const tagsMatch = jsonStr.match(/"tags"\s*:\s*\[([\s\S]*?)\]/s)
          const faqMatch = jsonStr.match(/"faq"\s*:\s*\[([\s\S]*?)\]\s*[,}]/s)
          
          if (htmlMatch) {
            parsed = {
              title: titleMatch ? titleMatch[1] : keyword,
              slug: slugMatch ? slugMatch[1] : keyword.replace(/\s+/g, '-'),
              meta_description: metaMatch ? metaMatch[1] : '',
              content_html: htmlMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
              tags: [],
              faq: [],
            }
            // tags 파싱 시도
            if (tagsMatch) {
              try { parsed.tags = JSON.parse(`[${tagsMatch[1]}]`) } catch {}
            }
            // faq 파싱 시도
            if (faqMatch) {
              try { parsed.faq = JSON.parse(`[${faqMatch[1]}]`) } catch {}
            }
            console.log(`[Claude] ${model.label} JSON 복구 성공!`)
          } else {
            lastError = `JSON 복구 실패 (${model.label}): ${parseErr.message}`
            console.warn(`[Claude] ${lastError}`)
            continue
          }
        } catch (recoveryErr: any) {
          lastError = `JSON 복구 예외 (${model.label}): ${recoveryErr.message}`
          console.warn(`[Claude] ${lastError}`)
          continue
        }
      }

      const contentHtml = parsed.content_html || ''
      const plainText = contentHtml.replace(/<[^>]*>/g, '')
      console.log(`[Claude] ${model.label} 성공! (${plainText.length}자)`)

      return {
        title: parsed.title || keyword,
        slug: parsed.slug || keyword.replace(/\s+/g, '-'),
        meta_description: parsed.meta_description || '',
        content_html: contentHtml,
        tags: parsed.tags || [],
        faq: parsed.faq || [],
        word_count: plainText.length
      }
    } catch (e: any) {
      lastError = `${model.label} 오류: ${e.message}`
      console.warn(`[Claude] ${lastError}`)
      continue // 타임아웃 등 → 다음 모델로 폴백
    }
  }

  throw new Error(`모든 Claude 모델 실패: ${lastError}`)
}

const cronHandler = cronApp

// ===== 본문 이미지 생성 (섹션별 맞춤 프롬프트, 1200×800) =====
async function generateBodyImage(
  env: any, keyword: string, slotDescription: string, contentId: number, imageIndex: number, contentType: string
): Promise<{ url: string }> {
  const noText = 'absolutely no text, no letters, no words, no numbers, no labels, no captions, no watermarks anywhere in the image'
  const prompt = `High quality photorealistic 3D dental medical illustration: ${slotDescription}. Related to "${keyword}". Clean modern infographic style, soft pastel colors light blue and mint palette, ${noText}, no human faces, professional healthcare aesthetic, studio lighting, 8k quality. Image suitable for medical blog body content.`

  // fal.ai API 키
  let falApiKey = ''
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'fal_api_key'").first()
    falApiKey = row?.value as string || ''
  } catch (e) {}

  if (falApiKey) {
    // FLUX.2 pro → schnell 폴백 (본문 이미지는 2단계만)
    const models = [
      { name: 'FLUX.2 pro', url: 'https://fal.run/fal-ai/flux-pro/v1.1-ultra', body: { prompt, image_size: { width: 1200, height: 800 }, num_images: 1, safety_tolerance: '5', output_format: 'jpeg' } },
      { name: 'FLUX.1 schnell', url: 'https://fal.run/fal-ai/flux/schnell', body: { prompt, image_size: { width: 1200, height: 800 }, num_images: 1, enable_safety_checker: false } }
    ]

    for (const model of models) {
      try {
        const res = await fetch(model.url, {
          method: 'POST',
          headers: { 'Authorization': `Key ${falApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(model.body),
          signal: AbortSignal.timeout(45000)
        })
        if (res.ok) {
          const data: any = await res.json()
          const imageUrl = data?.images?.[0]?.url
          if (imageUrl) {
            // R2에 영구 저장
            if (env?.R2) {
              try {
                const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) })
                if (imgRes.ok) {
                  const buf = await imgRes.arrayBuffer()
                  const key = `images/${contentId}/body_${imageIndex}.jpg`
                  await env.R2.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { keyword, description: slotDescription.substring(0, 200) } })
                  return { url: `https://inblogauto.pages.dev/api/image/${contentId}/body_${imageIndex}.jpg` }
                }
              } catch (r2Err: any) {
                console.warn(`[본문이미지] R2 저장 실패: ${r2Err.message}`)
              }
            }
            return { url: imageUrl }
          }
        }
      } catch (e: any) {
        console.warn(`[본문이미지] ${model.name} 실패: ${e.message}`)
        continue
      }
    }
  }

  // 폴백: Pollinations
  const seed = Math.abs(Date.now() % 999999) + imageIndex
  const encodedPrompt = encodeURIComponent(prompt.substring(0, 180))
  return { url: `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1200&height=800&seed=${seed}&nologo=true&model=turbo` }
}

// ===== AI 이미지 생성 시스템 (키워드별 고유 이미지) =====

// 콘텐츠 유형별 이미지 프롬프트 템플릿
function buildImagePrompt(keyword: string, category: string, purpose: 'thumbnail' | 'illustration', contentType: string): string {
  const noText = 'absolutely no text, no letters, no words, no numbers, no labels, no captions, no watermarks anywhere in the image'
  const baseStyle = `High quality photorealistic 3D medical illustration, clean modern design, soft pastel colors with light blue and white palette, ${noText}, no human faces, no logos, professional dental healthcare aesthetic, studio lighting, cinematic composition, 8k quality, ultra-detailed`
  
  // 카테고리별 핵심 시각 요소
  const categoryVisuals: Record<string, string> = {
    implant: 'dental implant cross-section diagram, jaw bone structure, titanium screw and crown, gum tissue',
    orthodontics: 'teeth with clear aligners, beautiful smile, orthodontic treatment concept',
    general: 'healthy white tooth, dental mirror, clean oral care scene',
    prevention: 'toothbrush and toothpaste, dental floss, protective shield around tooth',
    local: 'modern dental clinic interior, comfortable dental chair, welcoming atmosphere',
  }
  
  // 콘텐츠 유형별 분위기
  const typeMood: Record<string, string> = {
    F: 'thoughtful contemplative atmosphere, warm encouraging feeling, clear visual metaphor',
    B: 'gentle procedural scene, calming medical environment, dental tools arranged neatly',
    C: 'soothing recovery atmosphere, gentle warm colors, peaceful healing vibe',
    D: 'balanced symmetrical composition, clean comparison visual',
    E: 'calming reassuring atmosphere, warm soft lighting, peaceful comforting scene',
  }
  
  const visual = categoryVisuals[category] || categoryVisuals.general
  const mood = typeMood[contentType] || typeMood.B
  
  if (purpose === 'thumbnail') {
    return `${baseStyle}, ${visual}, centered composition, simple clean background, blog hero image, ${mood}`
  } else {
    return `${baseStyle}, ${visual}, ${mood}, detailed realistic medical illustration, soft shadows, clean white background`
  }
}

// 이미지 캡션 생성
function getImageCaption(contentType: string, keyword: string): string {
  return `▲ ${keyword} 관련 이미지`
}

// 이미지를 R2 또는 D1에 저장하고 URL 반환
async function saveImageToStorage(
  env: any, contentId: number, keyword: string, imageType: string, prompt: string, base64Data: string
): Promise<string> {
  // 방법 1: R2 스토리지 사용 (우선)
  if (env?.R2) {
    try {
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
      }
      const key = `images/${contentId}/${imageType}.jpg`
      await env.R2.put(key, bytes.buffer, { 
        httpMetadata: { contentType: 'image/jpeg' },
        customMetadata: { keyword, prompt: prompt.substring(0, 200) }
      })
      // R2 퍼블릭 URL (Cloudflare Pages에서 자동 서빙) — 폴백으로 D1 API 사용
      return `https://inblogauto.pages.dev/api/image/${contentId}/${imageType}.jpg`
    } catch (r2Err: any) {
      console.error('R2 저장 실패, D1 폴백:', r2Err.message)
    }
  }

  // 방법 2: D1 폴백 (기존 방식)
  await env.DB.prepare(
    `INSERT OR REPLACE INTO generated_images (content_id, keyword, image_type, prompt, image_data, mime_type)
     VALUES (?, ?, ?, ?, ?, 'image/jpeg')`
  ).bind(contentId, keyword, imageType, prompt, base64Data).run()
  
  return `https://inblogauto.pages.dev/api/image/${contentId}/${imageType}.jpg`
}

// 메인 이미지 생성 함수 (고급 모델 우선)
async function generateAIImage(
  env: any, keyword: string, category: string, purpose: 'thumbnail' | 'illustration', contentType: string,
  contentId?: number
): Promise<{ url: string; caption: string }> {
  const prompt = buildImagePrompt(keyword, category, purpose, contentType)
  const caption = purpose === 'illustration' ? getImageCaption(contentType, keyword) : ''
  
  // ===== 방법 1: fal.ai FLUX 프리미엄 체인 (FLUX.2 pro → FLUX.1 pro → schnell) =====
  // 설정에서 fal.ai API 키 읽기
  let falApiKey = ''
  try {
    const falKeyRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'fal_api_key'").first()
    falApiKey = falKeyRow?.value as string || ''
  } catch (e) {}
  
  if (falApiKey) {
    // fal.ai 모델 우선순위 체인 (최고급 → 고급 → 기본)
    const falModels = [
      {
        name: 'FLUX.2 pro',
        url: 'https://fal.run/fal-ai/flux-pro/v1.1-ultra',
        body: {
          prompt: prompt,
          image_size: { width: 1200, height: 630 },
          num_images: 1,
          safety_tolerance: '5',
          output_format: 'jpeg',
        },
        cost: '~₩100/장'
      },
      {
        name: 'FLUX.1 pro',
        url: 'https://fal.run/fal-ai/flux-pro',
        body: {
          prompt: prompt,
          image_size: { width: 1200, height: 630 },
          num_images: 1,
          safety_tolerance: '5',
          output_format: 'jpeg',
        },
        cost: '~₩70/장'
      },
      {
        name: 'FLUX.1 schnell',
        url: 'https://fal.run/fal-ai/flux/schnell',
        body: {
          prompt: prompt,
          image_size: { width: 1200, height: 630 },
          num_images: 1,
          enable_safety_checker: false,
        },
        cost: '~₩4/장'
      }
    ]
    
    for (const model of falModels) {
      try {
        console.log(`[이미지] ${model.name} 시도 중... (${model.cost})`)
        const falResponse = await fetch(model.url, {
          method: 'POST',
          headers: {
            'Authorization': `Key ${falApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(model.body),
          signal: AbortSignal.timeout(60000) // 60초 타임아웃
        })
        
        if (falResponse.ok) {
          const falData: any = await falResponse.json()
          const imageUrl = falData?.images?.[0]?.url
          if (imageUrl) {
            console.log(`[이미지] ✅ ${model.name} 성공: ${keyword} (${purpose}) ${model.cost}`)
            
            // fal.ai URL은 임시 → R2에 영구 저장하여 엑스박스 방지
            // 빠른 저장: 10초 타임아웃, 실패해도 fal.ai URL 사용
            if (contentId && env?.R2) {
              try {
                const imgResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) })
                if (imgResponse.ok) {
                  const imgBuffer = await imgResponse.arrayBuffer()
                  const key = `images/${contentId}/${purpose}.jpg`
                  await env.R2.put(key, imgBuffer, {
                    httpMetadata: { contentType: 'image/jpeg' },
                    customMetadata: { keyword, model: model.name }
                  })
                  const permanentUrl = `https://inblogauto.pages.dev/api/image/${contentId}/${purpose}.jpg`
                  console.log(`[이미지] R2 영구 저장 완료: ${permanentUrl}`)
                  return { url: permanentUrl, caption }
                }
              } catch (r2Err: any) {
                console.warn(`[이미지] R2 저장 실패, fal.ai URL 직접 사용: ${r2Err.message}`)
              }
            }
            // R2 저장 실패 시 fal.ai URL 직접 사용 (보통 24~48시간 유효)
            return { url: imageUrl, caption }
          }
        } else {
          const errText = await falResponse.text()
          console.warn(`[이미지] ❌ ${model.name} 실패 (${falResponse.status}): ${errText.substring(0, 200)}`)
          // 다음 모델로 자동 폴백
          continue
        }
      } catch (falErr: any) {
        console.warn(`[이미지] ❌ ${model.name} 에러: ${falErr.message}`)
        // 다음 모델로 자동 폴백
        continue
      }
    }
    console.warn('[이미지] fal.ai 전체 모델 실패, 다음 방법으로 폴백')
  }
  
  // ===== 방법 2: Cloudflare Workers AI (무료 할당량 내에서) =====
  if (env?.AI) {
    try {
      const aiResult = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
        prompt: prompt,
        num_steps: 4,
      })
      const raw = (aiResult as any)?.image ?? aiResult
      
      if (raw && typeof raw === 'string' && raw.length > 1000) {
        console.log(`[이미지] Workers AI schnell 성공: ${keyword}, base64 len=${raw.length}`)
        if (contentId && env?.R2) {
          try {
            const savedUrl = await saveImageToStorage(env, contentId, keyword, purpose, prompt, raw)
            return { url: savedUrl, caption }
          } catch (r2Err: any) {
            console.error('R2 저장 실패:', r2Err.message)
          }
        }
      }
    } catch (schnellErr: any) {
      console.warn(`Workers AI schnell 실패: ${schnellErr.message}`)
    }
  }
  
  // ===== 방법 3: Pollinations AI (무료 폴백) =====
  try {
    const seed = Math.abs(hashString(keyword + purpose + contentType))
    const shortPrompt = prompt.substring(0, 200)
    const encodedPrompt = encodeURIComponent(shortPrompt)
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1200&height=630&seed=${seed}&nologo=true&model=turbo`
    
    const headCheck = await fetch(pollinationsUrl, { method: 'HEAD', signal: AbortSignal.timeout(20000) })
    if (headCheck.ok || headCheck.status === 302 || headCheck.status === 301) {
      console.log(`[이미지] Pollinations turbo 사용: ${keyword} (${purpose})`)
      return { url: pollinationsUrl, caption }
    }
  } catch (pollErr: any) {
    console.warn('Pollinations 실패:', pollErr.message)
  }

  // ===== 방법 4: 플레이스홀더 폴백 (최후의 수단) =====
  const colors = ['4A90D9', '5B8C5A', '8B5CF6', 'D97706', 'DC2626', '0891B2', '7C3AED', '059669']
  const colorIdx = Math.abs(hashString(keyword + purpose)) % colors.length
  const bg = colors[colorIdx]
  const fallbackUrl = `https://placehold.co/1200x630/${bg}/ffffff?text=${encodeURIComponent(keyword)}&font=sans-serif`
  console.log(`[이미지] 플레이스홀더 폴백: ${keyword} (${purpose})`)
  return { url: fallbackUrl, caption }
}

// 문자열 해시 (시드 생성용)
function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return hash
}

// ===== 검색엔진 즉시 색인 요청 (IndexNow + Google Ping) =====
// IndexNow: Bing, Naver, Yandex, DuckDuckGo 즉시 색인
// Google Ping: sitemap 기반 크롤링 요청
async function requestSearchEngineIndexing(url: string, db: D1Database): Promise<void> {
  // IndexNow API 키 (settings에서 읽거나 자동 생성)
  let indexNowKey = ''
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'indexnow_api_key'").first()
    indexNowKey = row?.value as string || ''
  } catch {}
  
  if (!indexNowKey) {
    // 랜덤 키 생성 후 저장 (최초 1회)
    indexNowKey = crypto.randomUUID().replace(/-/g, '')
    await db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, description) VALUES ('indexnow_api_key', ?, 'IndexNow API 키 (자동 생성)')"
    ).bind(indexNowKey).run()
  }

  const host = new URL(url).host
  const results: string[] = []

  // IndexNow 일괄 제출 (Bing, Naver, Yandex — Bing이 자동 공유하지만 직접도 보냄)
  const indexNowEndpoints = [
    { name: 'Bing', url: 'https://www.bing.com/indexnow' },
    { name: 'Naver', url: 'https://searchadvisor.naver.com/indexnow' },
    { name: 'Yandex', url: 'https://yandex.com/indexnow' },
  ]
  
  for (const endpoint of indexNowEndpoints) {
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: host,
          key: indexNowKey,
          keyLocation: `https://inblogauto.pages.dev/api/indexnow/${indexNowKey}`,
          urlList: [url]
        }),
        signal: AbortSignal.timeout(10000)
      })
      results.push(`${endpoint.name}: ${res.status}`)
    } catch (e: any) {
      results.push(`${endpoint.name}: fail`)
    }
  }

  // 4) Google Ping (sitemap 기반)
  try {
    const sitemapUrl = `https://${host}/sitemap.xml`
    const googlePing = `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`
    const res = await fetch(googlePing, { signal: AbortSignal.timeout(10000) })
    results.push(`Google Ping: ${res.status}`)
  } catch (e: any) {
    results.push(`Google Ping: fail (${e.message})`)
  }

  console.log(`[색인요청] ${results.join(' | ')}`)
}

export { cronHandler }
