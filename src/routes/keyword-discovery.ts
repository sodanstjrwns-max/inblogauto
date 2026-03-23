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
        : `✅ ${Math.round(daysRemaining / 30)}개월분 키워드가 준비되어 있습니다.`
  })
})

export { keywordDiscoveryRoutes, classifyKeyword, fetchGoogleSuggestions, generateDentalVariations }
