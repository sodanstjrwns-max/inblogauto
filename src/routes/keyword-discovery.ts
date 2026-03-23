import { Hono } from 'hono'
import type { Bindings } from '../index'

const keywordDiscoveryRoutes = new Hono<{ Bindings: Bindings }>()

// ======================================================================
// 키워드 자동 수집 시스템
// Google Autocomplete + 치과 도메인 파생어 + 자동 분류 + 중복 제거
// ======================================================================

// ===== 1. Google Autocomplete API (비공식, 무료) =====
async function fetchGoogleSuggestions(seed: string, lang: string = 'ko'): Promise<string[]> {
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(seed)}&hl=${lang}`
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    if (!response.ok) return []
    const data: any = await response.json()
    // Google Suggest 응답: [query, [suggestions]]
    return (data[1] || []).filter((s: string) => s !== seed)
  } catch (e: any) {
    console.error('Google Suggest 실패:', e.message)
    return []
  }
}

// ===== 2. 치과 도메인 파생어 생성 =====
function generateDentalVariations(seedKeyword: string): string[] {
  const variations: string[] = []
  const kw = seedKeyword.trim()
  
  // 접미사 확장 (환자 질문 패턴)
  const suffixes = [
    '비용', '가격', '후기', '추천', '과정',
    '통증', '아프나요', '부작용', '회복 기간',
    '보험 적용', '실비', '주의사항',
    '장단점', '수명', '관리법',
    '실패 확률', '안전한가요', '후회',
    '잘하는 곳', '잘하는 치과'
  ]
  
  // 접두사 확장
  const prefixes = [
    '대전', '세종', '청주', '천안'
  ]
  
  // 질문형 패턴
  const questionPatterns = [
    `${kw} 꼭 해야하나요`,
    `${kw} 안 하면 어떻게 되나요`,
    `${kw} 얼마나 걸리나요`,
    `${kw} 무섭다`,
    `${kw} 후 음식`,
    `${kw} 후 운동`,
  ]
  
  for (const suffix of suffixes) {
    variations.push(`${kw} ${suffix}`)
  }
  
  for (const prefix of prefixes) {
    variations.push(`${prefix} ${kw}`)
  }
  
  variations.push(...questionPatterns)
  
  // "vs" 비교형
  const compareTargets: Record<string, string[]> = {
    '임플란트': ['브릿지', '틀니', '자연치아'],
    '투명교정': ['일반교정', '설측교정'],
    '라미네이트': ['치아교정', '미백'],
    '크라운': ['인레이', '온레이'],
    '레진': ['아말감', '금', '세라믹'],
    '지르코니아': ['금', 'PFM', 'e-max'],
  }
  
  for (const [key, targets] of Object.entries(compareTargets)) {
    if (kw.includes(key)) {
      for (const target of targets) {
        variations.push(`${key} vs ${target}`)
      }
    }
  }
  
  return variations
}

// ===== 3. 키워드 자동 분류 =====
function classifyKeyword(keyword: string): { 
  category: string
  subcategory: string 
  search_intent: string
  priority: number 
} {
  const kw = keyword.toLowerCase()
  
  // 카테고리 분류
  let category = 'general'
  let subcategory = '기타'
  let search_intent = 'info'
  let priority = 60

  // implant
  if (/임플란트|뼈이식|상악동|골이식|픽스처|어버트먼트/.test(kw)) {
    category = 'implant'
    if (/비용|가격|할부/.test(kw)) { subcategory = '비용'; priority = 80 }
    else if (/보험|실비|건강보험/.test(kw)) { subcategory = '보험'; priority = 85 }
    else if (/후|회복|통증|붓기|출혈|음식|운동|담배|술/.test(kw)) { subcategory = '회복'; priority = 75 }
    else if (/과정|시간|방법|마취|절개/.test(kw)) { subcategory = '과정'; priority = 75 }
    else if (/실패|위험|부작용|흔들|주위염|냄새/.test(kw)) { subcategory = '문제'; priority = 80 }
    else if (/vs|비교|차이|뭐가/.test(kw)) { subcategory = '비교'; search_intent = 'comparison'; priority = 80 }
    else if (/관리|칫솔|수명|정기/.test(kw)) { subcategory = '관리'; priority = 70 }
    else if (/무섭|아프|두렵|공포/.test(kw)) { subcategory = '불안'; priority = 75 }
    else if (/당뇨|고혈압|골다공증|임산부|흡연/.test(kw)) { subcategory = '특수'; priority = 70 }
    else if (/대전|세종|청주|천안|아산/.test(kw)) { subcategory = '지역'; search_intent = 'local'; priority = 75 }
    else { subcategory = '일반'; priority = 70 }
  }
  // orthodontics
  else if (/교정|투명교정|인비절라인|라미네이트|미백|설측|세라믹교정|돌출입|덧니|벌어짐|주걱/.test(kw)) {
    category = 'orthodontics'
    if (/비용|가격/.test(kw)) { subcategory = '비용'; priority = 80 }
    else if (/vs|비교|차이/.test(kw)) { subcategory = '비교'; search_intent = 'comparison'; priority = 80 }
    else if (/아이|소아|초등|유치|몇살/.test(kw)) { subcategory = '소아'; priority = 75 }
    else if (/미백|하얗|누런/.test(kw)) { subcategory = '미백'; priority = 75 }
    else if (/라미네이트/.test(kw)) { subcategory = '심미'; priority = 75 }
    else if (/후회|무섭|아프/.test(kw)) { subcategory = '불안'; priority = 75 }
    else if (/유지|관리|음식|양치/.test(kw)) { subcategory = '관리'; priority = 70 }
    else { subcategory = '일반'; priority = 70 }
  }
  // prevention
  else if (/칫솔|치실|치간|스케일링|불소|실란트|예방|구강위생|검진|워터픽|전동칫솔/.test(kw)) {
    category = 'prevention'
    if (/스케일링/.test(kw)) { subcategory = '스케일링'; priority = 80 }
    else if (/아이|소아|유치|몇살/.test(kw)) { subcategory = '소아'; priority = 75 }
    else if (/칫솔|치실|치간|워터픽/.test(kw)) { subcategory = '구강위생'; priority = 70 }
    else if (/음식|영양/.test(kw)) { subcategory = '영양'; priority = 60 }
    else { subcategory = '예방'; priority = 65 }
  }
  // local
  else if (/추천|잘하는\s*(곳|치과)|야간|주말|24시|응급/.test(kw) && /대전|세종|청주|천안|아산|충청|충북|충남|서산|당진|논산|공주|보령|제천|충주|홍성|예산/.test(kw)) {
    category = 'local'
    search_intent = 'local'
    const cities = ['대전', '세종', '청주', '천안', '아산', '서산', '당진', '논산', '공주', '보령', '제천', '충주', '홍성', '예산']
    const matched = cities.find(c => kw.includes(c))
    subcategory = matched || '충청권'
    priority = 75
  }
  // general 세분화
  else {
    if (/충치/.test(kw)) { subcategory = '충치'; priority = 80 }
    else if (/신경치료|신경/.test(kw)) { subcategory = '신경치료'; priority = 80 }
    else if (/사랑니|발치/.test(kw)) { subcategory = '발치'; priority = 85 }
    else if (/잇몸|치주|치은|치석/.test(kw)) { subcategory = '잇몸'; priority = 80 }
    else if (/크라운|보철|인레이|온레이/.test(kw)) { subcategory = '보철'; priority = 75 }
    else if (/통증|응급|아프|부러|빠졌/.test(kw)) { subcategory = '응급'; priority = 85 }
    else if (/턱관절|이갈이/.test(kw)) { subcategory = '턱관절'; priority = 70 }
    else if (/보험|실비|건강보험|비급여/.test(kw)) { subcategory = '보험'; priority = 80 }
    else if (/마취|수면/.test(kw)) { subcategory = '마취'; priority = 70 }
    else { subcategory = '기타'; priority = 60 }
  }
  
  // 검색 의도 보정
  if (/vs|비교|차이|뭐가\s*(좋|나)|어떤/.test(kw)) search_intent = 'comparison'
  else if (/추천|잘하는|고르는/.test(kw)) search_intent = 'local'
  
  // 질문형 + 구체적 키워드는 우선순위 UP
  if (/나요|할까|인가요|되나요|어떻게|어떡|응급|꼭/.test(kw)) priority = Math.min(90, priority + 5)
  
  return { category, subcategory, search_intent, priority }
}

// ===== 4. 중복 체크 =====
async function checkDuplicate(db: D1Database, keyword: string): Promise<boolean> {
  const existing = await db.prepare(
    'SELECT id FROM keywords WHERE keyword = ? LIMIT 1'
  ).bind(keyword).first()
  return !!existing
}


// ======================================================================
// API 엔드포인트
// ======================================================================

// POST /api/keyword-discovery/discover — 시드 키워드로 자동 수집
keywordDiscoveryRoutes.post('/discover', async (c) => {
  const body = await c.req.json()
  const seeds: string[] = (body as any).seeds || []
  const autoSave = (body as any).auto_save !== false // 기본 true
  const includeGoogle = (body as any).include_google !== false // 기본 true
  
  if (seeds.length === 0) {
    return c.json({ error: '시드 키워드를 입력하세요 (seeds: ["임플란트", "교정"])' }, 400)
  }
  
  const allDiscovered: any[] = []
  const errors: string[] = []
  
  for (const seed of seeds) {
    try {
      // 1. 치과 도메인 파생어 생성
      const variations = generateDentalVariations(seed)
      
      // 2. Google Autocomplete (옵션)
      let googleSuggestions: string[] = []
      if (includeGoogle) {
        // 기본 검색
        const baseSuggestions = await fetchGoogleSuggestions(seed)
        googleSuggestions.push(...baseSuggestions)
        
        // "치과" 조합 검색
        if (!seed.includes('치과')) {
          const dentalSuggestions = await fetchGoogleSuggestions(`${seed} 치과`)
          googleSuggestions.push(...dentalSuggestions)
        }
        
        // "후기" 조합
        const reviewSuggestions = await fetchGoogleSuggestions(`${seed} 후기`)
        googleSuggestions.push(...reviewSuggestions)
        
        // 비용 조합
        const costSuggestions = await fetchGoogleSuggestions(`${seed} 비용`)
        googleSuggestions.push(...costSuggestions)
      }
      
      // 3. 전체 후보 통합 + 중복 제거
      const candidates = [...new Set([...variations, ...googleSuggestions])]
        .map(kw => kw.trim())
        .filter(kw => kw.length >= 3 && kw.length <= 50)
        // 치과 관련 아닌 것 필터링
        .filter(kw => {
          const irrelevant = /대출|보험사|자동차|부동산|주식|코인|다이어트|성형외과|피부과|한의원|약국|병원비|의료분쟁/
          return !irrelevant.test(kw)
        })
      
      for (const kw of candidates) {
        // DB 중복 체크
        const isDuplicate = await checkDuplicate(c.env.DB, kw)
        if (isDuplicate) continue
        
        // 이미 수집 목록에 있는지 체크
        if (allDiscovered.some(d => d.keyword === kw)) continue
        
        // 자동 분류
        const classification = classifyKeyword(kw)
        
        allDiscovered.push({
          keyword: kw,
          ...classification,
          source: googleSuggestions.includes(kw) ? 'google' : 'variation',
          seed: seed
        })
      }
    } catch (e: any) {
      errors.push(`"${seed}" 처리 실패: ${e.message}`)
    }
  }
  
  // 자동 저장
  let savedCount = 0
  if (autoSave && allDiscovered.length > 0) {
    for (const kw of allDiscovered) {
      try {
        await c.env.DB.prepare(
          `INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority, is_active) 
           VALUES (?, ?, ?, ?, ?, 1)`
        ).bind(kw.keyword, kw.category, kw.subcategory, kw.search_intent, kw.priority).run()
        savedCount++
      } catch (e: any) {
        // 중복 등 무시
      }
    }
  }
  
  // 카테고리별 요약
  const summary: Record<string, number> = {}
  for (const kw of allDiscovered) {
    summary[kw.category] = (summary[kw.category] || 0) + 1
  }
  
  return c.json({
    message: `${allDiscovered.length}개 키워드 발견, ${savedCount}개 저장`,
    seeds_used: seeds,
    total_discovered: allDiscovered.length,
    saved: savedCount,
    by_category: summary,
    by_source: {
      google: allDiscovered.filter(d => d.source === 'google').length,
      variation: allDiscovered.filter(d => d.source === 'variation').length
    },
    errors: errors.length > 0 ? errors : undefined,
    keywords: allDiscovered.slice(0, 100) // 미리보기 100개
  })
})

// POST /api/keyword-discovery/auto-expand — 기존 키워드 DB에서 자동 확장
keywordDiscoveryRoutes.post('/auto-expand', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const maxSeeds = (body as any).max_seeds || 20
  const includeGoogle = (body as any).include_google !== false
  
  // 사용되지 않은 인기 키워드를 시드로 사용
  const seedRows = await c.env.DB.prepare(
    `SELECT DISTINCT keyword FROM keywords 
     WHERE is_active = 1 AND priority >= 70
     ORDER BY used_count ASC, priority DESC
     LIMIT ?`
  ).bind(maxSeeds).all()
  
  const seeds = (seedRows.results || []).map((r: any) => r.keyword)
  
  if (seeds.length === 0) {
    return c.json({ error: '확장할 시드 키워드가 없습니다' }, 400)
  }
  
  // 각 시드에서 Google Suggest만 수집 (파생어는 이미 충분)
  let totalDiscovered = 0
  let totalSaved = 0
  const results: any[] = []
  
  for (const seed of seeds) {
    let suggestions: string[] = []
    
    if (includeGoogle) {
      suggestions = await fetchGoogleSuggestions(seed)
    }
    
    // 파생어도 약간 추가
    const variations = generateDentalVariations(seed).slice(0, 5) // 핵심 5개만
    
    const candidates = [...new Set([...suggestions, ...variations])]
      .filter(kw => kw.trim().length >= 3 && kw.trim().length <= 50)
      .filter(kw => !/대출|보험사|자동차|부동산|주식|코인/.test(kw))
    
    let seedSaved = 0
    for (const kw of candidates) {
      const isDuplicate = await checkDuplicate(c.env.DB, kw.trim())
      if (isDuplicate) continue
      
      const classification = classifyKeyword(kw.trim())
      
      try {
        await c.env.DB.prepare(
          `INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority, is_active)
           VALUES (?, ?, ?, ?, ?, 1)`
        ).bind(kw.trim(), classification.category, classification.subcategory, classification.search_intent, classification.priority).run()
        seedSaved++
        totalSaved++
      } catch {}
      
      totalDiscovered++
    }
    
    if (seedSaved > 0) {
      results.push({ seed, discovered: candidates.length, saved: seedSaved })
    }
  }
  
  return c.json({
    message: `${totalDiscovered}개 발견, ${totalSaved}개 새로 저장`,
    seeds_used: seeds.length,
    total_discovered: totalDiscovered,
    total_saved: totalSaved,
    results: results.slice(0, 30)
  })
})

// GET /api/keyword-discovery/suggestions — 추천 시드 키워드 목록
keywordDiscoveryRoutes.get('/suggestions', async (c) => {
  // 인기 치과 키워드 시드 추천
  const popularSeeds = [
    // 핵심 치료
    '임플란트', '치아교정', '라미네이트', '치아미백', '충치 치료',
    '사랑니 발치', '신경치료', '스케일링', '크라운',
    // 증상
    '치통', '잇몸 출혈', '이 시림', '턱관절',
    // 충청권 지역
    '대전 치과', '세종 치과', '청주 치과', '천안 치과',
    // 환자 관심사
    '치과 비용', '치과 보험', '치과 공포', '소아치과'
  ]
  
  // DB에서 가장 많이 검색될 법한 미사용 키워드
  const topUnused = await c.env.DB.prepare(
    `SELECT keyword, category, priority FROM keywords 
     WHERE is_active = 1 AND used_count = 0 
     ORDER BY priority DESC LIMIT 20`
  ).all()
  
  return c.json({
    recommended_seeds: popularSeeds,
    top_unused_keywords: topUnused.results
  })
})

// GET /api/keyword-discovery/stats — 키워드 DB 통계
keywordDiscoveryRoutes.get('/stats', async (c) => {
  const stats = await c.env.DB.prepare(`
    SELECT 
      category,
      COUNT(*) as total,
      SUM(CASE WHEN used_count = 0 THEN 1 ELSE 0 END) as unused,
      SUM(CASE WHEN used_count > 0 THEN 1 ELSE 0 END) as used,
      AVG(priority) as avg_priority,
      COUNT(DISTINCT subcategory) as subcategories
    FROM keywords WHERE is_active = 1
    GROUP BY category ORDER BY total DESC
  `).all()
  
  const total = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM keywords WHERE is_active = 1').first() as any
  const unused = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM keywords WHERE is_active = 1 AND used_count = 0').first() as any
  
  // 일일 소진율 계산 (매일 5개 기준)
  const postsPerDay = 5
  const daysRemaining = Math.floor((unused?.cnt || 0) / postsPerDay)
  
  return c.json({
    total_keywords: total?.cnt || 0,
    unused_keywords: unused?.cnt || 0,
    usage_rate: total?.cnt ? Math.round((1 - (unused?.cnt || 0) / total.cnt) * 100) : 0,
    days_remaining: daysRemaining,
    months_remaining: Math.round(daysRemaining / 30 * 10) / 10,
    by_category: stats.results,
    recommendation: daysRemaining < 30 
      ? '⚠️ 키워드가 1개월 미만 남았습니다. 자동 확장을 실행하세요!' 
      : daysRemaining < 90
        ? '📋 3개월 이내 소진 예상. 키워드 보충을 권장합니다.'
        : `✅ ${Math.round(daysRemaining / 30)}개월분 키워드가 준비되어 있습니다.`,
    auto_replenish: {
      enabled: true,
      threshold_days: 30,
      target_days: 90,
      last_run: (await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'last_keyword_replenish'").first())?.value || null,
      last_count: parseInt((await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'last_keyword_replenish_count'").first())?.value as string || '0'),
      seasonal_seeds_this_month: getSeasonalSeeds().length
    }
  })
})

// POST /api/keyword-discovery/auto-replenish — 수동으로 자동 보충 트리거
keywordDiscoveryRoutes.post('/auto-replenish', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const thresholdDays = (body as any).threshold_days || 30
  const targetDays = (body as any).target_days || 90
  const postsPerDay = (body as any).posts_per_day || 5
  const forceRun = (body as any).force || false
  
  const result = await autoReplenishKeywords(c.env.DB, {
    postsPerDay,
    thresholdDays: forceRun ? 9999 : thresholdDays, // force면 항상 실행
    targetDays
  })
  
  return c.json(result)
})

// GET /api/keyword-discovery/seasonal — 이번 달 계절 시드 확인
keywordDiscoveryRoutes.get('/seasonal', async (c) => {
  const seeds = getSeasonalSeeds()
  const month = new Date(Date.now() + 9 * 60 * 60 * 1000).getMonth() + 1
  return c.json({
    month,
    seasonal_seeds: seeds,
    count: seeds.length
  })
})

// ======================================================================
// 자동 보충 시스템 (Cron에서 호출)
// ======================================================================

/**
 * 월/계절별 트렌드 시드 키워드 자동 생성
 * 치과는 계절, 시기에 따라 검색 트렌드가 확실히 달라짐
 */
function getSeasonalSeeds(): string[] {
  const month = new Date(Date.now() + 9 * 60 * 60 * 1000).getMonth() + 1 // KST 기준 월

  // 공통 상시 시드 (항상 포함)
  const base = ['치통', '충치', '임플란트', '스케일링']

  // 월별/계절별 트렌드 시드
  const monthly: Record<number, string[]> = {
    1: ['새해 치아 관리', '겨울 이 시림', '설날 치과', '연초 치과 검진', '겨울 잇몸 출혈'],
    2: ['발렌타인 미백', '졸업 치아교정', '봄 치과 검진', '초콜릿 충치', '입학 전 치과'],
    3: ['봄 스케일링', '입학 치과 검진', '환절기 구내염', '취업 면접 미백', '새학기 교정'],
    4: ['봄 알레르기 구강건조', '치아의 날', '어린이 불소도포', '황사 구강관리', '소풍 치아 외상'],
    5: ['어린이날 소아치과', '어버이날 임플란트', '가정의 달 치과', '자외선 입술 관리'],
    6: ['여름 임플란트', '장마철 치통', '수능 치아교정 시작', '여름방학 교정', '에어컨 구강건조'],
    7: ['여름방학 사랑니', '빙수 이 시림', '여름 치과 할인', '물놀이 치아 외상', '아이스크림 시린이'],
    8: ['개학 전 치과 검진', '여름 입냄새', '무더위 잇몸질환', '휴가 후 치과'],
    9: ['추석 치과 검진', '가을 스케일링', '환절기 구강관리', '수험생 치아관리', '가을 임플란트'],
    10: ['할로윈 사탕 충치', '가을 미백', '연말 치과 계획', '단풍 시즌 치과', '건강검진 치과'],
    11: ['수능 후 교정', '연말 임플란트', '블랙프라이데이 치과', '김장철 턱관절', '겨울 대비 치과'],
    12: ['연말 치아미백', '크리스마스 미백', '송년 스케일링', '겨울방학 교정', '신년 치과 계획']
  }

  // 시기별 특수 시드
  const seasonal: string[] = []
  if (month >= 3 && month <= 5) seasonal.push('봄철 구강관리', '황사 마스크 구취', '알레르기 구강건조증')
  if (month >= 6 && month <= 8) seasonal.push('여름철 치과', '냉음료 시린이', '수영장 치아 외상')
  if (month >= 9 && month <= 11) seasonal.push('가을 건강검진 치과', '환절기 잇몸', '수험생 구강관리')
  if (month === 12 || month <= 2) seasonal.push('겨울 이 시림 원인', '건조한 겨울 구강', '명절 치과 응급')

  return [...base, ...(monthly[month] || []), ...seasonal]
}

/**
 * 키워드 자동 보충 함수 (Cron에서 매일 호출)
 * 잔여량이 임계치 이하이면 자동으로 키워드를 수집·확장
 */
async function autoReplenishKeywords(db: D1Database, options?: {
  postsPerDay?: number      // 일일 발행 수 (기본 5)
  thresholdDays?: number    // 이 일수 이하로 떨어지면 보충 (기본 30)
  targetDays?: number       // 보충 목표 일수 (기본 90)
}): Promise<{
  triggered: boolean
  reason: string
  discovered: number
  saved: number
  details?: any
}> {
  const postsPerDay = options?.postsPerDay || 5
  const thresholdDays = options?.thresholdDays || 30
  const targetDays = options?.targetDays || 90

  // 1. 현재 미사용 키워드 수 확인
  const unusedRow = await db.prepare(
    'SELECT COUNT(*) as cnt FROM keywords WHERE is_active = 1 AND used_count = 0'
  ).first() as any
  const unusedCount = unusedRow?.cnt || 0
  const daysRemaining = Math.floor(unusedCount / postsPerDay)

  // 2. 임계치 이상이면 스킵
  if (daysRemaining >= thresholdDays) {
    return {
      triggered: false,
      reason: `키워드 충분: ${unusedCount}개 (${daysRemaining}일분), 임계치 ${thresholdDays}일 이상`,
      discovered: 0,
      saved: 0
    }
  }

  // 3. 보충 필요! 목표치까지 채울 수량 계산
  const neededKeywords = (targetDays * postsPerDay) - unusedCount
  console.log(`[키워드 자동 보충] 잔여 ${unusedCount}개(${daysRemaining}일) < 임계치 ${thresholdDays}일 → ${neededKeywords}개 수집 목표`)

  let totalDiscovered = 0
  let totalSaved = 0
  const allDetails: any[] = []

  // Phase 1: 계절/트렌드 시드로 수집
  const seasonalSeeds = getSeasonalSeeds()
  for (const seed of seasonalSeeds) {
    if (totalSaved >= neededKeywords) break
    const variations = generateDentalVariations(seed)
    let seedSaved = 0
    for (const kw of variations) {
      const trimmed = kw.trim()
      if (trimmed.length < 3 || trimmed.length > 50) continue
      if (/대출|보험사|자동차|부동산|주식|코인/.test(trimmed)) continue

      const existing = await db.prepare('SELECT id FROM keywords WHERE keyword = ? LIMIT 1').bind(trimmed).first()
      if (existing) continue

      const classification = classifyKeyword(trimmed)
      try {
        await db.prepare(
          `INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority, is_active)
           VALUES (?, ?, ?, ?, ?, 1)`
        ).bind(trimmed, classification.category, classification.subcategory, classification.search_intent, classification.priority).run()
        seedSaved++
        totalSaved++
      } catch {}
      totalDiscovered++
    }
    if (seedSaved > 0) allDetails.push({ seed, source: 'seasonal', saved: seedSaved })
  }

  // Phase 2: 기존 고우선순위 키워드에서 파생
  if (totalSaved < neededKeywords) {
    const topSeeds = await db.prepare(
      `SELECT DISTINCT keyword FROM keywords 
       WHERE is_active = 1 AND priority >= 70
       ORDER BY used_count ASC, priority DESC LIMIT 30`
    ).all()

    for (const row of (topSeeds.results || []) as any[]) {
      if (totalSaved >= neededKeywords) break
      const seed = row.keyword
      const variations = generateDentalVariations(seed).slice(0, 10) // 핵심 10개만
      let seedSaved = 0

      for (const kw of variations) {
        const trimmed = kw.trim()
        if (trimmed.length < 3 || trimmed.length > 50) continue
        if (/대출|보험사|자동차|부동산|주식|코인/.test(trimmed)) continue

        const existing = await db.prepare('SELECT id FROM keywords WHERE keyword = ? LIMIT 1').bind(trimmed).first()
        if (existing) continue

        const classification = classifyKeyword(trimmed)
        try {
          await db.prepare(
            `INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority, is_active)
             VALUES (?, ?, ?, ?, ?, 1)`
          ).bind(trimmed, classification.category, classification.subcategory, classification.search_intent, classification.priority).run()
          seedSaved++
          totalSaved++
        } catch {}
        totalDiscovered++
      }
      if (seedSaved > 0) allDetails.push({ seed, source: 'expansion', saved: seedSaved })
    }
  }

  // Phase 3: Google Autocomplete (Phase 1, 2로 부족하면)
  if (totalSaved < neededKeywords) {
    const coreSeeds = ['임플란트', '치아교정', '사랑니', '충치 치료', '스케일링', '치아미백', '라미네이트', '잇몸 치료', '크라운', '신경치료']
    for (const seed of coreSeeds) {
      if (totalSaved >= neededKeywords) break
      try {
        const suggestions = await fetchGoogleSuggestions(seed)
        let seedSaved = 0
        for (const kw of suggestions) {
          const trimmed = kw.trim()
          if (trimmed.length < 3 || trimmed.length > 50) continue
          if (/대출|보험사|자동차|부동산|주식|코인|다이어트|성형외과|피부과|한의원/.test(trimmed)) continue

          const existing = await db.prepare('SELECT id FROM keywords WHERE keyword = ? LIMIT 1').bind(trimmed).first()
          if (existing) continue

          const classification = classifyKeyword(trimmed)
          try {
            await db.prepare(
              `INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority, is_active)
               VALUES (?, ?, ?, ?, ?, 1)`
            ).bind(trimmed, classification.category, classification.subcategory, classification.search_intent, classification.priority).run()
            seedSaved++
            totalSaved++
          } catch {}
          totalDiscovered++
        }
        if (seedSaved > 0) allDetails.push({ seed, source: 'google', saved: seedSaved })
      } catch (e: any) {
        console.error(`[Google Suggest 실패] ${seed}:`, e.message)
      }
    }
  }

  // 보충 이력 기록
  try {
    await db.prepare(
      `INSERT INTO settings (key, value, description) VALUES ('last_keyword_replenish', ?, '마지막 키워드 자동 보충 일시')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(new Date().toISOString()).run()
    await db.prepare(
      `INSERT INTO settings (key, value, description) VALUES ('last_keyword_replenish_count', ?, '마지막 키워드 자동 보충 수량')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).bind(String(totalSaved)).run()
  } catch {}

  return {
    triggered: true,
    reason: `잔여 ${unusedCount}개(${daysRemaining}일) < 임계치 ${thresholdDays}일 → ${totalSaved}개 보충`,
    discovered: totalDiscovered,
    saved: totalSaved,
    details: allDetails
  }
}

export { keywordDiscoveryRoutes, classifyKeyword, fetchGoogleSuggestions, generateDentalVariations, autoReplenishKeywords, getSeasonalSeeds }
