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

// ===== 5. 키워드 자동 분류 (v7.3+ 치과 전 진료 영역) =====
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

  // ── 1. 임플란트 ──
  if (/임플란트|뼈이식|상악동|골이식|픽스처|어버트먼트/.test(kw)) {
    category = 'implant'
    if (/후.*회복|통증|붓기|출혈|음식|운동|담배|술/.test(kw)) { subcategory = '임플란트_회복'; priority = 80 }
    else if (/과정|시간|방법|마취|절개|수술|단계/.test(kw)) { subcategory = '임플란트_과정'; priority = 80 }
    else if (/실패|위험|부작용|흔들|주위염|냄새|염증|나사/.test(kw)) { subcategory = '임플란트_문제'; priority = 85 }
    else if (/vs|비교|차이|뭐가/.test(kw)) { subcategory = '임플란트_비교'; search_intent = 'comparison'; priority = 80 }
    else if (/수명|관리|칫솔|정기/.test(kw)) { subcategory = '임플란트_관리'; priority = 75 }
    else if (/무섭|아프|두렵|공포|겁/.test(kw)) { subcategory = '임플란트_불안'; priority = 80 }
    else if (/당뇨|고혈압|골다공증|임산부|흡연|고령/.test(kw)) { subcategory = '임플란트_특수'; priority = 80 }
    else if (/적응증|필요|해야|대상|꼭|안\s*하면/.test(kw)) { subcategory = '임플란트_적응증'; priority = 80 }
    else { subcategory = '임플란트_일반'; priority = 75 }
  }
  // ── 2. 레진치료 (충치 레진 치료) ──
  else if (/레진(?!.*인레이)|본딩\s*치료/.test(kw) && !/인레이|온레이/.test(kw)) {
    category = 'general'; subcategory = '레진치료'; priority = 80
    if (/vs|비교|차이/.test(kw)) { search_intent = 'comparison'; priority = 85 }
    else if (/부작용|변색|떨어|탈락/.test(kw)) priority = 85
  }
  // ── 3. 인비절라인/투명교정 (교정과 분리) ──
  else if (/인비절라인|투명교정|투명\s*교정/.test(kw)) {
    category = 'orthodontics'; subcategory = '인비절라인'; priority = 80
    if (/vs|비교|차이/.test(kw)) { search_intent = 'comparison'; priority = 85 }
    else if (/기간|과정|단계/.test(kw)) priority = 80
    else if (/부작용|통증|실패/.test(kw)) priority = 85
  }
  // ── 4. 부분교정 ──
  else if (/부분\s*교정|앞니\s*교정/.test(kw)) {
    category = 'orthodontics'; subcategory = '부분교정'; priority = 80
    if (/vs|비교|차이/.test(kw)) { search_intent = 'comparison'; priority = 85 }
  }
  // ── 5. 설측교정 ──
  else if (/설측/.test(kw)) {
    category = 'orthodontics'; subcategory = '설측교정'; priority = 80
  }
  // ── 6. 전체/일반 교정 ──
  else if (/교정|세라믹교정|돌출입|덧니|벌어짐|주걱|부정교합/.test(kw)) {
    category = 'orthodontics'
    if (/전체|전악/.test(kw)) { subcategory = '전체교정'; priority = 80 }
    else if (/vs|비교|차이/.test(kw)) { subcategory = '교정_비교'; search_intent = 'comparison'; priority = 80 }
    else if (/아이|소아|초등|유치|몇살|어린이/.test(kw)) { subcategory = '소아교정'; priority = 80 }
    else if (/기간|과정|방법|단계/.test(kw)) { subcategory = '교정_과정'; priority = 80 }
    else if (/통증|아프|부작용/.test(kw)) { subcategory = '교정_부작용'; priority = 80 }
    else if (/관리|음식|양치|유지|고무줄/.test(kw)) { subcategory = '교정_관리'; priority = 75 }
    else if (/돌출입|주걱|덧니/.test(kw)) { subcategory = '전체교정'; priority = 85 }
    else { subcategory = '교정_일반'; priority = 75 }
  }
  // ── 7. 라미네이트 ──
  else if (/라미네이트/.test(kw)) {
    category = 'general'; subcategory = '라미네이트'; priority = 80
    if (/vs|비교|차이/.test(kw)) { search_intent = 'comparison'; priority = 85 }
    else if (/부작용|시림|통증/.test(kw)) priority = 85
    else if (/관리|주의|수명/.test(kw)) priority = 75
  }
  // ── 8. 미백/심미 ──
  else if (/미백|하얗|누런|치아\s*성형|착색|잇몸\s*미백|잇몸\s*성형|잇몸\s*라인|스마일\s*라인|잇몸\s*색/.test(kw)) {
    category = 'general'; subcategory = '미백_심미'; priority = 78
    if (/vs|비교|차이/.test(kw)) { search_intent = 'comparison'; priority = 80 }
    else if (/부작용|시림|통증/.test(kw)) priority = 85
    else if (/잇몸\s*성형|잇몸\s*라인|스마일/.test(kw)) { subcategory = '잇몸성형'; priority = 80 }
  }
  // ── 9. 재신경치료/치근단절제술 ──
  else if (/재신경|치근단|치근\s*단/.test(kw)) {
    category = 'general'; subcategory = '재신경치료'; priority = 85
    if (/절제술/.test(kw)) subcategory = '치근단절제술'
    if (/vs|비교|차이/.test(kw)) search_intent = 'comparison'
  }
  // ── 10. 신경치료 ──
  else if (/신경치료|신경\s*치료/.test(kw)) {
    category = 'general'; subcategory = '신경치료'; priority = 80
    if (/실패|재/.test(kw)) { subcategory = '재신경치료'; priority = 85 }
    else if (/후.*통증|안\s*하면/.test(kw)) priority = 85
  }
  // ── 11. 사랑니/발치/매복 ──
  else if (/사랑니|매복/.test(kw)) {
    category = 'general'; subcategory = '사랑니'; priority = 85
    if (/매복/.test(kw)) subcategory = '매복사랑니'
    if (/후.*회복|통증|붓기|음식/.test(kw)) priority = 85
  }
  else if (/발치/.test(kw)) {
    category = 'general'; subcategory = '발치'; priority = 80
    if (/후.*회복|통증|출혈/.test(kw)) priority = 85
  }
  // ── 12. 크라운/지르코니아 ──
  else if (/크라운|지르코니아|PFM|올세라믹/.test(kw)) {
    category = 'general'; subcategory = '크라운'; priority = 80
    if (/vs|비교|차이/.test(kw)) { search_intent = 'comparison'; priority = 85 }
    else if (/탈락|떨어|아래.*충치/.test(kw)) priority = 85
    else if (/임시/.test(kw)) subcategory = '임시치아'
  }
  // ── 13. 인레이/온레이/오버레이 ──
  else if (/인레이|온레이|오버레이/.test(kw)) {
    category = 'general'
    if (/오버레이/.test(kw)) { subcategory = '오버레이'; priority = 80 }
    else { subcategory = '인레이'; priority = 80 }
    if (/vs|비교|차이/.test(kw)) { search_intent = 'comparison'; priority = 85 }
  }
  // ── 14. 턱관절/이갈이 ──
  else if (/턱관절|이갈이|악관절|이\s*악물|턱\s*통증|턱\s*소리/.test(kw)) {
    category = 'general'; subcategory = '턱관절'; priority = 80
    if (/이갈이/.test(kw)) subcategory = '이갈이'
  }
  // ── 15. 잇몸/치주 ──
  else if (/잇몸|치주|치은|치석|치조골/.test(kw)) {
    category = 'general'
    if (/수술|이식|재생|스플린트/.test(kw)) { subcategory = '치주수술'; priority = 85 }
    else if (/퇴축|내려|올라/.test(kw)) { subcategory = '잇몸퇴축'; priority = 80 }
    else if (/고름|농양|부음|부었/.test(kw)) { subcategory = '잇몸응급'; priority = 85 }
    else { subcategory = '잇몸'; priority = 80 }
  }
  // ── 16. 충치/보존치료/크랙 ──
  else if (/충치|이차\s*충치|균열\s*증후군|치아\s*균열|마모|침식|쐐기|치경부|재석회화|크랙|금\s*갔/.test(kw)) {
    category = 'general'
    if (/이차|재발|다시/.test(kw)) { subcategory = '이차충치'; priority = 85 }
    else if (/균열|금|크랙/.test(kw)) { subcategory = '치아균열'; priority = 85 }
    else if (/마모|침식|쐐기|치경부/.test(kw)) { subcategory = '치아마모'; priority = 78 }
    else { subcategory = '충치'; priority = 80 }
  }
  // ── 17. 틀니 ──
  else if (/틀니|의치|오버덴처/.test(kw)) {
    category = 'general'; subcategory = '틀니'; priority = 80
  }
  // ── 18. 브릿지 ──
  else if (/브릿지/.test(kw)) {
    category = 'general'; subcategory = '브릿지'; priority = 80
    if (/vs|비교|차이/.test(kw)) { search_intent = 'comparison'; priority = 85 }
  }
  // ── 19. 보철 총론 / 포스트코어 ──
  else if (/보철|포스트\s*코어|코어\s*수복|포스트/.test(kw)) {
    category = 'general'
    if (/포스트|코어/.test(kw)) { subcategory = '포스트코어'; priority = 80 }
    else { subcategory = '보철'; priority = 78 }
    if (/vs|비교|차이|종류/.test(kw)) { search_intent = 'comparison'; priority = 80 }
  }
  // ── 20. 소아치과 ──
  else if (/소아|유치|어린이\s*치과|아이\s*치과|아이\s*충치|아이\s*칫솔|아이\s*이갈이|아이\s*교정|아이\s*구내염|영구치/.test(kw)) {
    category = 'general'; subcategory = '소아치과'; priority = 80
    if (/수면|마취/.test(kw)) { subcategory = '소아수면치료'; priority = 85 }
    else if (/교정/.test(kw)) { subcategory = '소아교정'; priority = 80 }
  }
  // ── 21. 마취/수면치료 ──
  else if (/마취|수면마취|수면치료|웃음가스|진정치료/.test(kw)) {
    category = 'general'; subcategory = '마취_수면'; priority = 78
    if (/웃음가스/.test(kw)) subcategory = '웃음가스'
    if (/위험|부작용|안전/.test(kw)) priority = 85
  }
  // ── 22. 구강외과/외상 ──
  else if (/부러졌|빠졌|금\s*갔|파절|탈구|낭종|구강암|턱뼈\s*골절|치아\s*외상/.test(kw)) {
    category = 'general'; subcategory = '구강외과'; priority = 85
  }
  // ── 23. 구취/입냄새 ──
  else if (/구취|입냄새|혀\s*세정/.test(kw)) {
    category = 'general'; subcategory = '구취'; priority = 78
  }
  // ── 24. 구강건조 ──
  else if (/구강\s*건조|침\s*분비/.test(kw)) {
    category = 'general'; subcategory = '구강건조'; priority = 78
  }
  // ── 25. 구강점막/혀 ──
  else if (/구내염|혀\s*통증|혀\s*궤양|입천장|구강\s*점막/.test(kw)) {
    category = 'general'; subcategory = '구강점막'; priority = 78
  }
  // ── 26. 스케일링 ──
  else if (/스케일링/.test(kw)) {
    category = 'prevention'; subcategory = '스케일링'; priority = 80
  }
  // ── 27. 예방/위생 ──
  else if (/칫솔|치실|치간|불소|실란트|예방|구강위생|검진|워터픽|전동칫솔/.test(kw)) {
    category = 'prevention'; subcategory = '예방'; priority = 70
  }
  // ── 28. 시린이 ──
  else if (/시린이|시림|시린\s*이/.test(kw)) {
    category = 'general'; subcategory = '시린이'; priority = 80
  }
  // ── 29. 응급/치통 ──
  else if (/통증|응급|아프|치통/.test(kw)) {
    category = 'general'; subcategory = '응급'; priority = 85
  }
  // ── fallback ──
  else {
    subcategory = '기타'; priority = 65
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

    // ===== 라미네이트 (25개) =====
    '라미네이트 과정',
    '라미네이트 수명',
    '라미네이트 부작용',
    '라미네이트 vs 치아교정',
    '라미네이트 후 주의사항',
    '라미네이트 아프나요',
    '라미네이트 치아 삭제량',
    '라미네이트 후 시림',
    '라미네이트 깨졌을 때 대처법',
    '라미네이트 변색 원인',
    '라미네이트 탈락 시 응급처치',
    '라미네이트 다시 붙이기 가능한가요',
    '라미네이트 몇 개 해야 하나요',
    '노프렙 라미네이트 장단점',
    '미니쉬 라미네이트 과정',
    '앞니 라미네이트 과정 후기',
    '라미네이트 vs 레진 차이',
    '라미네이트 색상 선택 기준',
    '라미네이트 적응증과 한계',
    '라미네이트 후 음식 주의사항',
    '라미네이트 수리 가능한가요',
    '벌어진 앞니 라미네이트',
    '치아 성형 라미네이트 과정',
    '연예인 치아 라미네이트',
    '라미네이트 오래 유지하는 방법',

    // ===== 크라운 (25개) =====
    '지르코니아 크라운 과정',
    '지르코니아 vs PFM 차이',
    '크라운 종류별 장단점',
    '크라운 치료 과정',
    '크라운 씌운 후 통증',
    '크라운 수명',
    '크라운 탈락 시 대처법',
    '크라운 안 씌우면 어떻게 되나요',
    '크라운 밑에 충치 증상',
    '크라운 다시 해야 하는 경우',
    '크라운 씌운 치아 관리법',
    '임시 크라운 주의사항',
    '올세라믹 크라운 장단점',
    '금 크라운 vs 지르코니아',
    '크라운 씌울 때 아프나요',
    '크라운 색상 맞추기',
    '크라운 치료 기간',
    '앞니 크라운 종류',
    '어금니 크라운 추천',
    '크라운 깨졌을 때',
    '크라운 높이 맞지 않을 때',
    'e.max 크라운 장단점',
    '크라운 후 잇몸 부음',
    '크라운 재제작 과정',
    '크라운 본뜨기 과정',

    // ===== 인레이/온레이 (20개) =====
    '인레이 치료 과정',
    '인레이 vs 레진 차이',
    '금 인레이 장단점',
    '세라믹 인레이 장단점',
    '인레이 수명',
    '인레이 빠졌을 때 대처법',
    '인레이 밑에 충치 증상',
    '인레이 아프나요',
    '인레이 탈락 원인',
    '온레이 치료 과정',
    '온레이 vs 크라운 차이',
    '인레이 vs 온레이 vs 크라운 비교',
    '지르코니아 인레이 장단점',
    '인레이 치료 기간',
    '인레이 접착 과정',
    '인레이 시린 증상',
    '레진 인레이 vs 세라믹 인레이',
    '인레이 재치료 과정',
    '인레이 후 음식 주의사항',
    '충치 인레이 꼭 해야 하나요',

    // ===== 턱관절/이갈이 (25개) =====
    '턱관절 장애 증상',
    '턱관절 치료 방법',
    '이갈이 원인과 치료',
    '이갈이 마우스피스 효과',
    '턱관절 소리 원인',
    '턱관절 통증 원인',
    '턱 빠졌을 때 응급처치',
    '턱관절 디스크 장애',
    '턱관절 MRI 검사 과정',
    '턱관절 물리치료 효과',
    '턱관절 보톡스 치료',
    '턱관절 교합 치료',
    '턱관절 스플린트 치료',
    '입 벌릴 때 턱 소리',
    '턱관절 자가 스트레칭',
    '턱관절 장애 자가진단',
    '이갈이 치아 마모 위험',
    '이 악물기 습관 교정',
    '수면 이갈이 원인',
    '스트레스 이갈이 관계',
    '턱관절 두통 관계',
    '턱관절 귀 통증',
    '양악수술 필요한 경우',
    '턱관절 재발 방지법',
    '이갈이 아이 치료',

    // ===== 미백/심미 (20개) =====
    '치아 미백 과정',
    '치아 미백 부작용',
    '치아 미백 지속 기간',
    '치아 미백 시린 이유',
    '자가 미백 vs 전문 미백 차이',
    '미백 젤 사용법',
    '미백 후 주의사항',
    '미백 치약 효과 있나요',
    '치아 누런 이유',
    '테트라사이클린 변색 치료',
    '죽은 치아 미백',
    '미백 트레이 과정',
    '레이저 미백 과정',
    '잇몸 미백 치료',
    '잇몸 착색 원인',
    '치아 본딩 치료',
    '심미 보철 종류',
    '웃을 때 잇몸 보이는 거미소',
    '잇몸 성형 과정',
    '치아 다이아몬드 장단점',

    // ===== 응급/통증 (15개 — 턱관절/이갈이는 별도 분리) =====
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

    // ===== 보철/틀니/브릿지 (25개) =====
    '브릿지 치료 과정',
    '브릿지 수명',
    '브릿지 vs 임플란트',
    '브릿지 탈락 시 대처법',
    '브릿지 밑 청소 방법',
    '브릿지 밑 충치 증상',
    '메릴랜드 브릿지 장단점',
    '틀니 종류',
    '틀니 적응 기간',
    '틀니 관리법',
    '부분틀니 과정',
    '틀니 통증 원인',
    '틀니 세척 방법',
    '틀니 안정제 사용법',
    '틀니 리라인 과정',
    '임플란트 틀니 과정',
    '임플란트 오버덴쳐 장단점',
    '치아 상실 방치하면',
    '보철 치료 종류 비교',
    '임시치아 주의사항',
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

    // ===== ★ v7.3+ 레진치료 (20개) =====
    '레진 치료 과정',
    '레진 치료 후 통증',
    '레진 치료 수명',
    '레진 충치 치료 과정',
    '레진 떨어졌을 때 대처법',
    '레진 변색 원인',
    '레진 vs 아말감 차이',
    '레진 vs 세라믹 차이',
    '앞니 레진 치료 후기',
    '앞니 레진 수명',
    '벌어진 앞니 레진 치료',
    '레진 치료 후 시림',
    '레진 치료 마취 안 하면',
    '레진 치료 몇 번 가야 하나요',
    '레진 색상 맞추기',
    '레진 치료 다시 해야 하는 시기',
    '레진 크라운 차이',
    '레진 인레이 차이',
    '이가 깨졌을 때 레진으로 가능한가요',
    '레진 본딩 과정',

    // ===== ★ v7.3+ 인비절라인/투명교정 (20개) =====
    '인비절라인 과정 단계별',
    '인비절라인 기간 얼마나 걸리나요',
    '인비절라인 통증 적응 기간',
    '인비절라인 장단점',
    '인비절라인 vs 메탈교정 차이',
    '인비절라인 vs 세라믹교정 비교',
    '인비절라인 관리 방법',
    '인비절라인 착용 시간',
    '인비절라인 교체 주기',
    '인비절라인 안 끼면 어떻게 되나요',
    '투명교정 효과 한계',
    '투명교정 부작용',
    '투명교정 음식 제한',
    '투명교정 양치 방법',
    '투명교정 vs 부분교정 차이',
    '성인 투명교정 적응증',
    '투명교정 실패 원인',
    '투명교정 유지장치 기간',
    '인비절라인 리파인먼트 과정',
    '인비절라인 어태치먼트 역할',

    // ===== ★ v7.3+ 부분교정 (15개) =====
    '부분교정 가능한 경우',
    '부분교정 기간',
    '부분교정 과정',
    '앞니 부분교정 방법',
    '아랫니 부분교정',
    '부분교정 vs 전체교정 차이',
    '부분교정 통증',
    '부분교정 후 유지장치',
    '부분교정 실패 사례',
    '성인 부분교정 적응증',
    '부분교정 재발 가능성',
    '벌어진 앞니 부분교정',
    '삐뚤어진 앞니 부분교정',
    '부분교정 중 양치 방법',
    '부분교정 음식 주의사항',

    // ===== ★ v7.3+ 전체교정 (15개) =====
    '전체교정 기간 얼마나 걸리나요',
    '전체교정 과정 단계별',
    '전체교정 통증 적응 기간',
    '전체교정 vs 부분교정 어떤 경우에 해야',
    '성인 전체교정 적응증',
    '전체교정 중 발치 필요한 경우',
    '전체교정 유지장치 기간',
    '전체교정 후 재발',
    '전체교정 턱 변화',
    '전체교정 얼굴형 변화',
    '돌출입 교정 방법',
    '주걱턱 교정 가능한가요',
    '덧니 교정 방법',
    '교정 중 치아 흔들림 정상인가요',
    '교정 고무줄 역할',

    // ===== ★ v7.3+ 재신경치료/치근단절제술 (20개) =====
    '재신경치료 과정',
    '재신경치료 왜 해야 하나요',
    '재신경치료 성공률',
    '재신경치료 통증',
    '재신경치료 vs 발치 판단 기준',
    '재신경치료 횟수',
    '재신경치료 후 크라운',
    '신경치료 실패 원인',
    '신경치료 실패 증상',
    '치근단절제술 과정',
    '치근단절제술 회복 기간',
    '치근단절제술 성공률',
    '치근단절제술 후 주의사항',
    '치근단절제술 vs 재신경치료 차이',
    '치근단절제술 적응증',
    '치근단 병소 원인',
    '치근단 농양 증상',
    '치근단 염증 자연치유 되나요',
    '신경치료 후 통증 지속 원인',
    '신경치료 안 하면 어떻게 되나요',

    // ===== ★ v7.3+ 소아치과 (20개) =====
    '소아 충치 치료 시기',
    '아이 충치 치료 과정',
    '유치 충치 치료 꼭 해야 하나요',
    '유치 신경치료 과정',
    '유치 신경치료 안 하면',
    '아이 치과 공포증 극복법',
    '소아 수면치료 안전한가요',
    '실란트 꼭 해야 하나요',
    '실란트 시기 적정 나이',
    '불소 도포 효과',
    '불소 도포 몇 살부터',
    '아이 칫솔질 방법 연령별',
    '아이 치아 부딪혔을 때 대처',
    '유치 흔들릴 때 억지로 빼도 되나요',
    '영구치 나오는 순서',
    '영구치 삐뚤게 나올 때',
    '아이 교정 시작 시기',
    '소아 교정 몇 살부터',
    '아이 이갈이 원인과 대처',
    '아이 구내염 치료',

    // ===== ★ v7.3+ 구강외과/외상 (15개) =====
    '치아 부러졌을 때 응급처치',
    '치아 빠졌을 때 응급처치',
    '치아 금 갔을 때 증상',
    '치아 금 자연치유 되나요',
    '치아 파절 치료 방법',
    '치아 탈구 응급처치',
    '낭종 제거 수술 과정',
    '치성 낭종 원인',
    '구강 점막 질환 종류',
    '구강암 초기 증상',
    '구강 건조증 원인과 대처',
    '혀 통증 원인',
    '혀 궤양 자연치유',
    '입천장 부음 원인',
    '턱뼈 골절 치료',

    // ===== ★ v7.3+ 마취/수면치료 (15개) =====
    '치과 마취 종류',
    '치과 마취 안 되는 이유',
    '치과 마취 풀리는 시간',
    '치과 부분마취 vs 수면마취',
    '수면마취 과정 상세',
    '수면마취 위험성',
    '수면마취 후 주의사항',
    '수면치료 적응증',
    '치과 공포증 수면치료',
    '웃음가스 치과 효과',
    '웃음가스 부작용',
    '진정치료 vs 수면치료 차이',
    '소아 수면마취 안전성',
    '마취 알레르기 증상',
    '치과 마취 후 저림 지속',

    // ===== ★ v7.3+ 치아미용/심미 (15개) =====
    '치아 성형 종류',
    '치아 다이아몬드 시술',
    '잇몸 성형 과정',
    '잇몸 라인 교정',
    '거미줄 치아 원인',
    '치아 착색 원인',
    '치아 착색 제거 방법',
    '치아 사이 벌어짐 치료',
    '앞니 깨짐 심미 수복',
    '치아 모양 이상 치료',
    '테트라사이클린 변색 치료',
    '앞니 벌어짐 교정 vs 라미네이트',
    '잇몸 색 검은 이유',
    '잇몸 미백 가능한가요',
    '스마일라인 교정',

    // ===== ★ v7.3+ 보존치료 (15개) =====
    '이차충치 원인',
    '이차충치 증상',
    '이차충치 예방법',
    '치아 균열 증후군 증상',
    '치아 균열 치료 방법',
    '치아 마모 원인',
    '치아 침식 산성음식',
    '쐐기모양 결손 원인',
    '치경부 마모 치료',
    '치아 재석회화 가능한가요',
    '충치 자연치유 가능한가요',
    '초기 충치 관리법',
    '치아 속 검은 점 충치인가요',
    '충치 단계별 치료 방법',
    '이 사이 충치 발견 시점',

    // ===== ★ v7.3+ 치주/잇몸 심화 (15개) =====
    '치주낭 깊이 의미',
    '치주 수술 과정',
    '치주 수술 후 회복',
    '잇몸 이식 수술',
    '잇몸 뼈 재생 가능한가요',
    '치조골 소실 원인',
    '잇몸 퇴축 원인',
    '잇몸 퇴축 치료 방법',
    '치주 스플린트란',
    '만성 치주염 관리법',
    '치주염 vs 치은염 차이',
    '잇몸에서 고름 나올 때',
    '잇몸 부음 원인',
    '잇몸 검은색 변색 원인',
    '스케일링 후 이가 시린 이유',

    // ===== ★ v7.3+ 보철 심화 (15개) =====
    '지르코니아 크라운 장단점',
    'PFM 크라운 vs 지르코니아',
    '금 크라운 vs 지르코니아',
    '크라운 수명 얼마나',
    '크라운 탈락 응급처치',
    '크라운 아래 충치',
    '임시 크라운 주의사항',
    '크라운 씌운 후 통증 원인',
    '올세라믹 크라운 특징',
    '브릿지 수명 관리법',
    '브릿지 아래 충치 관리',
    '보철 종류 비교 총정리',
    '오래된 보철 교체 시기',
    '보철 탈락 대처법',
    '임시치아 관리 주의사항',

    // ===== ★ v7.3+ 구취/구강건조 (10개) =====
    '입냄새 원인 총정리',
    '입냄새 자가진단 방법',
    '입냄새 치과 치료 방법',
    '혀 세정 올바른 방법',
    '구강건조증 원인',
    '구강건조증 치과 치료',
    '구강건조증 침 분비 늘리는 법',
    '입냄새 위장 관련',
    '입냄새 편도결석 관계',
    '만성 입냄새 개선법',

    // ===== ★ v7.4 크랙(치아균열) 심화 (15개) =====
    '치아 크랙 증상',
    '치아 크랙 치료 방법',
    '치아 크랙 자연치유 가능한가요',
    '치아에 금 갔을 때 증상',
    '치아 균열 방치하면',
    '치아 금 치료 크라운 꼭 해야 하나요',
    '이가 갈라졌을 때 대처법',
    '크랙 있는 치아 발치해야 하나요',
    '치아 크랙 진단 방법',
    '치아 크랙 vs 충치 구별법',
    '어금니 금 갔을 때 치료',
    '앞니 금 갔을 때 치료',
    '치아 균열 증후군 원인',
    '이 씹을 때 찌릿한 통증 원인',
    '치아 크랙 예방법',

    // ===== ★ v7.4 오버레이 (10개) =====
    '오버레이 치료란',
    '오버레이 vs 크라운 차이',
    '오버레이 vs 인레이 차이',
    '오버레이 적응증',
    '오버레이 수명',
    '오버레이 치료 과정',
    '오버레이 탈락 대처법',
    '오버레이 후 통증 원인',
    '세라믹 오버레이 장단점',
    '지르코니아 오버레이 특징',

    // ===== ★ v7.4 포스트 코어 (10개) =====
    '포스트 코어란',
    '포스트 코어 치료 과정',
    '포스트 코어 후 크라운',
    '포스트 코어 vs 코어 빌드업 차이',
    '신경치료 후 포스트 필요한 경우',
    '포스트 코어 수명',
    '포스트 코어 후 치아 파절 가능성',
    '화이버 포스트 vs 금속 포스트 비교',
    '포스트 코어 통증 원인',
    '포스트 코어 탈락 대처법',

    // ===== ★ v7.4 근관치료 심화 (발수/치수/워싱턴) (10개) =====
    '치수염 증상과 치료',
    '치수 괴사 원인',
    '치수 충혈 자연치유 되나요',
    '발수 치료란 무엇인가요',
    '가역적 치수염 vs 비가역적 치수염',
    '신경치료 중 통증 정상인가요',
    '근관치료 실패 후 재치료',
    '열린 근관 vs 닫힌 근관 치료',
    '치아 뿌리 끝 염증 원인',
    '근관치료 횟수 왜 여러 번 해야 하나요',

    // ===== ★ v7.4 자가치아이식/재식 (8개) =====
    '자가치아이식이란',
    '자가치아이식 성공률',
    '자가치아이식 vs 임플란트 비교',
    '자가치아이식 적응증',
    '치아 재식 과정',
    '빠진 치아 다시 심기 가능한가요',
    '자가치아이식 회복 기간',
    '자가치아이식 후 주의사항',

    // ===== ★ v7.4 나이트가드/교합 (8개) =====
    '나이트가드 효과',
    '나이트가드 종류',
    '나이트가드 맞춤 제작 과정',
    '나이트가드 관리법',
    '교합 안정 장치란',
    '교합 조정 치료',
    '이 악물기 습관 치료',
    '턱관절 스플린트 치료 기간',

    // ===== ★ v7.4 GBR/골이식 심화 (8개) =====
    '뼈이식 왜 해야 하나요',
    '뼈이식 수술 과정',
    '뼈이식 후 회복 기간',
    '뼈이식 실패 원인',
    'GBR 수술이란',
    '골유도재생술 과정',
    '뼈이식재 종류',
    '상악동 거상술 회복 기간',

    // ===== ★ v7.4 치관연장술/잇몸라인 (6개) =====
    '치관연장술이란',
    '치관연장술 과정',
    '치관연장술 회복 기간',
    '크라운 연장술 적응증',
    '잇몸 절제술 과정',
    '잇몸 아래 충치 치관연장술',

    // ===== ★ v7.4 임시치아/프로비져널 (6개) =====
    '임시치아 빠졌을 때 대처',
    '임시치아 기간 얼마나',
    '임시치아로 음식 먹어도 되나요',
    '프로비져널 크라운이란',
    '임시치아 통증 원인',
    '임시치아 관리 꿀팁',
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
    targetDays,
    forceCuratedAll: forceRun  // force일 때 큐레이션 키워드 전부 투입
  })
  
  return c.json(result)
})

// ★ v7.3: POST /api/keyword-discovery/reclassify — 기존 키워드 재분류
// 프로덕션에서 잘못 분류된 키워드를 일괄 재분류 (D1 batch로 타임아웃 방지)
keywordDiscoveryRoutes.post('/reclassify', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dryRun = (body as any).dry_run !== false // 기본 dry_run=true

  // 전체 키워드 조회
  const allKeywords = await c.env.DB.prepare(
    "SELECT id, keyword, category, subcategory FROM keywords"
  ).all()

  const changes: any[] = []
  let unchanged = 0

  for (const kw of (allKeywords.results || [])) {
    const newClassification = classifyKeyword(kw.keyword as string)
    if (newClassification.category !== kw.category || newClassification.subcategory !== kw.subcategory) {
      changes.push({
        id: kw.id,
        keyword: kw.keyword,
        old: { category: kw.category, subcategory: kw.subcategory },
        new: { category: newClassification.category, subcategory: newClassification.subcategory, priority: newClassification.priority }
      })
    } else {
      unchanged++
    }
  }

  // 실제 적용: D1 batch로 한 번에 처리 (Workers 타임아웃 방지)
  if (!dryRun && changes.length > 0) {
    const batchStatements = changes.map(ch =>
      c.env.DB.prepare(
        "UPDATE keywords SET category = ?, subcategory = ?, priority = ? WHERE id = ?"
      ).bind(ch.new.category, ch.new.subcategory, ch.new.priority, ch.id)
    )
    // D1 batch: 최대 100개씩 나눠서 실행
    for (let i = 0; i < batchStatements.length; i += 100) {
      const batch = batchStatements.slice(i, i + 100)
      await c.env.DB.batch(batch)
    }
  }

  return c.json({
    dry_run: dryRun,
    total_keywords: (allKeywords.results || []).length,
    reclassified: changes.length,
    unchanged,
    changes: changes.slice(0, 50), // 최대 50개만 표시
    message: dryRun 
      ? `${changes.length}개 키워드 재분류 필요 (dry_run=true, 실제 적용은 dry_run:false로 호출)`
      : `${changes.length}개 키워드 재분류 완료`
  })
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
  forceCuratedAll?: boolean  // true이면 큐레이션 키워드 전부 투입 (개수 제한 없이)
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

  // Phase 1: 큐레이션 키워드 투입 (D1 batch로 최적화)
  const curated = getCuratedKeywords()
  const forceCuratedAll = options?.forceCuratedAll || false
  
  // 기존 키워드를 한 번에 조회하여 중복 체크 최적화
  const existingRows = await db.prepare('SELECT keyword FROM keywords').all()
  const existingSet = new Set((existingRows.results || []).map((r: any) => r.keyword))
  
  // 미존재 큐레이션 키워드만 필터
  const newCurated = curated.filter(kw => !existingSet.has(kw))
  const limit = forceCuratedAll ? newCurated.length : Math.max(0, (targetDays * postsPerDay) - unusedCount)
  const toInsert = newCurated.slice(0, limit)
  
  // D1 batch로 한 번에 INSERT
  if (toInsert.length > 0) {
    const batchStmts = toInsert.map(kw => {
      const classification = classifyKeyword(kw)
      return db.prepare(
        `INSERT OR IGNORE INTO keywords (keyword, category, subcategory, search_intent, priority, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).bind(kw, classification.category, classification.subcategory, classification.search_intent, classification.priority)
    })
    // D1 batch는 한 번에 최대 100개 → 100개씩 나눠서 실행
    for (let i = 0; i < batchStmts.length; i += 100) {
      const chunk = batchStmts.slice(i, i + 100)
      await db.batch(chunk)
    }
    totalSaved = toInsert.length
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
