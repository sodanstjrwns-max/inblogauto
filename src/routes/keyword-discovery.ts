import { Hono } from 'hono'
import type { Bindings } from '../index'

const keywordDiscoveryRoutes = new Hono<{ Bindings: Bindings }>()

// ======================================================================
// 키워드 시스템 v3 — 큐레이션 기반 고품질 키워드
// "환자가 실제로 검색하는 완전한 문장"만 사용
// 기계적 파생어 조합 제거 → 수동 큐레이션 + Google Suggest만
// ======================================================================

// ===== 1. Google Autocomplete API =====
async function fetchGoogleSuggestions(seed: string, lang: string = 'ko'): Promise<string[]> {
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(seed)}&hl=${lang}`
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    if (!response.ok) return []
    const data: any = await response.json()
    return (data[1] || []).filter((s: string) => s !== seed)
  } catch (e: any) {
    console.error('Google Suggest 실패:', e.message)
    return []
  }
}

// ===== 2. 차단 필터 (강화) =====
const BLOCKED_KEYWORD_PATTERNS = /비용|가격|할부|할인|보험|실비|실손|급여|비급여|건강보험|얼마|원\s*$|가격대|잘하는\s*(곳|치과)|추천\s*(병원|치과)|맛집|후기|리뷰|대출|보험사|자동차|부동산|주식|코인|다이어트|성형외과|피부과|한의원|약국|병원비|의료분쟁|환절기|황사|알레르기|구내염|마스크\s*구취/

function isBlockedKeyword(keyword: string): boolean {
  return BLOCKED_KEYWORD_PATTERNS.test(keyword.toLowerCase())
}

// ===== 3. 의미적 중복 감지 =====
function hasDuplicateWords(keyword: string): boolean {
  const words = keyword.split(/\s+/)
  // "아프나요 아프나요", "통증 통증" 같은 단어 반복
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] === words[i + 1] && words[i].length >= 2) return true
  }
  // "시린이 시림", "통증 아프나요" 같은 의미 중복
  const painWords = ['통증', '아프나요', '아픈', '아프다', '고통', '아파요']
  const painCount = words.filter(w => painWords.some(p => w.includes(p))).length
  if (painCount >= 2) return true
  return false
}

// ===== 4. 키워드 품질 검증 =====
function isQualityKeyword(keyword: string): boolean {
  if (keyword.length < 4 || keyword.length > 40) return false
  if (hasDuplicateWords(keyword)) return false
  if (isBlockedKeyword(keyword)) return false
  // 치과 관련 단어가 하나도 없으면 차단
  const dentalTerms = /임플란트|교정|충치|사랑니|발치|신경치료|잇몸|치주|스케일링|크라운|인레이|레진|보철|미백|라미네이트|치아|치통|이갈이|턱관절|불소|실란트|뼈이식|상악동|틀니|브릿지|마취|수면치료|시린이|치석|치은|구강|덧니|돌출입|벌어짐|주걱/
  if (!dentalTerms.test(keyword)) return false
  return true
}

// ===== 5. 키워드 자동 분류 =====
function classifyKeyword(keyword: string): { 
  category: string
  subcategory: string 
  search_intent: string
  priority: number 
} {
  const kw = keyword.toLowerCase()
  
  let category = 'general'
  let subcategory = '기타'
  let search_intent = 'info'
  let priority = 70

  // implant
  if (/임플란트|뼈이식|상악동|골이식|픽스처|어버트먼트/.test(kw)) {
    category = 'implant'
    if (/후.*회복|통증|붓기|출혈|음식|운동|담배|술|관리/.test(kw)) { subcategory = '회복'; priority = 80 }
    else if (/과정|시간|방법|마취|절개|수술|단계/.test(kw)) { subcategory = '과정'; priority = 80 }
    else if (/실패|위험|부작용|흔들|주위염|냄새|염증/.test(kw)) { subcategory = '문제'; priority = 85 }
    else if (/vs|비교|차이|뭐가/.test(kw)) { subcategory = '비교'; search_intent = 'comparison'; priority = 80 }
    else if (/수명|관리|칫솔|정기/.test(kw)) { subcategory = '관리'; priority = 75 }
    else if (/무섭|아프|두렵|공포|겁/.test(kw)) { subcategory = '불안'; priority = 80 }
    else if (/당뇨|고혈압|골다공증|임산부|흡연|고령/.test(kw)) { subcategory = '특수'; priority = 80 }
    else if (/적응증|필요|해야|대상/.test(kw)) { subcategory = '적응증'; priority = 80 }
    else { subcategory = '일반'; priority = 75 }
  }
  // orthodontics
  else if (/교정|투명교정|인비절라인|라미네이트|미백|설측|세라믹교정|돌출입|덧니|벌어짐|주걱/.test(kw)) {
    category = 'orthodontics'
    if (/vs|비교|차이/.test(kw)) { subcategory = '비교'; search_intent = 'comparison'; priority = 80 }
    else if (/아이|소아|초등|유치|몇살|어린이/.test(kw)) { subcategory = '소아'; priority = 80 }
    else if (/미백|하얗|누런/.test(kw)) { subcategory = '미백'; priority = 75 }
    else if (/기간|과정|방법|단계/.test(kw)) { subcategory = '과정'; priority = 80 }
    else if (/통증|아프|부작용/.test(kw)) { subcategory = '부작용'; priority = 80 }
    else if (/관리|음식|양치|유지/.test(kw)) { subcategory = '관리'; priority = 75 }
    else { subcategory = '일반'; priority = 75 }
  }
  // prevention
  else if (/칫솔|치실|치간|스케일링|불소|실란트|예방|구강위생|검진|워터픽|전동칫솔/.test(kw)) {
    category = 'prevention'
    if (/스케일링/.test(kw)) { subcategory = '스케일링'; priority = 80 }
    else if (/아이|소아|유치|몇살|어린이/.test(kw)) { subcategory = '소아'; priority = 75 }
    else { subcategory = '예방'; priority = 70 }
  }
  // general 세분화
  else {
    if (/충치/.test(kw)) { subcategory = '충치'; priority = 80 }
    else if (/신경치료|신경/.test(kw)) { subcategory = '신경치료'; priority = 80 }
    else if (/사랑니|발치/.test(kw)) { subcategory = '발치'; priority = 85 }
    else if (/잇몸|치주|치은|치석/.test(kw)) { subcategory = '잇몸'; priority = 80 }
    else if (/크라운|보철|인레이|온레이/.test(kw)) { subcategory = '보철'; priority = 75 }
    else if (/통증|응급|아프|부러|빠졌|치통/.test(kw)) { subcategory = '응급'; priority = 85 }
    else if (/턱관절|이갈이/.test(kw)) { subcategory = '턱관절'; priority = 75 }
    else if (/마취|수면/.test(kw)) { subcategory = '마취'; priority = 75 }
    else if (/시린이|시림/.test(kw)) { subcategory = '시린이'; priority = 80 }
    else { subcategory = '기타'; priority = 65 }
  }
  
  // 검색 의도 보정
  if (/vs|비교|차이|뭐가\s*(좋|나)|어떤/.test(kw)) search_intent = 'comparison'
  
  // 질문형 키워드 우선순위 UP
  if (/나요|할까|인가요|되나요|어떻게|어떡|꼭|해야|안\s*하면/.test(kw)) priority = Math.min(90, priority + 5)
  
  return { category, subcategory, search_intent, priority }
}

// ===== 6. 중복 체크 =====
async function checkDuplicate(db: D1Database, keyword: string): Promise<boolean> {
  const existing = await db.prepare(
    'SELECT id FROM keywords WHERE keyword = ? LIMIT 1'
  ).bind(keyword).first()
  return !!existing
}


// ======================================================================
// 큐레이션 키워드 DB — 실제 환자가 검색하는 완성된 키워드만
// ======================================================================

/**
 * 치과 핵심 키워드 마스터 리스트
 * 원칙:
 * 1. 실제 환자가 Google에 입력하는 완전한 검색어
 * 2. 비용/보험/가격 관련 키워드 절대 포함 안 함
 * 3. 각 키워드가 독립적으로 하나의 블로그 글이 될 수 있어야 함
 * 4. 의미적 중복 없음 (기계적 조합 X)
 */
function getCuratedKeywords(): string[] {
  return [
    // ===== 임플란트 (60개) =====
    '임플란트 수술 과정 단계별 설명',
    '임플란트 아프나요',
    '임플란트 부작용 종류',
    '임플란트 수술 후 회복 기간',
    '임플란트 수술 후 주의사항',
    '임플란트 수술 후 음식',
    '임플란트 실패 원인',
    '임플란트 수명',
    '임플란트 관리법',
    '임플란트 vs 브릿지 차이',
    '임플란트 vs 틀니 장단점',
    '임플란트 뼈이식 꼭 해야 하나요',
    '임플란트 뼈이식 회복 기간',
    '임플란트 뼈이식 과정',
    '임플란트 골이식 수술 후 붓기',
    '임플란트 주위염 증상',
    '임플란트 주위염 치료 방법',
    '임플란트 흔들림 원인',
    '임플란트 수술 마취 방법',
    '임플란트 수면마취 과정',
    '임플란트 1차 수술 2차 수술 차이',
    '임플란트 보철 종류',
    '상악동 거상술 과정',
    '상악동 거상술 회복 기간',
    '즉시 임플란트 적응증',
    '발치 후 임플란트 시기',
    '전체 임플란트 과정',
    '앞니 임플란트 과정',
    '어금니 임플란트 과정',
    '임플란트 수술 전 검사',
    '임플란트 꼭 해야 하나요',
    '임플란트 안 하면 어떻게 되나요',
    '임플란트 수술 시간',
    '임플란트 수술 후 운동',
    '임플란트 수술 후 담배',
    '임플란트 수술 후 술',
    '임플란트 수술 후 붓기 빼는 법',
    '임플란트 수술 후 통증 기간',
    '임플란트 수술 후 출혈',
    '임플란트 나사 풀림 증상',
    '당뇨 환자 임플란트',
    '고혈압 환자 임플란트',
    '골다공증 임플란트 가능한가요',
    '흡연자 임플란트 위험성',
    '고령자 임플란트 주의사항',
    '디지털 임플란트 장점',
    '네비게이션 임플란트 과정',
    '임플란트 크라운 종류',
    '지르코니아 크라운 장단점',
    '임플란트 오래 쓰는 방법',
    '임플란트 주변 잇몸 관리',
    '임플란트 칫솔질 방법',
    '임플란트 치간칫솔 사용법',
    '임플란트 정기검진 주기',
    '임플란트 수술 무섭다',
    '임플란트 통증 어느 정도인가요',
    '임플란트 마취 안 풀리면',
    '임플란트 감염 증상',
    '임플란트 재수술 과정',
    '임플란트 적응증과 금기증',

    // ===== 사랑니/발치 (30개) =====
    '사랑니 발치 과정',
    '사랑니 발치 아프나요',
    '사랑니 발치 후 회복 기간',
    '사랑니 발치 후 주의사항',
    '사랑니 발치 후 음식',
    '사랑니 꼭 뽑아야 하나요',
    '매복 사랑니 수술 과정',
    '매복 사랑니 증상',
    '사랑니 염증 증상',
    '사랑니 발치 후 붓기',
    '사랑니 발치 후 출혈',
    '사랑니 발치 후 운동',
    '사랑니 발치 후 담배',
    '사랑니 4개 한꺼번에 발치',
    '사랑니 발치 마취 종류',
    '사랑니 발치 후 감각 이상',
    '사랑니 발치 후 드라이소켓 증상',
    '사랑니 안 뽑으면 어떻게 되나요',
    '사랑니 발치 입원 필요한가요',
    '사랑니 수평매복 수술',
    '아래 사랑니 발치 위험성',
    '위 사랑니 발치 과정',
    '사랑니 발치 실밥 제거',
    '사랑니 발치 후 냄새',
    '사랑니 발치 후 입 벌리기 힘들 때',
    '사랑니 통증 응급처치',
    '사랑니 염증 항생제',
    '임산부 사랑니 발치',
    '사랑니 발치 후 신경 손상',
    '사랑니 옆 치아 충치',

    // ===== 신경치료 (20개) =====
    '신경치료 과정 단계별',
    '신경치료 아프나요',
    '신경치료 꼭 해야 하나요',
    '신경치료 후 크라운 필요한 이유',
    '신경치료 후 통증',
    '신경치료 후 주의사항',
    '신경치료 기간',
    '신경치료 몇 번 가야 하나요',
    '신경치료 실패 증상',
    '신경치료 재치료 과정',
    '신경치료 안 하면 어떻게 되나요',
    '신경치료 후 치아 수명',
    '신경치료 중 통증',
    '앞니 신경치료 과정',
    '어금니 신경치료 과정',
    '어린이 신경치료',
    '신경치료 vs 발치',
    '신경치료 후 변색',
    '신경치료 마취 안 듣는 이유',
    '신경치료 후 씹을 때 통증',

    // ===== 충치 (20개) =====
    '충치 치료 과정',
    '충치 치료 아프나요',
    '충치 진행 단계',
    '충치 초기 증상',
    '충치 방치하면 어떻게 되나요',
    '충치 자연치유 가능한가요',
    '충치 원인',
    '충치 예방법',
    '앞니 충치 치료 방법',
    '어금니 충치 치료',
    '어린이 충치 치료 과정',
    '유치 충치 치료 필요한가요',
    '충치 치료 후 시림',
    '충치 치료 후 통증',
    '충치 치료 종류',
    '레진 치료 과정',
    '레진 vs 인레이 차이',
    '세라믹 인레이 장단점',
    '금 인레이 vs 세라믹 인레이',
    '충치가 신경까지 갔을 때',

    // ===== 잇몸/치주 (25개) =====
    '잇몸병 초기 증상',
    '잇몸 출혈 원인',
    '잇몸 붓기 원인과 치료',
    '잇몸 내려앉음 치료',
    '잇몸 퇴축 원인',
    '치주염 증상',
    '치주염 치료 방법',
    '치주염 진행 단계',
    '치석 제거 과정',
    '치석 방치하면 어떻게 되나요',
    '잇몸 수술 과정',
    '잇몸 이식 수술',
    '치주 수술 회복 기간',
    '잇몸 약 효과 있나요',
    '잇몸 치료 기간',
    '잇몸에서 피 나는 이유',
    '잇몸 질환 자가진단',
    '스케일링 후 이 시림',
    '스케일링 주기',
    '스케일링 과정',
    '스케일링 꼭 해야 하나요',
    '스케일링 후 주의사항',
    '잇몸 재생 가능한가요',
    '치주 질환 예방법',
    '잇몸 건강 관리법',

    // ===== 교정 (30개) =====
    '치아 교정 과정 단계별',
    '치아 교정 기간',
    '치아 교정 아프나요',
    '치아 교정 부작용',
    '치아 교정 적응증',
    '투명교정 과정',
    '투명교정 vs 일반교정 차이',
    '투명교정 기간',
    '투명교정 장단점',
    '인비절라인 과정',
    '설측 교정 장단점',
    '세라믹 교정 과정',
    '돌출입 교정 방법',
    '덧니 교정 방법',
    '벌어진 앞니 교정',
    '주걱턱 교정 방법',
    '성인 교정 늦지 않았나요',
    '교정 중 통증 관리',
    '교정 중 음식 주의사항',
    '교정 중 양치 방법',
    '교정 장치 탈락 대처법',
    '교정 후 유지장치',
    '소아 교정 적정 시기',
    '어린이 교정 필요한 경우',
    '발치 교정 꼭 해야 하나요',
    '교정 발치 과정',
    '교정 고무줄 역할',
    '교정 기간 단축 방법',
    '교정 후 치아 벌어짐',
    '부정교합 종류와 치료',

    // ===== 심미 (15개) =====
    '치아 미백 과정',
    '치아 미백 부작용',
    '치아 미백 지속 기간',
    '치아 미백 시린 이유',
    '라미네이트 과정',
    '라미네이트 수명',
    '라미네이트 부작용',
    '라미네이트 vs 치아교정',
    '라미네이트 후 주의사항',
    '지르코니아 크라운 과정',
    '지르코니아 vs PFM 차이',
    '크라운 종류별 장단점',
    '크라운 치료 과정',
    '크라운 씌운 후 통증',
    '크라운 수명',

    // ===== 응급/통증 (20개) =====
    '치통 원인',
    '치통 응급처치',
    '밤에 치통 심한 이유',
    '치통 참으면 안 되는 이유',
    '이가 부러졌을 때 응급처치',
    '치아 빠졌을 때 응급처치',
    '치아 깨졌을 때 대처법',
    '시린이 원인',
    '시린이 치료 방법',
    '찬물 마시면 이가 시린 이유',
    '씹을 때 치아 통증',
    '치아 균열 증상',
    '치아 균열 치료',
    '턱관절 장애 증상',
    '턱관절 치료 방법',
    '이갈이 원인과 치료',
    '이갈이 마우스피스 효과',
    '구강건조증 원인과 치료',
    '치아 외상 응급처치',
    '치과 가기 전 통증 완화법',

    // ===== 소아/예방 (20개) =====
    '어린이 치과 검진 시기',
    '유치 빠지는 순서',
    '유치 신경치료 필요한가요',
    '실란트 효과',
    '실란트 적응증',
    '불소도포 효과',
    '불소도포 주기',
    '어린이 칫솔질 방법',
    '아이 충치 예방법',
    '소아 수면치료 과정',
    '소아 수면치료 안전한가요',
    '아기 이앓이 증상',
    '유치 충치 방치하면',
    '영구치 나오는 시기',
    '치아 건강 좋은 음식',
    '치아에 나쁜 습관',
    '올바른 칫솔질 방법',
    '치실 사용법',
    '워터픽 효과',
    '전동칫솔 vs 수동칫솔',

    // ===== 보철/기타 (15개) =====
    '브릿지 치료 과정',
    '브릿지 수명',
    '브릿지 vs 임플란트',
    '틀니 종류',
    '틀니 적응 기간',
    '틀니 관리법',
    '부분틀니 과정',
    '수면치료 과정',
    '수면치료 안전한가요',
    '치과 마취 종류',
    '치과 마취 안 듣는 이유',
    '치과 공포증 극복 방법',
    '치과 무서울 때 대처법',
    '구강검진 필요성',
    '정기 치과 검진 주기',

    // ===== 특수 상황 (15개) =====
    '임산부 치과 치료 가능한가요',
    '임산부 스케일링 괜찮나요',
    '임신 중 잇몸 출혈',
    '당뇨 환자 치과 치료 주의사항',
    '고혈압 환자 발치 위험성',
    '혈액희석제 복용 중 발치',
    '골다공증 약 복용 중 임플란트',
    '방사선 치료 후 치과 치료',
    '항암 치료 중 구강 관리',
    '당뇨 잇몸병 관계',
    '흡연과 잇몸 질환',
    '수면무호흡증 구강장치',
    '코골이 치과 치료',
    '치아 외상 후 변색',
    '치아 교정 중 임신',
  ]
}

// ======================================================================
// API 엔드포인트
// ======================================================================

// POST /api/keyword-discovery/discover — 시드 키워드로 자동 수집
keywordDiscoveryRoutes.post('/discover', async (c) => {
  const body = await c.req.json()
  const seeds: string[] = (body as any).seeds || []
  const autoSave = (body as any).auto_save !== false
  const includeGoogle = (body as any).include_google !== false
  
  if (seeds.length === 0) {
    return c.json({ error: '시드 키워드를 입력하세요 (seeds: ["임플란트", "교정"])' }, 400)
  }
  
  const allDiscovered: any[] = []
  const errors: string[] = []
  
  for (const seed of seeds) {
    try {
      let suggestions: string[] = []
      if (includeGoogle) {
        const base = await fetchGoogleSuggestions(seed)
        const dental = await fetchGoogleSuggestions(`${seed} 치과`)
        const process = await fetchGoogleSuggestions(`${seed} 과정`)
        const sideEffect = await fetchGoogleSuggestions(`${seed} 부작용`)
        suggestions = [...base, ...dental, ...process, ...sideEffect]
      }
      
      const candidates = [...new Set(suggestions)]
        .map(kw => kw.trim())
        .filter(kw => isQualityKeyword(kw))
      
      for (const kw of candidates) {
        const isDuplicate = await checkDuplicate(c.env.DB, kw)
        if (isDuplicate) continue
        if (allDiscovered.some(d => d.keyword === kw)) continue
        
        const classification = classifyKeyword(kw)
        allDiscovered.push({
          keyword: kw,
          ...classification,
          source: 'google',
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
      } catch {}
    }
  }
  
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
    errors: errors.length > 0 ? errors : undefined,
    keywords: allDiscovered.slice(0, 100)
  })
})

// POST /api/keyword-discovery/auto-expand — 기존 키워드에서 Google Suggest로 확장
keywordDiscoveryRoutes.post('/auto-expand', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const maxSeeds = (body as any).max_seeds || 20
  
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
  
  let totalDiscovered = 0
  let totalSaved = 0
  const results: any[] = []
  
  for (const seed of seeds) {
    // 핵심 단어 추출 (첫 2~3단어)
    const coreTerm = seed.split(/\s+/).slice(0, 2).join(' ')
    const suggestions = await fetchGoogleSuggestions(coreTerm)
    
    const candidates = [...new Set(suggestions)]
      .filter(kw => isQualityKeyword(kw.trim()))
    
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
      results.push({ seed: coreTerm, discovered: candidates.length, saved: seedSaved })
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
  const popularSeeds = [
    '임플란트', '치아교정', '사랑니 발치', '충치 치료',
    '신경치료', '스케일링', '크라운', '잇몸 치료',
    '라미네이트', '치아미백', '턱관절', '시린이',
  ]
  
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
      ? '⚠️ 키워드가 1개월 미만 남았습니다. 자동 보충을 실행하세요!' 
      : daysRemaining < 90
        ? '📋 3개월 이내 소진 예상. 키워드 보충을 권장합니다.'
        : `✅ ${Math.round(daysRemaining / 30)}개월분 키워드가 준비되어 있습니다.`,
    auto_replenish: {
      enabled: true,
      threshold_days: 30,
      target_days: 90,
      last_run: (await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'last_keyword_replenish'").first())?.value || null,
      last_count: parseInt((await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'last_keyword_replenish_count'").first())?.value as string || '0'),
    }
  })
})

// POST /api/keyword-discovery/auto-replenish — 수동 보충 트리거
keywordDiscoveryRoutes.post('/auto-replenish', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const thresholdDays = (body as any).threshold_days || 30
  const targetDays = (body as any).target_days || 90
  const postsPerDay = (body as any).posts_per_day || 5
  const forceRun = (body as any).force || false
  
  const result = await autoReplenishKeywords(c.env.DB, {
    postsPerDay,
    thresholdDays: forceRun ? 9999 : thresholdDays,
    targetDays
  })
  
  return c.json(result)
})

// GET /api/keyword-discovery/seasonal — 이번 달 큐레이션 키워드 확인
keywordDiscoveryRoutes.get('/seasonal', async (c) => {
  const keywords = getCuratedKeywords()
  return c.json({
    total_curated: keywords.length,
    sample: keywords.slice(0, 30),
    message: `큐레이션 키워드 ${keywords.length}개 준비됨 (기계적 파생어 폐지, 수동 큐레이션만 사용)`
  })
})

// ======================================================================
// 자동 보충 시스템 (Cron에서 호출) — v3: 큐레이션 기반
// ======================================================================

async function autoReplenishKeywords(db: D1Database, options?: {
  postsPerDay?: number
  thresholdDays?: number
  targetDays?: number
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

  const unusedRow = await db.prepare(
    'SELECT COUNT(*) as cnt FROM keywords WHERE is_active = 1 AND used_count = 0'
  ).first() as any
  const unusedCount = unusedRow?.cnt || 0
  const daysRemaining = Math.floor(unusedCount / postsPerDay)

  if (daysRemaining >= thresholdDays) {
    return {
      triggered: false,
      reason: `키워드 충분: ${unusedCount}개 (${daysRemaining}일분), 임계치 ${thresholdDays}일 이상`,
      discovered: 0,
      saved: 0
    }
  }

  console.log(`[키워드 자동 보충] 잔여 ${unusedCount}개(${daysRemaining}일) < 임계치 ${thresholdDays}일`)

  let totalSaved = 0
  const allDetails: any[] = []

  // Phase 1: 큐레이션 키워드 투입
  const curated = getCuratedKeywords()
  // 셔플해서 다양한 카테고리가 고르게 들어가게
  const shuffled = curated.sort(() => Math.random() - 0.5)
  
  for (const kw of shuffled) {
    if (totalSaved >= (targetDays * postsPerDay) - unusedCount) break
    
    const existing = await db.prepare('SELECT id FROM keywords WHERE keyword = ? LIMIT 1').bind(kw).first()
    if (existing) continue

    const classification = classifyKeyword(kw)
    try {
      await db.prepare(
        `INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).bind(kw, classification.category, classification.subcategory, classification.search_intent, classification.priority).run()
      totalSaved++
    } catch {}
  }
  if (totalSaved > 0) allDetails.push({ source: 'curated', saved: totalSaved })

  // Phase 2: Google Suggest로 추가 (큐레이션만으로 부족하면)
  const neededMore = (targetDays * postsPerDay) - unusedCount - totalSaved
  if (neededMore > 0) {
    const coreSeeds = ['임플란트', '치아교정', '사랑니', '충치', '신경치료', '스케일링', '잇몸', '크라운', '라미네이트', '시린이']
    let googleSaved = 0
    
    for (const seed of coreSeeds) {
      if (googleSaved >= neededMore) break
      try {
        const suggestions = await fetchGoogleSuggestions(seed)
        for (const s of suggestions) {
          const trimmed = s.trim()
          if (!isQualityKeyword(trimmed)) continue
          
          const existing = await db.prepare('SELECT id FROM keywords WHERE keyword = ? LIMIT 1').bind(trimmed).first()
          if (existing) continue

          const classification = classifyKeyword(trimmed)
          try {
            await db.prepare(
              `INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority, is_active)
               VALUES (?, ?, ?, ?, ?, 1)`
            ).bind(trimmed, classification.category, classification.subcategory, classification.search_intent, classification.priority).run()
            googleSaved++
            totalSaved++
          } catch {}
        }
      } catch (e: any) {
        console.error(`[Google Suggest 실패] ${seed}:`, e.message)
      }
    }
    if (googleSaved > 0) allDetails.push({ source: 'google', saved: googleSaved })
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
    reason: `잔여 ${unusedCount}개(${daysRemaining}일) < 임계치 ${thresholdDays}일 → ${totalSaved}개 보충 (큐레이션 기반)`,
    discovered: totalSaved,
    saved: totalSaved,
    details: allDetails
  }
}

export { keywordDiscoveryRoutes, classifyKeyword, fetchGoogleSuggestions, autoReplenishKeywords, getCuratedKeywords, isQualityKeyword }
