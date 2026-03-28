import { Hono } from 'hono'
import type { Bindings } from '../index'
import { classifyContentType, getTypeGuide, buildSystemPrompt, calculateSeoScore } from './contents'
import { verifyInblogApiKey, syncTags, createInblogPost, publishInblogPost, getAuthorId } from './publish'
import { injectSchemaToHtml, insertInternalLinks, sendNotification, anonymizeRealNames } from './enhancements'
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

// ===== 제목 공식 다양화 시스템 v5 — 4가지 형태 강제 혼용 + 남용 키워드 제거 =====
// 형태: Q(의문형) / N(명사형) / NUM(숫자형) / EXP(경험형)
// 남용 금지: "가이드", "총정리", "완전 정리", "모든 것", "A부터 Z", "2026", "2026년"
// 지역명: 제목에서 완전 제거

type TitleType = 'Q' | 'N' | 'NUM' | 'EXP'  // 의문형 / 명사형 / 숫자형 / 경험형
const TITLE_TYPE_ROTATION: TitleType[] = ['Q', 'NUM', 'EXP', 'N', 'Q', 'EXP', 'NUM', 'N', 'EXP', 'Q']

const TITLE_FORMULAS: Record<string, { patterns: { text: string; type: TitleType }[]; examples: (kw: string) => string[] }> = {
  // 통증/공포 관련
  pain_fear: {
    patterns: [
      { text: '~, 실제로 얼마나 아플까?', type: 'Q' },                    // 의문형
      { text: '~전에 반드시 확인할 체크리스트', type: 'N' },              // 명사형
      { text: '~받기 전 알아야 할 3가지', type: 'NUM' },                  // 숫자형
      { text: '~경험자가 말하는 현실적 후기', type: 'EXP' },              // 경험형
      { text: '~, 공포의 실체와 실제 데이터', type: 'N' },               // 명사형
      { text: '~밤새 검색한 분께 드리는 팩트', type: 'EXP' },            // 경험형
      { text: '~발생률 몇 %? 수치로 보는 현실', type: 'NUM' },           // 숫자형
      { text: '~미루는 게 나을까, 바로 받는 게 나을까?', type: 'Q' },    // 의문형
    ],
    examples: (kw) => [
      `${kw}, 실제로 얼마나 아플까? 환자 데이터 공개`,
      `${kw} 전에 반드시 확인할 체크리스트`,
      `${kw} 받기 전 알아야 할 3가지 핵심`,
      `${kw} 경험자가 말하는 현실적 후기`,
      `${kw}의 공포, 실체와 실제 데이터`,
      `${kw} 밤새 검색한 분께 드리는 팩트`,
      `${kw} 발생률 몇 %? 수치로 보는 현실`,
      `${kw}, 미루는 게 나을까 바로 받는 게 나을까?`,
    ]
  },
  // 선택/비교 관련
  comparison: {
    patterns: [
      { text: '~, 뭐가 어떻게 다를까?', type: 'Q' },
      { text: '~선택 전 필수 판단 기준', type: 'N' },
      { text: '~결정 전 체크포인트 5가지', type: 'NUM' },
      { text: '~실제로 써본 사람들의 비교 후기', type: 'EXP' },
      { text: '~장단점 한눈에 비교', type: 'N' },
      { text: '~고민 중이라면 이 기준 하나로 판단하세요', type: 'EXP' },
      { text: '~어떤 게 내 상황에 맞을까?', type: 'Q' },
      { text: '~3분이면 결정할 수 있는 비교 분석', type: 'NUM' },
    ],
    examples: (kw) => [
      `${kw}, 뭐가 어떻게 다를까? 핵심 비교`,
      `${kw} 선택 전 필수 판단 기준`,
      `${kw} 결정 전 체크포인트 5가지`,
      `${kw} 실제로 써본 사람들의 비교 후기`,
      `${kw} 장단점 한눈에 비교`,
      `${kw} 고민 중이라면 이 기준 하나로 판단하세요`,
      `${kw} 어떤 게 내 상황에 맞을까?`,
      `${kw} 3분이면 결정할 수 있는 비교 분석`,
    ]
  },
  // 과정/방법
  process: {
    patterns: [
      { text: '~, 어떻게 진행될까?', type: 'Q' },
      { text: '~첫 방문부터 마무리까지 전체 흐름', type: 'N' },
      { text: '~단계별 타임라인: 당일~6개월', type: 'NUM' },
      { text: '~처음 받아본 사람이 알려주는 실제 과정', type: 'EXP' },
      { text: '~전에 꼭 준비해야 할 것들', type: 'N' },
      { text: '~절차가 궁금하다면 이 글이면 충분합니다', type: 'EXP' },
      { text: '~소요 시간과 횟수, 현실적으로 알려드립니다', type: 'NUM' },
      { text: '~마취부터 퇴원까지 궁금한 것들', type: 'Q' },
    ],
    examples: (kw) => [
      `${kw}, 어떻게 진행될까? 전체 과정 설명`,
      `${kw} 첫 방문부터 마무리까지 전체 흐름`,
      `${kw} 단계별 타임라인: 당일부터 6개월까지`,
      `${kw} 처음 받아본 사람이 알려주는 실제 과정`,
      `${kw} 전에 꼭 준비해야 할 것들`,
      `${kw} 절차가 궁금하다면 이 글이면 충분합니다`,
      `${kw} 소요 시간과 횟수, 현실적으로 알려드립니다`,
      `${kw} 마취부터 퇴원까지 궁금한 것들`,
    ]
  },
  // 필요성/판단
  necessity: {
    patterns: [
      { text: '~, 꼭 해야 할까?', type: 'Q' },
      { text: '~미루면 벌어지는 일들', type: 'N' },
      { text: '~판단 기준 3가지와 자가진단법', type: 'NUM' },
      { text: '~미뤘다가 후회한 사람들의 공통점', type: 'EXP' },
      { text: '~시기를 놓치면 달라지는 것들', type: 'N' },
      { text: '~실제로 안 하면 어떻게 될까?', type: 'Q' },
      { text: '~결심이 안 선다면 이 질문에 답해보세요', type: 'EXP' },
      { text: '~방치했을 때 1년·3년·5년 후 변화', type: 'NUM' },
    ],
    examples: (kw) => [
      `${kw}, 꼭 해야 할까? 솔직한 판단 기준`,
      `${kw} 미루면 벌어지는 일들`,
      `${kw} 판단 기준 3가지와 자가진단법`,
      `${kw} 미뤘다가 후회한 사람들의 공통점`,
      `${kw} 시기를 놓치면 달라지는 것들`,
      `${kw}, 실제로 안 하면 어떻게 될까?`,
      `${kw} 결심이 안 선다면 이 질문에 답해보세요`,
      `${kw} 방치했을 때 1년·3년·5년 후 변화`,
    ]
  },
  // 회복/관리
  recovery: {
    patterns: [
      { text: '~후 이 증상, 정상일까 위험 신호일까?', type: 'Q' },
      { text: '~후 관리법과 회복 빠른 사람들의 비결', type: 'N' },
      { text: '~후 1일·1주·1개월 회복 타임라인', type: 'NUM' },
      { text: '~받고 나서 실제로 겪은 일들', type: 'EXP' },
      { text: '~후 하면 안 되는 것들', type: 'N' },
      { text: '~후 음식·운동·일상 복귀는 언제부터?', type: 'Q' },
      { text: '~후 빠른 회복을 위한 5가지 습관', type: 'NUM' },
      { text: '~다음 날부터 일주일, 실제 회복 경험담', type: 'EXP' },
    ],
    examples: (kw) => [
      `${kw} 후 이 증상, 정상일까 위험 신호일까?`,
      `${kw} 후 관리법과 회복 빠른 사람들의 비결`,
      `${kw} 후 1일·1주·1개월 회복 타임라인`,
      `${kw} 받고 나서 실제로 겪은 일들`,
      `${kw} 후 하면 안 되는 것들`,
      `${kw} 후 음식·운동·일상 복귀는 언제부터?`,
      `${kw} 후 빠른 회복을 위한 5가지 습관`,
      `${kw} 다음 날부터 일주일, 실제 회복 경험담`,
    ]
  },
  // 일반 (fallback)
  general: {
    patterns: [
      { text: '~에 대해 가장 많이 묻는 질문들', type: 'Q' },
      { text: '~첫 경험이라면 이것부터 확인하세요', type: 'N' },
      { text: '~치과의사가 쓴 환자용 팩트 정리', type: 'N' },
      { text: '~검색하다 지친 분께 드리는 팩트', type: 'EXP' },
      { text: '~처음이라 막막하다면 읽어보세요', type: 'EXP' },
      { text: '~환자가 꼭 알아야 할 5가지', type: 'NUM' },
      { text: '~이것만 알면 치과 상담이 편해집니다', type: 'Q' },
      { text: '~3분 안에 핵심만 파악하기', type: 'NUM' },
    ],
    examples: (kw) => [
      `${kw}에 대해 가장 많이 묻는 질문들`,
      `${kw} 첫 경험이라면 이것부터 확인하세요`,
      `${kw} 치과의사가 쓴 환자용 팩트 정리`,
      `${kw} 검색하다 지친 분께 드리는 팩트`,
      `${kw} 처음이라 막막하다면 읽어보세요`,
      `${kw} 환자가 꼭 알아야 할 5가지`,
      `${kw}, 이것만 알면 치과 상담이 편해집니다`,
      `${kw} 3분 안에 핵심만 파악하기`,
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
): Promise<{ pattern: string; example: string; emotion: string; intent: string; titleType: string }> {
  const intent = classifyKeywordIntent(keyword, contentType)
  const formulaSet = TITLE_FORMULAS[intent] || TITLE_FORMULAS.general
  
  // 1단계: 이번에 써야 할 제목 형태(Q/N/NUM/EXP) 결정 — 글로벌 로테이션
  const typeRotKey = 'title_type_rotation_idx'
  const typeRow = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(typeRotKey).first()
  let typeIdx = parseInt(typeRow?.value as string || '0')
  if (isNaN(typeIdx) || typeIdx >= TITLE_TYPE_ROTATION.length) typeIdx = 0
  const requiredType = TITLE_TYPE_ROTATION[typeIdx]
  const nextTypeIdx = (typeIdx + 1) % TITLE_TYPE_ROTATION.length
  
  if (typeRow) {
    await db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?").bind(String(nextTypeIdx), typeRotKey).run()
  } else {
    await db.prepare("INSERT INTO settings (key, value, description) VALUES (?, ?, ?)").bind(typeRotKey, String(nextTypeIdx), '제목 형태 Q/N/NUM/EXP 글로벌 로테이션').run()
  }
  
  // 2단계: 해당 형태의 패턴 중에서 로테이션 선택
  const matchingPatterns = formulaSet.patterns
    .map((p, i) => ({ ...p, originalIdx: i }))
    .filter(p => p.type === requiredType)
  
  // 해당 형태가 없으면 (거의 없겠지만) 전체 풀에서 선택
  const candidates = matchingPatterns.length > 0 ? matchingPatterns : formulaSet.patterns.map((p, i) => ({ ...p, originalIdx: i }))
  
  const innerRotKey = `title_formula_inner_${intent}_${requiredType}`
  const innerRow = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(innerRotKey).first()
  let innerIdx = parseInt(innerRow?.value as string || '0')
  if (isNaN(innerIdx) || innerIdx >= candidates.length) innerIdx = 0
  
  const selected = candidates[innerIdx]
  const pattern = selected.text
  const example = formulaSet.examples(keyword)[selected.originalIdx]
  const nextInnerIdx = (innerIdx + 1) % candidates.length
  
  if (innerRow) {
    await db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?").bind(String(nextInnerIdx), innerRotKey).run()
  } else {
    await db.prepare("INSERT INTO settings (key, value, description) VALUES (?, ?, ?)").bind(innerRotKey, String(nextInnerIdx), `제목 패턴 로테이션 v5 (${intent}/${requiredType})`).run()
  }
  
  return { pattern, example, emotion: intent, intent, titleType: requiredType }
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
cronApp.post('/generate', async (c) => {
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
  // ★ v7.3+: subcategory 라운드 로빈 — 치과 전 진료 영역 30개 순환
  // 매 Cron 호출마다 다른 주제가 나옴 → 30일이면 모든 영역 1회전
  const SUBCATEGORY_ROTATION = [
    'implant',            // 1. 임플란트
    'crown',              // 2. 크라운/지르코니아
    'laminate',           // 3. 라미네이트
    'tmj',                // 4. 턱관절
    'inlay',              // 5. 인레이/온레이
    'invisalign',         // 6. 인비절라인/투명교정
    'resin',              // 7. 레진치료
    'wisdom_tooth',       // 8. 사랑니
    'gum',                // 9. 잇몸/치주
    'root_canal',         // 10. 신경치료
    'partial_ortho',      // 11. 부분교정
    'whitening',          // 12. 미백/심미
    'denture',            // 13. 틀니
    'cavity',             // 14. 충치/보존
    'bridge',             // 15. 브릿지
    'full_ortho',         // 16. 전체교정
    'bruxism',            // 17. 이갈이
    're_rootcanal',       // 18. 재신경치료/치근단절제술
    'pediatric',          // 19. 소아치과
    'anesthesia',         // 20. 마취/수면치료
    'sensitivity',        // 21. 시린이
    'scaling',            // 22. 스케일링
    'oral_surgery',       // 23. 구강외과/외상
    'halitosis',          // 24. 구취/입냄새
    'perio_surgery',      // 25. 치주수술
    'tooth_crack',        // 26. 치아균열/마모/오버레이
    'prosthetics',        // 27. 보철/포스트코어
    'emergency',          // 28. 응급/치통
  ]

  // subcategory → DB subcategory 매핑 (classifyKeyword의 subcategory 값과 매칭)
  const SUBCAT_DB_MAP: Record<string, { categories: string[], subcategories: string[] }> = {
    'implant':        { categories: ['implant'], subcategories: ['임플란트_일반','임플란트_과정','임플란트_회복','임플란트_관리','임플란트_불안','임플란트_특수','임플란트_적응증','임플란트_문제','임플란트_비교'] },
    'crown':          { categories: ['general'], subcategories: ['크라운','임시치아'] },
    'laminate':       { categories: ['general'], subcategories: ['라미네이트'] },
    'tmj':            { categories: ['general'], subcategories: ['턱관절'] },
    'inlay':          { categories: ['general'], subcategories: ['인레이'] },
    'invisalign':     { categories: ['orthodontics'], subcategories: ['인비절라인'] },
    'resin':          { categories: ['general'], subcategories: ['레진치료'] },
    'wisdom_tooth':   { categories: ['general'], subcategories: ['사랑니','매복사랑니'] },
    'gum':            { categories: ['general'], subcategories: ['잇몸','잇몸퇴축','잇몸응급'] },
    'root_canal':     { categories: ['general'], subcategories: ['신경치료'] },
    'partial_ortho':  { categories: ['orthodontics'], subcategories: ['부분교정'] },
    'whitening':      { categories: ['general'], subcategories: ['미백_심미','잇몸성형'] },
    'denture':        { categories: ['general'], subcategories: ['틀니'] },
    'cavity':         { categories: ['general'], subcategories: ['충치','이차충치'] },
    'bridge':         { categories: ['general'], subcategories: ['브릿지'] },
    'full_ortho':     { categories: ['orthodontics'], subcategories: ['전체교정','교정_과정','교정_비교','교정_부작용','교정_관리','교정_일반'] },
    'bruxism':        { categories: ['general'], subcategories: ['이갈이'] },
    're_rootcanal':   { categories: ['general'], subcategories: ['재신경치료','치근단절제술'] },
    'pediatric':      { categories: ['general'], subcategories: ['소아치과','소아수면치료','소아교정'] },
    'anesthesia':     { categories: ['general'], subcategories: ['마취_수면','웃음가스'] },
    'sensitivity':    { categories: ['general'], subcategories: ['시린이'] },
    'scaling':        { categories: ['prevention'], subcategories: ['스케일링'] },
    'oral_surgery':   { categories: ['general'], subcategories: ['구강외과','구강점막'] },
    'halitosis':      { categories: ['general'], subcategories: ['구취','구강건조'] },
    'perio_surgery':  { categories: ['general'], subcategories: ['치주수술'] },
    'tooth_crack':    { categories: ['general'], subcategories: ['치아균열','치아마모','오버레이'] },
    'prosthetics':    { categories: ['general'], subcategories: ['보철','포스트코어'] },
    'emergency':      { categories: ['general'], subcategories: ['응급'] },
  }

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

  // ★ v7.3: subcategory 라운드 로빈 키워드 선택
  // count=1 (Cron 매 호출)에서도 매번 다른 주제가 나오도록 보장
  const keywords: any[] = []

  // 차단 키워드 필터 (비용/보험 + 후기/추천 + 쓰레기 키워드)
  const COST_INSURANCE_FILTER = /비용|가격|할부|할인|보험|실비|실손|급여|비급여|건강보험|얼마|가격대|잘하는\s*(곳|치과)|추천\s*(병원|치과)|후기|리뷰|맛집|환절기|황사|알레르기|구내염|마스크\s*구취/

  // subcategory 로테이션 인덱스 읽기 (DB 저장)
  const subcatIdxRow = await c.env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'subcategory_rotation_index'"
  ).first()
  let subcatIdx = parseInt(subcatIdxRow?.value as string || '0')
  if (isNaN(subcatIdx) || subcatIdx < 0) subcatIdx = 0

  // 최근 5개 발행글의 subcategory 확인 → 중복 방지
  const recentSubcats = await c.env.DB.prepare(
    `SELECT k.subcategory, k.category, k.keyword FROM contents c
     LEFT JOIN keywords k ON c.keyword_id = k.id
     WHERE c.status IN ('published', 'draft')
     ORDER BY c.created_at DESC LIMIT 5`
  ).all()
  const recentSubcatSet = new Set(
    (recentSubcats.results || []).map((r: any) => r.subcategory).filter(Boolean)
  )
  const recentKeywords = new Set(
    (recentSubcats.results || []).map((r: any) => r.keyword).filter(Boolean)
  )

  // subcategory별 키워드 선택 함수
  async function pickKeywordFromSubcat(subcatKey: string): Promise<any | null> {
    const mapping = SUBCAT_DB_MAP[subcatKey]
    if (!mapping) return null

    // 카테고리 + subcategory 기반 쿼리
    const placeholders = mapping.categories.map(() => '?').join(',')
    const subPlaceholders = mapping.subcategories.map(() => '?').join(',')
    
    const results = await c.env.DB.prepare(
      `SELECT * FROM keywords 
       WHERE is_active = 1 AND category IN (${placeholders}) AND subcategory IN (${subPlaceholders})
       ORDER BY used_count ASC, priority DESC, RANDOM()
       LIMIT 20`
    ).bind(...mapping.categories, ...mapping.subcategories).all()

    let candidates = (results.results || []).filter((k: any) => {
      if (COST_INSURANCE_FILTER.test(k.keyword)) return false
      // 최근 발행된 동일 키워드 제외
      if (recentKeywords.has(k.keyword)) return false
      return true
    })

    // 미사용 키워드 우선
    const unused = candidates.filter((k: any) => !usedKeywordIds.has(k.id))
    const used = candidates.filter((k: any) => usedKeywordIds.has(k.id))
    return unused[0] || used[0] || null
  }

  // 라운드 로빈: count만큼 선택 (각각 다른 subcategory)
  const selectedKeywords: any[] = []
  let attempts = 0
  const maxAttempts = SUBCATEGORY_ROTATION.length * 2 // 2바퀴까지 시도

  while (selectedKeywords.length < count && attempts < maxAttempts) {
    const currentSubcat = SUBCATEGORY_ROTATION[subcatIdx % SUBCATEGORY_ROTATION.length]
    subcatIdx++
    attempts++

    const kw = await pickKeywordFromSubcat(currentSubcat)
    if (kw) {
      // 최근 5개와 같은 subcategory면 스킵 (다양성 극대화)
      const kwSubcat = kw.subcategory as string
      if (recentSubcatSet.has(kwSubcat) && attempts <= SUBCATEGORY_ROTATION.length) {
        console.log(`[v7.3 다양성] ${currentSubcat}(${kwSubcat}) 최근 발행됨, 다음 주제로`)
        continue
      }
      selectedKeywords.push(kw)
      console.log(`[v7.3 선택] ${currentSubcat} → "${kw.keyword}" (subcat=${kwSubcat}, used=${kw.used_count})`)
    } else {
      console.log(`[v7.3 스킵] ${currentSubcat} — 사용 가능한 키워드 없음`)
    }
  }

  // 라운드 로빈으로 부족하면 폴백: 전체 풀에서 미사용 키워드 랜덤 선택
  if (selectedKeywords.length < count) {
    const existingIds = new Set(selectedKeywords.map((k: any) => k.id))
    const extra = await c.env.DB.prepare(
      `SELECT * FROM keywords WHERE is_active = 1
       ORDER BY used_count ASC, priority DESC, RANDOM() LIMIT ?`
    ).bind((count - selectedKeywords.length) * 10).all()
    const extraFiltered = (extra.results || []).filter((k: any) => 
      !COST_INSURANCE_FILTER.test(k.keyword) && !existingIds.has(k.id) && !usedKeywordIds.has(k.id)
    )
    selectedKeywords.push(...extraFiltered.slice(0, count - selectedKeywords.length))
  }

  // subcategory 인덱스 저장 (다음 Cron 호출 시 이어서)
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('subcategory_rotation_index', ?)"
  ).bind(String(subcatIdx)).run()
  
  const results: any[] = []
  console.log(`[Cron] count=${count}, selected=${selectedKeywords.length}, isManual=${isManual}, subcatIdx=${subcatIdx}`)

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

      // 제목 공식 v5 — 4형태 강제 혼용 + 남용 키워드 제거
      const titleFormula = await getNextTitleFormula(c.env.DB, kw.keyword, classified.type)
      console.log(`[제목v5] type=${titleFormula.titleType}, intent=${titleFormula.intent}, pattern="${titleFormula.pattern}" (${kw.keyword})`)

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

      // === 0.1단계: 콘텐츠 품질 검증 & 자동 교정 (v6.0) ===
      {
        const html = bestContent.content_html || ''
        const plain = html.replace(/<[^>]*>/g, '')
        const h2Count = (html.match(/<h2[^>]*>/gi) || []).length
        const faqCount = (bestContent.faq || []).length
        const qualityIssues: string[] = []

        // 1) 최소 길이 검증 (3000자 미만이면 경고)
        if (plain.length < 2500) {
          qualityIssues.push(`본문 ${plain.length}자 — 최소 3000자 권장`)
        }

        // 2) H2 개수 검증 (5~8개 범위)
        if (h2Count < 4) {
          qualityIssues.push(`H2 ${h2Count}개 — 최소 5개 필요`)
        }

        // 3) FAQ 검증 (5~7개)
        if (faqCount < 3) {
          qualityIssues.push(`FAQ ${faqCount}개 — 최소 5개 필요`)
        }

        // 4) 반복 문장 패턴 감지 & 자동 교정
        let fixedHtml = html
        // "~입니다." 4회 이상 연속 시 일부를 다양한 어미로 교체
        const endingPattern = /(입니다\.\s*<)/g
        const endings = ['이죠.</','편입니다.</','거든요.</','인 셈이죠.</']
        let endingCount = 0
        fixedHtml = fixedHtml.replace(endingPattern, (match) => {
          endingCount++
          if (endingCount % 4 === 0) {
            return endings[endingCount % endings.length]
          }
          return match
        })

        // 5) 빈 H2 섹션 감지 (H2 바로 다음에 또 H2가 오는 경우)
        fixedHtml = fixedHtml.replace(/<\/h2>\s*<h2/gi, '</h2>\n<p>이 부분은 개인의 구강 상태에 따라 달라질 수 있습니다. 치과의사와 상담을 통해 본인에게 맞는 방법을 확인해보세요.</p>\n<h2')

        // 6) 비용 금지어 최종 점검
        const COST_WORDS_STRICT = /만\s*원|가격|비용|보험\s*적용|실비|급여|비급여|건강보험|할부|할인|수가|본인부담|의료비|치료비/g
        const costMatches = plain.match(COST_WORDS_STRICT)
        if (costMatches) {
          qualityIssues.push(`비용 금지어 ${costMatches.length}개 감지: ${costMatches.slice(0, 3).join(', ')}`)
          // FAQ에서 비용 관련 항목 제거
          if (bestContent.faq) {
            bestContent.faq = bestContent.faq.filter((f: any) => 
              !COST_WORDS_STRICT.test(f.q + f.a)
            )
          }
        }

        if (qualityIssues.length > 0) {
          console.warn(`[품질검증] ${kw.keyword}: ${qualityIssues.join(' | ')}`)
        }
        bestContent.content_html = fixedHtml
        bestContent.quality_issues = qualityIssues
      }

      // === 0.2단계: 인터렉티브 요소 자동 보강 + 가독성 향상 (v7.0) ===
      {
        let html = bestContent.content_html || ''
        const plain = html.replace(/<[^>]*>/g, '')

        // 1) "이렇게 질문하세요" 박스 자동 삽입 — 없으면 2번째 H2 뒤에 삽입
        if (!/질문해보세요|질문해\s*보세요|이렇게 질문/.test(plain)) {
          const questionBoxHtml = `<div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;padding:16px;margin:16px 0"><strong>💡 치과에서 이렇게 질문해보세요</strong><br>• "제 경우에는 ${kw.keyword}이(가) 어떤가요?"<br>• "다른 옵션은 없나요? 장단점을 비교해주세요."<br>• "회복 기간은 현실적으로 얼마나 걸릴까요?"</div>`
          const h2Positions: number[] = []
          let sIdx = 0
          while (true) {
            const pos = html.indexOf('</h2>', sIdx)
            if (pos === -1) break
            h2Positions.push(pos + 5)
            sIdx = pos + 1
          }
          // 2번째 H2 뒤에 삽입 (없으면 1번째)
          const insertPos = h2Positions[Math.min(1, h2Positions.length - 1)]
          if (insertPos) {
            html = html.slice(0, insertPos) + '\n' + questionBoxHtml + html.slice(insertPos)
          }
        }

        // 2) 핵심 요약 하이라이트 박스 — 마지막 H2 바로 앞에 삽입
        if (!/핵심 요약|💎|한눈에 보기/.test(plain) && plain.length > 2000) {
          // 핵심 키워드 3개를 본문에서 추출
          const keyPhrases = [kw.keyword, classified.label, '치과의사 상담'].filter(Boolean)
          const summaryBoxHtml = `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin:20px 0"><strong>💎 핵심 요약</strong><br>• ${kw.keyword}: 개인의 구강 상태에 따라 방법과 기간이 달라집니다<br>• 정확한 판단은 CT 촬영 등 정밀 진단 후 가능합니다<br>• 궁금한 점은 미리 메모해서 상담 시 질문하세요</div>`
          // FAQ H2 바로 앞에 삽입
          const faqH2Idx = html.lastIndexOf('<h2')
          if (faqH2Idx > 0) {
            html = html.slice(0, faqH2Idx) + summaryBoxHtml + '\n' + html.slice(faqH2Idx)
          }
        }

        // 3) 긴 단락(400자+) 자동 분할 — <p> 태그 내 400자 이상이면 중간에 <br><br> 삽입
        html = html.replace(/<p([^>]*)>([\s\S]{400,}?)<\/p>/gi, (match, attrs, content) => {
          // 문장 단위로 분할 (마침표+공백 기준)
          const sentences = content.split(/(\. )/)
          if (sentences.length <= 2) return match
          const mid = Math.floor(sentences.length / 2)
          const firstHalf = sentences.slice(0, mid).join('')
          const secondHalf = sentences.slice(mid).join('')
          return `<p${attrs}>${firstHalf.trim()}</p>\n<p${attrs}>${secondHalf.trim()}</p>`
        })

        bestContent.content_html = html
        console.log(`[v7.0 인터렉티브] 자동 보강 완료 (${kw.keyword})`)
      }

      // === 0.3단계: 실명(본명) 후처리 필터 — enhancements.ts 공유 모듈 사용 (v6.2) ===
      // ※ 저자(문석준 원장) 이름은 치환하지 않음!
      // ※ 호칭(씨/님)만 매칭 — "환자"는 오탐이 심해 제외
      {
        const { html: anonymizedHtml, replacements } = anonymizeRealNames(bestContent.content_html || '')
        if (replacements.length > 0) {
          console.warn(`[실명필터] ${replacements.length}개 환자 실명 → 익명화 치환 완료`)
        }
        bestContent.content_html = anonymizedHtml
      }

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
      // ★ v6.0: 이미지 생성은 전체 타임아웃 가드 적용 — 실패해도 콘텐츠는 무조건 성공
      let thumbnailUrl = ''
      const imgTimeoutMs = 90000 // 이미지 전체 프로세스 최대 90초
      const imgStartTime = Date.now()
      
      // 2-A: 썸네일 (1200×630, OG 이미지용)
      // ★ v7.5: 글 제목 기반 썸네일 — 키워드만으로 만들던 뻔한 이미지 탈피
      try {
        if (Date.now() - imgStartTime > imgTimeoutMs) throw new Error('이미지 타임아웃 가드')
        const thumbnailScene = buildThumbnailScene(bestContent.title, kw.keyword, kw.category || 'general')
        const thumbResult = await generateBodyImage(
          c.env, thumbnailScene, bestContent.title, contentId, -1, 1200, 630
        )
        thumbnailUrl = thumbResult.url
        
        if (thumbnailUrl.startsWith('data:')) {
          console.warn('[이미지] data URI 감지 → 플레이스홀더 폴백 전환')
          thumbnailUrl = `https://placehold.co/1200x630/e8f4fd/2563eb?text=${encodeURIComponent(kw.keyword)}&font=sans-serif`
        }
      } catch (imgErr: any) {
        console.error('이미지 생성 실패, 폴백 사용:', imgErr.message)
        thumbnailUrl = `https://placehold.co/1200x630/e8f4fd/2563eb?text=${encodeURIComponent(kw.keyword)}&font=sans-serif`
      }

      // 2-B: 본문 내 이미지 자동 삽입 (IMAGE_SLOT 마커 교체)
      // ★ v7.5: 역방향 이미지 생성 — Claude가 alt(한국어) + scene(영어) 분리 제공
      // 새 형식: <!-- IMAGE_SLOT | alt: 한국어 설명 | scene: English scene --> 
      // 레거시 형식: <!-- IMAGE_SLOT:설명 --> (하위 호환)
      const newSlotRegex = /<!--\s*IMAGE_SLOT\s*\|\s*alt:\s*(.*?)\s*\|\s*scene:\s*(.*?)\s*-->/g
      const legacySlotRegex = /<!--\s*IMAGE_SLOT:(.*?)\s*-->/g
      const imageSlots: { marker: string; altText: string; scenePrompt: string }[] = []
      let slotMatch
      
      // 새 형식 먼저 파싱
      while ((slotMatch = newSlotRegex.exec(finalHtml)) !== null) {
        imageSlots.push({
          marker: slotMatch[0],
          altText: slotMatch[1].trim(),
          scenePrompt: slotMatch[2].trim()
        })
      }
      // 레거시 형식 폴백 (새 형식이 없을 때만)
      if (imageSlots.length === 0) {
        while ((slotMatch = legacySlotRegex.exec(finalHtml)) !== null) {
          const desc = slotMatch[1].trim()
          imageSlots.push({
            marker: slotMatch[0],
            altText: desc,
            scenePrompt: buildSceneFromDescription(desc, kw.keyword)
          })
        }
      }
      
      // 최대 2장까지 본문 이미지 생성 (Workers 타임아웃 대응)
      const imgElapsed = Date.now() - imgStartTime
      const maxBodyImages = imgElapsed > 60000 ? 0 : Math.min(imageSlots.length, 2)
      if (maxBodyImages === 0 && imageSlots.length > 0) {
        console.warn(`[본문이미지] 시간 초과(${Math.round(imgElapsed/1000)}s) → 본문 이미지 스킵`)
      }
      for (let imgIdx = 0; imgIdx < maxBodyImages; imgIdx++) {
        const slot = imageSlots[imgIdx]
        try {
          const bodyImgResult = await generateBodyImage(
            c.env, slot.scenePrompt, slot.altText, contentId, imgIdx
          )
          if (bodyImgResult.url) {
            const imgHtml = `<figure style="margin:24px 0"><img src="${bodyImgResult.url}" alt="${slot.altText}" style="width:100%;border-radius:8px;max-height:500px;object-fit:cover" loading="lazy"><figcaption style="text-align:center;font-size:13px;color:#888;margin-top:8px">▲ ${slot.altText}</figcaption></figure>`
            finalHtml = finalHtml.replace(slot.marker, imgHtml)
            console.log(`[본문이미지] ${imgIdx + 1}/${maxBodyImages} 삽입 완료: ${slot.altText.substring(0, 40)}`)
          }
        } catch (bodyImgErr: any) {
          console.warn(`[본문이미지] ${imgIdx + 1} 생성 실패, 마커 제거:`, bodyImgErr.message)
          finalHtml = finalHtml.replace(slot.marker, '')
        }
      }
      // 남은 미처리 슬롯 제거
      finalHtml = finalHtml.replace(/<!--\s*IMAGE_SLOT\s*\|.*?-->/g, '')
      finalHtml = finalHtml.replace(/<!--\s*IMAGE_SLOT:.*?\s*-->/g, '')

      // === 3단계: 썸네일 기반 대표 이미지 삽입 ===
      // ★ v7.5: 썸네일 alt도 제목 기반으로 구체적으로 생성
      const thumbnailAlt = bestContent.title ? `${bestContent.title} - ${kw.keyword} 관련 치과 정보` : `${kw.keyword} 대표 이미지`
      finalHtml = `<figure style="margin:0 0 24px 0"><img src="${thumbnailUrl}" alt="${thumbnailAlt}" style="width:100%;border-radius:8px;max-height:400px;object-fit:cover" loading="lazy"></figure>` + finalHtml

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
          body: `${kw.keyword}에 대해 더 궁금한 점이 있으시다면, 가까운 치과에 방문하여 치과의사와 상담해보세요. 정확한 진단을 받으면 막연한 걱정이 구체적인 계획으로 바뀝니다.`,
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
          body: `${kw.keyword}에 관한 정보는 시간이 지나면 달라질 수 있습니다. 최신 치료법과 본인에게 맞는 방법은 반드시 치과의사와 직접 확인하시기 바랍니다.`,
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

      // === ★ v6.2: 콘텐츠 크기 검증 — Inblog 1MB 제한 대응 ===
      const htmlSizeBytes = new TextEncoder().encode(finalHtml).length
      const htmlSizeKB = Math.round(htmlSizeBytes / 1024)
      if (htmlSizeBytes > 900000) {
        // 900KB 초과 시 data URI 이미지 제거 + 경고
        finalHtml = finalHtml
          .replace(/<figure[^>]*>[\s\S]*?<img[^>]*src=["']data:image[^"']*["'][^>]*>[\s\S]*?<\/figure>/gi, '')
          .replace(/<img[^>]*src=["']data:image[^"']*["'][^>]*\/?>/gi, '')
        const newSize = new TextEncoder().encode(finalHtml).length
        console.warn(`[크기검증] HTML ${htmlSizeKB}KB → ${Math.round(newSize / 1024)}KB (data URI 이미지 제거)`)
        // DB도 업데이트
        await c.env.DB.prepare(
          `UPDATE contents SET content_html = ? WHERE id = ?`
        ).bind(finalHtml, contentId).run()
      }

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

// ===== Claude API 호출 (v5.1 — 절대 스팸 불가 + 제목 사후검증 + 남용키워드/지역명/연도 자동제거) =====
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
🎯 **제목 작성 가이드 v5.1** — 4형태 강제 혼용 + 남용 키워드 완전 금지
- ⚠️ **이번 제목 형태: ${(titleFormula as any)?.titleType === 'Q' ? '의문형 (물음표로 끝나는 질문)' : (titleFormula as any)?.titleType === 'N' ? '명사형 (명사/명사구로 끝남)' : (titleFormula as any)?.titleType === 'NUM' ? '숫자형 (구체적 숫자 포함)' : '경험형 (경험·후기·실제 뉘앙스)'}** ← 반드시 이 형태로 쓰세요!
- 이번 제목 공식: "${titleFormula?.pattern || '~에 대해 알아야 할 것'}"
- 예시: "${titleFormula?.example || `${keyword}, 실제로 어떤가요?`}"
- ⚠️ **제목에 지역명 금지** (본문에서만)
- ⚠️ **제목 남용 완전 금지 단어** (하나라도 있으면 Google이 scaled content로 판정):
  "가이드", "총정리", "완전 정리", "모든 것", "A부터 Z", "완벽", "2026", "2026년",
  "꼭 알아야 할", "핵심 정리", "완벽 정리", "~하는 법"
  → 이 단어가 제목에 있으면 전체 글이 스팸으로 판정됩니다. 절대 사용 금지.
- 환자가 실제 검색창에 칠 법한 자연스러운 문장이어야 합니다

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
## 🔍 경쟁 글 차별화 전략 (핵심 — 이 지시를 반드시 따르세요)
이 키워드("${keyword}")로 검색했을 때 나오는 상위 글들은 대부분 비슷한 내용입니다.
**당신의 글은 그 글들과 명확히 달라야 합니다.**

차별화 방법:
1. 다른 글들이 빠뜨리는 "환자가 진짜 궁금하지만 물어보기 민망한 질문"을 다루세요
   (예: "수술 중에 의식이 있는 건가요?", "냄새가 나나요?", "다음 날 출근할 수 있나요?")
2. 치과의사만 아는 판단 기준을 1개 이상 포함하세요
   (예: "CT에서 잔존 골높이가 8mm 이상이면 대부분 가능합니다")
3. 시간 경과에 따른 경험적 정보를 넣으세요
   (예: "6개월 후 정기검진에서 가장 많이 발견되는 문제는...")
4. 이 차별화 포인트를 독립 H2 또는 H3 섹션으로 작성하세요
5. JSON 출력에 "differentiation_angle" 필드로 차별화 포인트를 한 문장으로 명시하세요

## ❌➡️✅ 오해 교정 (필수 — E-E-A-T 핵심)
이 키워드("${keyword}")와 관련해 환자들이 흔히 **잘못 알고 있는 것 1가지**를 반드시 교정하세요.
- 본문에 "❌ 오해: [잘못 아는 것]" → "✅ 사실: [정확한 정보 + 근거]" 형식 포함
- 독립 H3 또는 기존 H2 안에 자연스럽게 녹여도 됩니다
- JSON에 "myth_correction" 필드로 교정한 오해를 한 문장으로 명시하세요

## 📚 수치 출처 맥락 (필수)
수치를 쓸 때 **반드시 출처 맥락**을 함께 쓰세요. 최소 2회 이상.
- ❌ "성공률은 95%입니다" → ✅ "대한치과의사협회 자료 기준, 적절히 관리된 경우 성공률이 95%를 넘는다는 보고가 있습니다"
- 사용 가능: "건강보험심사평가원 기준", "대한치과의사협회 권고안", "학술지 연구에 따르면", "임상 문헌에 따르면" 등

## 🎯 첫 문단 검색 의도 명시 (필수)
첫 <p> 안에 **이 글이 누구를 위한 것인지** 한 문장으로 명시하세요.
- 예: "이 글은 ${keyword} 상담을 받고 고민 중이신 분을 위해 작성했습니다."
- JSON에 "search_intent_sentence" 필드로 해당 문장을 명시하세요

핵심 방향:
- 환자의 불안과 걱정을 먼저 인정하고, 구체적 정보로 해소하세요
- 비용이나 가격 정보보다 실제 치료 과정, 통증, 회복에 집중하세요
- 환자가 읽고 나서 "이 정도면 괜찮겠다"라고 느낄 수 있어야 합니다
- "치과에서 이렇게 질문해보세요" 같은 임파워먼트 문장을 포함하세요

⛔ 절대 금지: "만원", "만 원", "가격", "비용", "보험 적용", "보험", "실비", "실손", "급여", "비급여", "건강보험", "할부", "할인", "무료 상담", "무료 검진", "수가", "본인부담", "의료비", "치료비" — 이 단어들을 title, content_html, meta_description, FAQ 어디에도 절대 쓰지 마세요. 비용 관련 FAQ 질문도 포함 금지.

⛔ 실명(본명) 절대 금지 — 법적 의무:
- 환자 사례에 실제 이름(성+이름) 절대 사용 금지 (예: 김미영, 박영수, 이지은 등)
- ✅ 허용: "김모 씨", "50대 환자분", "A씨", "한 환자분", 성만 단독 사용("김 씨")
- ❌ 금지: "김미영 씨", "박영수 님", "이지은 환자" (성+이름 전부 금지)
- 간호사, 직원 등 스태프 이름도 사용 금지
- 단, 저자(원장) 이름은 사용 가능 (예: "문석준 원장"은 OK)
- 환자 사례는 반드시 익명화하세요.

## 📤 JSON 출력 필드 (필수)
{
  "title": "...",
  "slug": "...",
  "meta_description": "...",
  "content_html": "... (범위 명시 박스 + 오해 교정 + 차별화 섹션 + 출처 맥락 수치 필수 포함)",
  "tags": [...],
  "faq": [{"q":"...","a":"..."}],
  "word_count": 숫자,
  "scope_notice": "이 글의 대상·조건 + 다루지 않는 것 한 문장",
  "differentiation_angle": "다른 글과 다른 핵심 차별점 한 문장",
  "myth_correction": "교정한 오해 한 문장 (❌ → ✅)",
  "search_intent_sentence": "첫 문단에 들어간 검색 의도 명시 문장"
}

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

      // === v5.1: 제목 사후검증 — 남용 키워드 자동 제거 ===
      let finalTitle = parsed.title || keyword
      const TITLE_BANNED_POST = ['가이드', '총정리', '완전 정리', '모든 것', 'A부터 Z', '완벽 정리', '완벽', '핵심 정리']
      for (const banned of TITLE_BANNED_POST) {
        if (finalTitle.includes(banned)) {
          console.warn(`[v5.1 제목검증] "${banned}" 발견 → 제거`)
          finalTitle = finalTitle.replace(new RegExp(banned, 'g'), '').replace(/\s{2,}/g, ' ').trim()
        }
      }
      // 연도 제거 (2026년, 2026 등)
      if (/202[0-9]년?/.test(finalTitle)) {
        console.warn(`[v5.1 제목검증] 연도 발견 → 제거`)
        finalTitle = finalTitle.replace(/\s*202[0-9]년?\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
      }
      // 지역명 제거
      const REGIONS_POST = ['대전','세종','청주','천안','아산','서산','당진','논산','공주','보령','제천','충주','홍성','예산','음성','진천','괴산','옥천','영동','금산']
      for (const r of REGIONS_POST) {
        if (finalTitle.includes(r)) {
          console.warn(`[v5.1 제목검증] 지역명 "${r}" 발견 → 제거`)
          finalTitle = finalTitle.replace(new RegExp(r, 'g'), '').replace(/\s{2,}/g, ' ').trim()
        }
      }
      // 메타 디스크립션에서도 지역명 제거
      let finalMeta = parsed.meta_description || ''
      for (const r of REGIONS_POST) {
        if (finalMeta.includes(r)) {
          finalMeta = finalMeta.replace(new RegExp(r, 'g'), '').replace(/\s{2,}/g, ' ').trim()
        }
      }

      // === v5.2: 범위 명시 박스 사후 검증 — Claude가 빠뜨렸을 때 자동 삽입 ===
      let finalHtml = contentHtml
      const hasScopeNotice = /이 글의 범위|이 글에서 다루지 않|다루는 것|다루지 않는 것/.test(plainText)
      if (!hasScopeNotice) {
        console.warn(`[v5.2 범위검증] 범위 명시 박스 누락 → 자동 삽입`)
        // parsed.scope_notice가 있으면 활용, 없으면 기본 생성
        const scopeText = parsed.scope_notice || `일반적인 ${keyword} 기준`
        const scopeBox = `<div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:8px;padding:16px;margin:16px 0;font-size:14px"><strong>📌 이 글의 범위</strong><br>이 글은 <strong>${scopeText}</strong>으로 작성되었습니다.<br>• 개인별 구강 상태, 전신 건강에 따라 내용이 달라질 수 있습니다.<br>• 특수한 경우(전신질환, 복합 시술 등)는 별도 글을 참고해주세요.</div>`
        // 첫 번째 H2 바로 앞에 삽입
        const firstH2Idx = finalHtml.indexOf('<h2')
        if (firstH2Idx !== -1) {
          finalHtml = finalHtml.slice(0, firstH2Idx) + scopeBox + '\n' + finalHtml.slice(firstH2Idx)
        } else {
          // H2가 없으면 첫 <p> 뒤에 삽입
          const firstPEnd = finalHtml.indexOf('</p>')
          if (firstPEnd !== -1) {
            finalHtml = finalHtml.slice(0, firstPEnd + 4) + '\n' + scopeBox + finalHtml.slice(firstPEnd + 4)
          } else {
            finalHtml = scopeBox + '\n' + finalHtml
          }
        }
      }

      // === v5.2: 차별화 앵글 존재 검증 ===
      const hasDiffAngle = parsed.differentiation_angle && parsed.differentiation_angle.length > 5
      if (!hasDiffAngle) {
        console.warn(`[v5.2 차별화검증] differentiation_angle 필드 없음 또는 부족`)
      }

      // === v5.3: 오해 교정 섹션 사후 검증 — Claude가 빠뜨렸을 때 자동 삽입 ===
      const finalPlainText = finalHtml.replace(/<[^>]*>/g, '')
      const hasMythCorrection = /오해.*사실|잘못\s*알|실제로는|사실은\s*그렇지|❌.*✅|흔히.*생각.*하지만/.test(finalPlainText)
      if (!hasMythCorrection) {
        console.warn(`[v5.3 오해교정] 오해 교정 섹션 누락 → 자동 삽입`)
        const mythText = parsed.myth_correction || `${keyword}에 대해 인터넷에서 흔히 볼 수 있는 정보 중 실제 임상과 다른 부분이 있습니다`
        const mythBox = `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:16px;margin:20px 0;font-size:14px"><strong>⚠️ 잠깐, 이건 오해입니다</strong><br><span style="color:#dc2626">❌</span> ${mythText}<br><span style="color:#16a34a">✅</span> 실제로는 개인의 구강 상태와 관리 방법에 따라 결과가 크게 달라집니다. 정확한 판단은 반드시 치과의사 진단을 통해 확인하시기 바랍니다.</div>`
        // FAQ H2 바로 앞에 삽입
        const faqH2Idx = finalHtml.indexOf('<h2')
        const lastH2Idx = finalHtml.lastIndexOf('<h2')
        if (lastH2Idx !== -1 && lastH2Idx !== faqH2Idx) {
          // FAQ H2(마지막) 바로 앞에 삽입
          finalHtml = finalHtml.slice(0, lastH2Idx) + mythBox + '\n' + finalHtml.slice(lastH2Idx)
        } else if (faqH2Idx !== -1) {
          finalHtml = finalHtml.slice(0, faqH2Idx) + mythBox + '\n' + finalHtml.slice(faqH2Idx)
        }
      }

      // === v5.3: 첫 문단 검색 의도 명시 사후 검증 ===
      const first200Text = finalHtml.replace(/<[^>]*>/g, '').substring(0, 200)
      const hasSearchIntent = /위한\s*(글|정보|안내)|분이라면|분께|고민\s*중이시|검색.*계신|상황이라면|들으신\s*분|걱정되시는/.test(first200Text)
      if (!hasSearchIntent) {
        console.warn(`[v5.3 의도명시] 첫 문단 검색 의도 명시 누락 → 자동 삽입`)
        const intentSentence = parsed.search_intent_sentence || `${keyword}에 대해 궁금하거나 걱정되어 검색하고 계신 분`
        const intentHtml = `<p style="color:#475569;font-size:15px;margin:0 0 16px 0;padding:12px 16px;background:#f8fafc;border-radius:6px;border-left:3px solid #3b82f6"><em>이 글은 <strong>${intentSentence}</strong>을 위해 작성되었습니다.</em></p>`
        // 첫 <p> 뒤에 삽입
        const firstPEnd = finalHtml.indexOf('</p>')
        if (firstPEnd !== -1) {
          finalHtml = finalHtml.slice(0, firstPEnd + 4) + '\n' + intentHtml + finalHtml.slice(firstPEnd + 4)
        } else {
          finalHtml = intentHtml + finalHtml
        }
      }

      return {
        title: finalTitle,
        slug: parsed.slug || keyword.replace(/\s+/g, '-'),
        meta_description: finalMeta,
        content_html: finalHtml,
        tags: parsed.tags || [],
        faq: parsed.faq || [],
        word_count: plainText.length,
        scope_notice: parsed.scope_notice || '',
        differentiation_angle: parsed.differentiation_angle || '',
        myth_correction: parsed.myth_correction || '',
        search_intent_sentence: parsed.search_intent_sentence || ''
      }
    } catch (e: any) {
      lastError = `${model.label} 오류: ${e.message}`
      console.warn(`[Claude] ${lastError}`)
      continue // 타임아웃 등 → 다음 모델로 폴백
    }
  }

  throw new Error(`모든 Claude 모델 실패: ${lastError}`)
}

// ===== POST /api/cron/publish-next — draft 1개를 인블로그에 발행 (v6.0 — 안정화 강화) =====
cronApp.post('/publish-next', async (c) => {
  const startTime = Date.now()
  try {
    // draft 잔여량 확인
    const draftCountRow = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM contents WHERE status = 'draft'"
    ).first()
    const draftCount = (draftCountRow?.cnt as number) || 0

    // ★ v6.0: 오늘 이미 발행된 수 체크 (중복 발행 방지 — 이중 안전장치)
    const todayPublishedRow = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM contents WHERE status = 'published' AND updated_at > datetime('now', '-1 day')"
    ).first()
    const todayPublished = (todayPublishedRow?.cnt as number) || 0
    if (todayPublished >= 5) {
      console.log(`[publish-next] 오늘 이미 ${todayPublished}건 발행 → 스킵 (최대 5건/일)`)
      return c.json({
        published: false,
        message: `오늘 이미 ${todayPublished}건 발행 완료 (최대 5건/일)`,
        drafts_remaining: draftCount,
        today_published: todayPublished
      })
    }

    // 가장 오래된 draft 1개 가져오기
    const draft = await c.env.DB.prepare(
      `SELECT c.id, c.keyword_text as keyword, c.title, c.slug, c.meta_description, c.content_html, c.thumbnail_url, c.tags
       FROM contents c
       WHERE c.status = 'draft'
       ORDER BY c.created_at ASC
       LIMIT 1`
    ).first() as any

    if (!draft) {
      return c.json({ 
        message: 'No draft available — draft 대기열이 비어있습니다. /api/cron/generate-drafts 를 호출하여 보충하세요.', 
        published: false,
        drafts_remaining: 0,
        needs_replenish: true
      })
    }

    // ★ v7.5: slug 중복 체크 (LIKE → INSTR로 변경 — D1 LIKE 패턴 복잡도 에러 방지)
    const existingSlug = await c.env.DB.prepare(
      "SELECT id FROM publish_logs WHERE INSTR(inblog_url, ?) > 0 AND status = 'published'"
    ).bind(`/${draft.slug}`).first()
    if (existingSlug) {
      const uniqueSuffix = `-${Date.now().toString(36).slice(-4)}`
      draft.slug = draft.slug + uniqueSuffix
      await c.env.DB.prepare("UPDATE contents SET slug = ? WHERE id = ?").bind(draft.slug, draft.id).run()
      console.warn(`[publish-next] slug 중복 감지 → ${draft.slug} 로 변경`)
    }

    // API 키 확인
    const inblogKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'inblog_api_key'").first()
    const inblogApiKey = inblogKeyRow?.value as string || ''
    if (!inblogApiKey) {
      return c.json({ error: 'inblog_api_key not configured', published: false }, 500)
    }

    // API 키 검증 및 subdomain 확인
    const apiInfo = await verifyInblogApiKey(inblogApiKey)
    if (!apiInfo?.subdomain) {
      return c.json({ error: 'Invalid inblog API key', published: false }, 500)
    }

    // 태그 동기화 (★ v6.0: 태그 실패해도 발행 진행)
    let tagIds: string[] = []
    try {
      const tags = draft.tags ? JSON.parse(draft.tags) : []
      if (tags.length > 0) {
        const syncedTags = await syncTags(inblogApiKey, tags)
        tagIds = syncedTags.map((t: any) => t.id)
      }
    } catch (e: any) {
      console.warn('[publish-next] 태그 파싱/동기화 실패 (무시하고 진행):', e.message)
    }

    // 작성자 ID (★ v6.0: 실패해도 null로 진행)
    let authorId: string | null = null
    try {
      authorId = await getAuthorId(inblogApiKey)
    } catch (e: any) {
      console.warn('[publish-next] 작성자 ID 조회 실패 (null로 진행):', e.message)
    }

    // ★ v6.2: 발행 전 HTML 크기 검증 — Inblog 1MB 제한
    let publishHtml = draft.content_html || ''
    const draftSizeBytes = new TextEncoder().encode(publishHtml).length
    if (draftSizeBytes > 900000) {
      publishHtml = publishHtml
        .replace(/<figure[^>]*>[\s\S]*?<img[^>]*src=["']data:image[^"']*["'][^>]*>[\s\S]*?<\/figure>/gi, '')
        .replace(/<img[^>]*src=["']data:image[^"']*["'][^>]*\/?>/gi, '')
      console.warn(`[publish-next] HTML 크기 축소: ${Math.round(draftSizeBytes / 1024)}KB → ${Math.round(new TextEncoder().encode(publishHtml).length / 1024)}KB`)
      await c.env.DB.prepare("UPDATE contents SET content_html = ? WHERE id = ?").bind(publishHtml, draft.id).run()
    }

    // ★ v7.1: 인블로그 포스트 생성 (409 slug 충돌 + 5xx 서버 에러 재시도)
    let createResult: any
    let retrySlug = draft.slug
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        createResult = await createInblogPost(inblogApiKey, {
          title: draft.title,
          slug: retrySlug,
          description: draft.meta_description,
          content_html: publishHtml,
          meta_description: draft.meta_description,
          image: draft.thumbnail_url
        }, tagIds, authorId)
        break // 성공 시 루프 탈출
      } catch (createErr: any) {
        const errMsg = createErr?.message || ''
        if (errMsg.includes('409') && attempt < 2) {
          // slug 충돌 → 고유 접미사 추가 후 재시도
          retrySlug = `${draft.slug}-${Date.now().toString(36).slice(-4)}`
          await c.env.DB.prepare("UPDATE contents SET slug = ? WHERE id = ?").bind(retrySlug, draft.id).run()
          console.warn(`[publish-next] slug 충돌 재시도 ${attempt + 1}: ${retrySlug}`)
          continue
        }
        if (/5\d{2}|timeout|network|fetch failed/i.test(errMsg) && attempt < 2) {
          // 서버 에러/네트워크 에러 → 3초 후 재시도
          console.warn(`[publish-next] 서버 에러 재시도 ${attempt + 1}: ${errMsg.substring(0, 100)}`)
          await new Promise(r => setTimeout(r, 3000))
          continue
        }
        throw createErr // 다른 에러거나 3회 실패 시 전파
      }
    }
    if (!createResult) throw new Error('createInblogPost 3회 실패')

    const inblogPostId = createResult.id

    // ★ v7.1: 즉시 발행 (실패 시 점진적 재시도 — 2초, 5초)
    let publishSuccess = false
    for (let pubAttempt = 0; pubAttempt < 3; pubAttempt++) {
      try {
        await publishInblogPost(inblogApiKey, inblogPostId, 'publish')
        publishSuccess = true
        break
      } catch (pubErr: any) {
        const pubErrMsg = pubErr?.message || ''
        if (pubAttempt < 2 && /5\d{2}|timeout|network|429/i.test(pubErrMsg)) {
          const delay = pubAttempt === 0 ? 2000 : 5000
          console.warn(`[publish-next] 발행 시도 ${pubAttempt + 1} 실패 (${pubErrMsg.substring(0, 80)}), ${delay/1000}초 후 재시도`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        throw pubErr // 영구 에러거나 3회 실패
      }
    }
    if (!publishSuccess) throw new Error('publishInblogPost 3회 실패')

    const inblogUrl = `https://${apiInfo.subdomain}.inblog.ai/${draft.slug}`

    // DB 업데이트
    await c.env.DB.prepare(
      `UPDATE contents SET status = 'published', updated_at = datetime('now') WHERE id = ?`
    ).bind(draft.id).run()

    await c.env.DB.prepare(
      `INSERT INTO publish_logs (content_id, inblog_post_id, inblog_url, status, scheduled_at, published_at)
       VALUES (?, ?, ?, 'published', datetime('now'), datetime('now'))`
    ).bind(draft.id, inblogPostId, inblogUrl).run()

    // 검색엔진 색인 요청 (★ v6.0: 비동기, 실패 무시)
    try {
      await requestSearchEngineIndexing(inblogUrl, c.env.DB)
    } catch (e: any) {
      console.warn('[publish-next] 검색엔진 색인 요청 실패 (무시):', e.message || e)
    }

    const draftsRemaining = draftCount - 1
    const elapsed = Date.now() - startTime
    console.log(`[publish-next] ✅ 발행 완료 (${elapsed}ms): "${draft.title}" → ${inblogUrl} (남은 draft: ${draftsRemaining})`)

    return c.json({
      published: true,
      content_id: draft.id,
      keyword: draft.keyword,
      title: draft.title,
      inblog_url: inblogUrl,
      inblog_post_id: inblogPostId,
      tags_synced: tagIds.length,
      drafts_remaining: draftsRemaining,
      needs_replenish: draftsRemaining < 3,
      today_published: todayPublished + 1,
      elapsed_ms: elapsed
    })
  } catch (err: any) {
    const elapsed = Date.now() - startTime
    const errMsg = err?.message || String(err)
    console.error(`[publish-next] 발행 실패 (${elapsed}ms):`, errMsg)

    // ★ v7.1: 에러 분류 — 임시/영구 구분
    const isTemporary = /timeout|network|ECONNRESET|429|502|503|504|fetch failed|AbortError/i.test(errMsg)
    const is413 = /413|Body exceeded/i.test(errMsg)
    const is409 = /409|slug.*exist/i.test(errMsg)

    try {
      // 현재 처리 중이던 draft 특정 (아까 조회한 것과 같은 기준)
      const failedDraft = await c.env.DB.prepare(
        "SELECT id, title FROM contents WHERE status = 'draft' ORDER BY created_at ASC LIMIT 1"
      ).first() as any
      if (failedDraft) {
        const errorCategory = isTemporary ? 'temporary' : is413 ? 'payload_too_large' : is409 ? 'slug_conflict' : 'permanent'
        await c.env.DB.prepare(
          `INSERT INTO publish_logs (content_id, status, error_message, scheduled_at)
           VALUES (?, 'failed', ?, datetime('now'))`
        ).bind(failedDraft.id, `[${errorCategory}] ${errMsg}`.substring(0, 500)).run()

        // ★ v7.1: 임시 에러는 5회, 영구 에러는 3회 후 failed 전환
        const failThreshold = isTemporary ? 5 : 3
        const failCount = await c.env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM publish_logs WHERE content_id = ? AND status = 'failed'"
        ).bind(failedDraft.id).first()
        const totalFails = (failCount?.cnt as number) || 0

        if (totalFails >= failThreshold) {
          await c.env.DB.prepare(
            "UPDATE contents SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
          ).bind(failedDraft.id).run()
          console.error(`[publish-next] Draft #${failedDraft.id} "${(failedDraft.title||'').substring(0,30)}" ${totalFails}회 실패(${errorCategory}) → failed 상태 전환`)
        } else {
          console.warn(`[publish-next] Draft #${failedDraft.id} 실패 ${totalFails}/${failThreshold}회 (${errorCategory}) — 다음 시도에서 재시도 예정`)
        }

        // ★ v7.1: 413 에러 시 content_html 자동 축소 시도
        if (is413 && totalFails < failThreshold) {
          try {
            const content = await c.env.DB.prepare("SELECT content_html FROM contents WHERE id = ?").bind(failedDraft.id).first() as any
            if (content?.content_html) {
              let shrunk = content.content_html
                .replace(/<figure[^>]*>[\s\S]*?<img[^>]*src=["']data:image[^"']*["'][^>]*>[\s\S]*?<\/figure>/gi, '')
                .replace(/<img[^>]*src=["']data:image[^"']*["'][^>]*\/?>/gi, '')
              // 이미지 figcaption이 과도하면 축소
              const sizeAfter = new TextEncoder().encode(shrunk).length
              if (sizeAfter > 800000) {
                // 본문 이미지 figure 태그 일부 제거 (썸네일 제외)
                let figureCount = 0
                shrunk = shrunk.replace(/<figure style="margin:24px 0">[\s\S]*?<\/figure>/gi, () => {
                  figureCount++
                  return figureCount > 1 ? '' : arguments[0] // 첫 번째만 유지
                })
              }
              await c.env.DB.prepare("UPDATE contents SET content_html = ? WHERE id = ?").bind(shrunk, failedDraft.id).run()
              console.log(`[publish-next] Draft #${failedDraft.id} HTML 자동 축소 완료 (413 대응)`)
            }
          } catch (shrinkErr: any) {
            console.warn('[publish-next] HTML 축소 실패:', shrinkErr.message)
          }
        }
      }
    } catch (logErr: any) {
      console.error('[publish-next] 실패 로깅 중 오류:', logErr.message)
    }
    return c.json({ 
      error: errMsg, 
      error_type: isTemporary ? 'temporary' : is413 ? 'payload_too_large' : 'permanent',
      published: false, 
      elapsed_ms: elapsed 
    }, 500)
  }
})

// ===== POST /api/cron/generate-drafts — draft만 미리 생성 (발행 X, 시간제한 없는 환경에서 호출) =====
cronApp.post('/generate-drafts', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const requestedCount = (body as any).count || 3
    const targetDrafts = (body as any).target_drafts || 6 // 최소 이 개수만큼 draft 유지

    // 현재 draft 개수 확인
    const draftCountRow = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM contents WHERE status = 'draft'"
    ).first()
    const currentDrafts = (draftCountRow?.cnt as number) || 0

    // 이미 충분하면 스킵
    if (currentDrafts >= targetDrafts) {
      return c.json({
        message: `Draft가 이미 충분합니다 (${currentDrafts}/${targetDrafts})`,
        current_drafts: currentDrafts,
        target_drafts: targetDrafts,
        generated: 0,
        skipped: true
      })
    }

    // 부족한 만큼만 생성
    const toGenerate = Math.min(requestedCount, targetDrafts - currentDrafts)

    // 기존 generate 로직 호출 (auto_publish=false 강제)
    const generateBody = {
      count: toGenerate,
      manual: true,
      auto_publish: false
    }

    // ★ v7.1: 내부 호출 대신 직접 로직 사용 (프로덕션에서 self-fetch 실패 방지)
    // Cloudflare Workers에서 자기 자신에게 fetch하면 timeout/routing 이슈 발생 가능
    // c.req.url을 통한 origin 추출이 프로덕션에서 불안정 → 직접 generate 로직 실행
    const url = new URL(c.req.url)
    const appUrl = url.origin.includes('localhost') ? url.origin : 'https://inblogauto.pages.dev'
    const internalUrl = `${appUrl}/api/cron/generate`
    const response = await fetch(internalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(generateBody),
      signal: AbortSignal.timeout(300000) // 5분 타임아웃 가드
    })
    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      throw new Error(`generate 내부 호출 실패 (${response.status}): ${errText.substring(0, 200)}`)
    }
    const result = await response.json() as any

    // 새 draft 개수 확인
    const newDraftCountRow = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM contents WHERE status = 'draft'"
    ).first()
    const newDrafts = (newDraftCountRow?.cnt as number) || 0

    console.log(`[generate-drafts] 생성 완료: ${toGenerate}건 요청 → draft ${currentDrafts} → ${newDrafts}`)

    return c.json({
      message: `Draft ${newDrafts - currentDrafts}건 생성 완료`,
      previous_drafts: currentDrafts,
      current_drafts: newDrafts,
      target_drafts: targetDrafts,
      generated: newDrafts - currentDrafts,
      results: result.results || []
    })
  } catch (err: any) {
    console.error('[generate-drafts] 실패:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

// ===== POST /api/cron/recover-drafts — 임시 에러로 failed된 draft를 복구 (v7.1) =====
cronApp.post('/recover-drafts', async (c) => {
  try {
    // failed 상태이면서 임시 에러(temporary)로 실패한 콘텐츠를 draft로 복구
    const failedDrafts = await c.env.DB.prepare(
      `SELECT c.id, c.title, c.keyword_text as keyword,
              (SELECT COUNT(*) FROM publish_logs WHERE content_id = c.id AND status = 'failed') as fail_count,
              (SELECT error_message FROM publish_logs WHERE content_id = c.id AND status = 'failed' ORDER BY created_at DESC LIMIT 1) as last_error
       FROM contents c WHERE c.status = 'failed'
       ORDER BY c.created_at DESC LIMIT 20`
    ).all()

    const items = (failedDrafts.results || []) as any[]
    let recovered = 0
    const details: any[] = []

    for (const item of items) {
      const lastErr = item.last_error || ''
      const isTemporary = /temporary|timeout|network|ECONNRESET|429|502|503|504|fetch failed/i.test(lastErr)
      const is413Fixed = /payload_too_large|413|Body exceeded/i.test(lastErr)

      // 임시 에러이거나 413(이미 자동 축소됨)인 경우만 복구
      if (isTemporary || is413Fixed) {
        await c.env.DB.prepare(
          "UPDATE contents SET status = 'draft', updated_at = datetime('now') WHERE id = ?"
        ).bind(item.id).run()
        // 실패 로그 초기화 (다시 카운트 시작)
        await c.env.DB.prepare(
          "DELETE FROM publish_logs WHERE content_id = ? AND status = 'failed'"
        ).bind(item.id).run()
        recovered++
        details.push({
          id: item.id,
          keyword: item.keyword,
          title: (item.title || '').substring(0, 40),
          previous_fails: item.fail_count,
          error_type: isTemporary ? 'temporary' : 'payload_fixed',
          last_error: lastErr.substring(0, 100)
        })
      }
    }

    return c.json({
      message: `${recovered}/${items.length}건 draft로 복구 완료`,
      recovered,
      total_failed: items.length,
      details
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ===== GET /api/cron/draft-status — draft 대기열 상태 조회 =====
cronApp.get('/draft-status', async (c) => {
  try {
    const draftCountRow = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM contents WHERE status = 'draft'"
    ).first()
    const currentDrafts = (draftCountRow?.cnt as number) || 0

    const drafts = await c.env.DB.prepare(
      `SELECT id, keyword_text as keyword, title, seo_score, created_at 
       FROM contents WHERE status = 'draft' 
       ORDER BY created_at ASC LIMIT 10`
    ).all()

    // ★ v7.1: failed 건수도 반환 (복구 가능 여부 확인용)
    const failedCountRow = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM contents WHERE status = 'failed'"
    ).first()
    const failedCount = (failedCountRow?.cnt as number) || 0

    const publishedTodayRow = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM contents WHERE status = 'published' AND updated_at > datetime('now', '-1 day')"
    ).first()
    const publishedToday = (publishedTodayRow?.cnt as number) || 0

    return c.json({
      draft_count: currentDrafts,
      failed_count: failedCount,
      published_today: publishedToday,
      needs_replenish: currentDrafts < 3,
      days_of_buffer: Math.floor(currentDrafts / 3), // 하루 3개 발행 기준
      drafts: drafts.results || []
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

const cronHandler = cronApp

// ===== 본문 이미지 생성 (섹션별 맞춤 프롬프트, 1200×800) =====
// ★ v7.5: 통합 이미지 생성 함수 (scene 프롬프트 직접 사용)
// scenePrompt: Claude가 생성한 영어 장면 묘사 또는 buildThumbnailScene 결과
// altText: 한국어 alt 태그 (로그/폴백용)
// width/height: 기본 1200x800, 썸네일은 1200x630
async function generateBodyImage(
  env: any, scenePrompt: string, altText: string, contentId: number, imageIndex: number,
  width: number = 1200, height: number = 800
): Promise<{ url: string }> {
  const noText = 'absolutely no text, no letters, no words, no numbers, no labels, no captions, no watermarks anywhere in the image'
  const safetyGuard = 'no blood, no surgical wounds, no scary medical imagery, no close-up of real teeth, no fake 3D implant renders'
  const styleGuide = 'warm reassuring medical atmosphere, soft natural lighting, clean modern aesthetic, professional healthcare environment, 8k quality, photorealistic'
  
  const prompt = `${scenePrompt}. ${styleGuide}, ${safetyGuard}, ${noText}.`

  // fal.ai API 키
  let falApiKey = ''
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'fal_api_key'").first()
    falApiKey = row?.value as string || ''
  } catch (e: any) {
    console.warn('[이미지] fal API 키 조회 실패:', e.message || e)
  }

  if (falApiKey) {
    const models = [
      { name: 'FLUX.2 pro', url: 'https://fal.run/fal-ai/flux-pro/v1.1-ultra', body: { prompt, image_size: { width, height }, num_images: 1, safety_tolerance: '5', output_format: 'jpeg' } },
      { name: 'FLUX.1 schnell', url: 'https://fal.run/fal-ai/flux/schnell', body: { prompt, image_size: { width, height }, num_images: 1, enable_safety_checker: false } }
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
            // R2 백업
            if (env?.R2) {
              try {
                const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) })
                if (imgRes.ok) {
                  const buf = await imgRes.arrayBuffer()
                  const imgType = imageIndex === -1 ? 'thumbnail' : `body_${imageIndex}`
                  const key = `images/${contentId}/${imgType}.jpg`
                  await env.R2.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { alt: altText.substring(0, 200), prompt: prompt.substring(0, 200) } })
                  console.log(`[이미지] R2 백업 저장 완료: ${imgType}`)
                }
              } catch (r2Err: any) {
                console.warn(`[이미지] R2 백업 실패 (무시): ${r2Err.message}`)
              }
            }
            return { url: imageUrl }
          }
        }
      } catch (e: any) {
        console.warn(`[이미지] ${model.name} 실패: ${e.message}`)
        continue
      }
    }
  }

  // 폴백: 플레이스홀더
  console.warn(`[이미지] fal.ai 전체 실패 → 플레이스홀더 사용`)
  const colors = ['4A90D9', '5B8C5A', '8B5CF6', 'D97706', '0891B2', '7C3AED', '059669']
  const colorIdx = Math.abs(Date.now() + (imageIndex >= 0 ? imageIndex : 99)) % colors.length
  return { url: `https://placehold.co/${width}x${height}/${colors[colorIdx]}/ffffff?text=${encodeURIComponent(altText.substring(0, 30))}&font=sans-serif` }
}

// ★ v7.5: 레거시 IMAGE_SLOT 설명 → 영어 scene 변환 (하위 호환)
function buildSceneFromDescription(description: string, keyword: string): string {
  const desc = description.toLowerCase()
  
  // 키워드 기반 기본 장면 매핑
  if (/상담|설명|안내/.test(desc)) return `A dentist's hands gesturing while explaining to a patient using a dental jaw model on a desk, warm clinic interior with soft lighting, blurred modern dental office background, reassuring professional atmosphere, no visible faces`
  if (/치료|과정|시술/.test(desc)) return `Modern dental treatment room with a comfortable dental chair, organized dental instruments on a tray, warm ambient lighting, clean medical environment, calming atmosphere, no patient visible`
  if (/비교|차이|vs/.test(desc)) return `Two dental restoration options displayed side by side on a clean white surface, soft studio lighting, medical comparison concept, clean infographic style, professional dental photography`
  if (/회복|관리|유지/.test(desc)) return `A person gently touching their healthy smile area (lower face only, no eyes), fresh morning light, bathroom mirror reflection, daily oral care routine concept, warm reassuring feeling`
  if (/통증|아프|불편/.test(desc)) return `A cozy dental consultation room with a calming blue and white color scheme, a glass of water on the table, soft cushioned chair, warm natural light from window, soothing medical environment`
  if (/검사|진단|엑스레이/.test(desc)) return `A modern dental clinic consultation desk with a computer monitor showing dental imagery (blurred), a dentist's notepad and pen, warm professional lighting, clean organized workspace`
  
  // 기본 폴백
  return `A warm inviting dental clinic reception area with modern interior design, comfortable seating, soft natural lighting, potted green plants, clean professional healthcare environment, related to ${keyword}`
}

// ★ v7.5: 글 제목 기반 썸네일 scene 생성
function buildThumbnailScene(title: string, keyword: string, category: string): string {
  const kw = keyword.toLowerCase()
  const t = title.toLowerCase()
  
  // 제목/키워드 기반 구체적 장면 매핑
  if (/임플란트/.test(kw)) {
    if (/회복|관리|주의/.test(t)) return `Overhead view of a dental care package on a clean white table: a soft toothbrush, gentle mouthwash bottle, ice pack, and a small note card, warm natural lighting, recovery concept`
    if (/비교|vs|브릿지|틀니/.test(t)) return `Two dental jaw models side by side on a dentist's desk showing different restoration options, one with implant and one with bridge, clean professional lighting, comparison concept`
    if (/과정|단계|수술/.test(t)) return `A modern dental consultation room with a large wall-mounted monitor, a dentist's hand pointing at it, comfortable patient chair visible, clean medical environment, step-by-step concept`
    return `Close-up of a dentist's hands holding a detailed dental jaw model, showing implant area, warm clinic lighting, blurred dental office background, professional caring atmosphere`
  }
  if (/교정|인비절라인|투명/.test(kw)) {
    return `Clear dental aligners resting on a clean white marble surface next to their carrying case, soft window light, minimal clean aesthetic, orthodontic treatment concept`
  }
  if (/사랑니|발치/.test(kw)) {
    return `A calming dental consultation desk with a glass of water, a dental mirror, and a small anatomical tooth model, warm soft lighting, reassuring medical atmosphere`
  }
  if (/신경치료|근관/.test(kw)) {
    return `A dental microscope in a modern endodontic treatment room, soft blue ambient lighting, organized precision instruments, high-tech medical environment, professional atmosphere`
  }
  if (/잇몸|치주/.test(kw)) {
    return `A soft-bristled toothbrush and interdental brushes arranged neatly on a clean bathroom counter, fresh morning light, daily gum care routine concept, warm welcoming feel`
  }
  if (/크라운|오버레이|인레이/.test(kw)) {
    return `A dentist's gloved hands carefully examining a dental crown under a magnifying lamp, clean workstation, precision dental craftsmanship concept, warm professional lighting`
  }
  if (/미백|라미네이트|심미/.test(kw)) {
    return `A bright modern dental cosmetic consultation room with a shade guide on the desk, natural sunlight streaming in, fresh clean aesthetic, cosmetic dentistry concept`
  }
  if (/충치|보존|레진/.test(kw)) {
    return `A dental mirror reflecting healthy teeth, placed on a clean white surface next to a small dental model, soft studio lighting, preventive care concept, warm reassuring atmosphere`
  }
  if (/스케일링|예방|검진/.test(kw)) {
    return `A bright welcoming dental hygiene room with ultrasonic scaling equipment neatly arranged, large window with natural light, potted plant on windowsill, preventive care environment`
  }
  if (/통증|치통|아프/.test(kw)) {
    return `A warm cup of tea and a cold compress on a cozy bedside table, soft lamp light, comforting home care scene, gentle soothing atmosphere for dental pain relief concept`
  }
  if (/균열|크랙|깨/.test(kw)) {
    return `A dental loupe and mirror placed on a professional dental tray, a small tooth model nearby, sharp detailed lighting, diagnostic precision concept, modern endodontic setting`
  }
  if (/턱관절|이갈이/.test(kw)) {
    return `A dental night guard resting on its clean case next to a bedside table, soft evening lamp light, sleep health and TMJ care concept, calming bedroom atmosphere`
  }
  if (/소아|아이|어린이/.test(kw)) {
    return `A colorful child-friendly dental clinic waiting area with playful decorations, small chairs, children's books, warm cheerful lighting, welcoming pediatric dentistry environment`
  }
  
  // 카테고리 기반 폴백
  const categoryScenes: Record<string, string> = {
    implant: `A modern dental implant consultation room with anatomical models on the desk, warm professional lighting, clean medical environment`,
    orthodontics: `Clear aligners and orthodontic tools on a clean bright dental desk, modern clinic aesthetic, organized professional environment`,
    general: `A welcoming modern dental clinic reception with comfortable seating, soft natural lighting, green plants, clean professional healthcare atmosphere`,
    prevention: `Daily oral care items beautifully arranged on a bathroom counter, toothbrush, floss, mouthwash, fresh morning light, healthy routine concept`,
  }
  
  return categoryScenes[category] || categoryScenes.general
}

// ===== v7.5: 기존 이미지 시스템 제거 — generateBodyImage + buildThumbnailScene으로 통합 =====
// buildImagePrompt, getImageCaption, saveImageToStorage, generateAIImage, hashString 모두 제거됨
// 새 시스템: Claude가 alt(한국어) + scene(영어) 분리 제공 → scene을 직접 프롬프트로 사용

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
