import { Hono } from 'hono'
import type { Bindings } from '../index'

const contentRoutes = new Hono<{ Bindings: Bindings }>()

// ===== 콘텐츠 유형 자동 분류 (환자 중심 v2) =====
type ContentType = 'B' | 'C' | 'D' | 'E' | 'F'

function classifyContentType(keyword: string, searchIntent: string): { type: ContentType; label: string; question: string; emotion: string } {
  const kw = keyword.toLowerCase()

  // 유형 E — 불안/공포 해소 (최우선 판별 — 환자가 무서워서 검색하는 키워드)
  if (/무서|아프|두려|겁|고통|트라우마|공포|패닉|불안|걱정|떨|긴장|마취.*안|잠.*안|실패.*확률|위험|후유증|신경.*손상|마비|감염|거부반응|부작용/.test(kw)) {
    return { type: 'E', label: '불안/공포 해소', question: `${keyword}이(가) 무섭고 두렵다. 괜찮을까?`, emotion: '공포·불안' }
  }

  // 유형 C — 회복/주의사항 (환자가 치료 후 불안해서 검색)
  if (/후|주의사항|회복|관리|음식|운동|붓기|통증|출혈|시림|부작용|증상|합병증|실패|재수술|수명|유지/.test(kw)) {
    return { type: 'C', label: '회복/주의사항', question: `${keyword} 지금 이 상태가 정상인지, 어떻게 해야 하는지 불안하다`, emotion: '걱정·초조' }
  }

  // 유형 D — 비교/선택 (환자가 결정 못 해서 답답한 상태)
  if (searchIntent === 'comparison' || /vs|비교|차이|종류별|추천|선택|어떤|좋은/.test(kw)) {
    return { type: 'D', label: '비교/선택', question: `${keyword} — 뭘 골라야 하는지 모르겠고, 잘못 선택할까 봐 걱정된다`, emotion: '혼란·우유부단' }
  }

  // 유형 F — 적응증/필요성 (이 치료가 나에게 필요한지 판단하고 싶은 상태)
  if (/필요|해야|안하면|적응증|대상|누가|언제|어떤.*경우|꼭|반드시|시기|나이|조건/.test(kw)) {
    return { type: 'F', label: '적응증/필요성', question: `${keyword} — 나한테 정말 필요한 치료인지 판단하고 싶다`, emotion: '의구심·판단 불안' }
  }

  // 유형 B — 시술 과정/방법 (기본 — 모르는 것에 대한 막연한 두려움)
  return { type: 'B', label: '시술 과정/방법', question: `${keyword}이(가) 어떻게 진행되는지 몰라서 막연히 무섭다`, emotion: '막연한 두려움' }
}

// ===== 유형별 구조 가이드 (환자 공감 v2) =====
function getTypeGuide(type: ContentType): string {
  const guides: Record<ContentType, string> = {
    'B': `## 유형 B — 시술 과정/방법 구조 (환자 공감형)
1. 첫 단락: "처음 받는 치료라 어떻게 진행되는지 모르면 더 무섭게 느껴집니다"로 감정 인정 → 이 글이 그 막연함을 없애줄 것이라 약속
2. H2: "이 치료는 왜 하는 건가요?" (내가 왜 이걸 받아야 하는지 납득)
3. H2: 단계별 과정을 환자 시점으로 서술 ("마취 후 아무 감각도 없는 상태에서...", "여러분이 느끼는 것은...")
4. H2: "많이 아프진 않나요?" — 통증과 불편함에 대한 솔직한 안내 (과장도, 축소도 없이)
5. H2: 치료 시간, 내원 횟수, 일상생활 복귀까지의 현실적 타임라인
6. H2: 치료 후 주의사항과 회복 과정
7. FAQ 5~7개 (환자가 실제로 치과 앞에서 검색할 법한 질문들)
핵심: "어떤 느낌인지, 얼마나 걸리는지, 아프진 않은지" — 환자가 가장 궁금한 3가지를 중심으로.`,

    'C': `## 유형 C — 회복/주의사항 구조 (환자 공감형)
1. 첫 단락: "치료 후 뭔가 이상한 느낌이 들면, 검색부터 하게 됩니다. 그 마음 충분히 이해합니다"로 시작 → 핵심 주의사항 요약
2. H2: "이 증상, 정상입니다" — 치료 후 흔히 나타나는 증상 (붓기, 통증, 출혈 등)과 "걱정 안 해도 되는 기준"
3. H2: "이 증상이 나타나면, 병원에 연락하세요" — 구체적 기준(38도 이상 열, 72시간 이상 출혈 등)을 명확히
4. H2: 회복 타임라인을 하루 단위로 (1일차 → 3일차 → 1주차 → 2주차 → 1개월)
5. H2: 해야 하는 것 vs 절대 하면 안 되는 것 (체크리스트 형태)
6. H2: "회복을 빠르게 하는 생활 습관" — 음식, 수면, 운동 구체적 가이드
7. FAQ 5~7개
핵심: "지금 내 상태가 정상인지 비정상인지"를 판단할 수 있는 구체적 기준을 준다. 막연한 "이상하면 내원하세요"는 금지.`,

    'D': `## 유형 D — 비교/선택 구조 (환자 공감형)
1. 첫 단락: "선택지가 많으면 오히려 더 혼란스러운 법입니다"로 공감 → 이 글 하나로 결정할 수 있게 정리해주겠다고 약속
2. H2: 핵심 차이를 한눈에 비교하는 표(Table) — 항목: 방법, 기간, 통증, 내구성, 적합 대상
3. H2: "이런 사람에게는 A가 맞습니다" / "이런 사람에게는 B가 맞습니다" (조건부 추천)
4. H2: 각 선택지의 단점도 솔직하게 (장점만 나열하지 않음)
5. H2: 5~10년 후까지 고려했을 때 — 장기적 관점
6. H2: "결정하기 전에 치과에서 꼭 확인할 질문 3가지" (환자가 주도적으로 질문하도록)
7. FAQ 5~7개
핵심: "어떤 게 더 좋다"가 아니라 "어떤 상황에서는 A, 어떤 상황에서는 B"로 조건부 답변. 환자가 스스로 결정할 수 있는 판단 기준을 준다.`,

    'E': `## 유형 E — 불안/공포 해소 구조 (핵심 유형)
1. 첫 단락: 환자의 감정을 있는 그대로 인정 ("무섭다는 감정은 자연스럽습니다. 처음이면 더더욱요") → 이 글을 다 읽고 나면 막연한 공포가 구체적인 이해로 바뀔 것이라 약속
2. H2: "왜 이 치료가 무섭게 느껴지는 걸까?" — 두려움의 원인을 분석 (모름, 통증 걱정, 실패 걱정, 과거 경험 등)
3. H2: "실제로는 이렇습니다" — 오해와 사실을 하나씩 짚어서 교정 (숫자와 근거 기반)
4. H2: "통증 관리는 이렇게 합니다" — 마취 방법, 진정 치료 옵션, 실제 환자 느낌 설명
5. H2: "만약 이런 일이 생기면 어떻게 하나요?" — 최악의 시나리오도 솔직하게 다루되, 대처법과 확률을 함께 제시
6. H2: "치료를 미루면 오히려 이런 일이 생깁니다" — 방치의 결과를 현실적으로 (겁주기가 아니라 정보 제공)
7. H2: "치과 공포가 심한 분을 위한 실질적 팁" — 진정 치료, 의료진에게 말하는 법, 호흡법 등
8. FAQ 5~7개
핵심: 두려움을 부정하지 않고, 구체적 정보로 "모르는 것의 공포"를 "아는 것의 안심"으로 바꾼다.`,

    'F': `## 유형 F — 적응증/필요성 구조 (환자 공감형)
1. 첫 단락: "이 치료가 정말 나에게 필요한 건지, 의심이 드는 건 자연스럽습니다"로 공감 → 핵심 적응증 요약
2. H2: "이런 증상이 있다면, 이 치료가 필요합니다" — 구체적 적응증 리스트 (체크리스트 형태)
3. H2: "반대로, 이런 경우는 이 치료가 아닙니다" — 비적응증도 명확히 (환자가 불필요한 치료를 피하도록)
4. H2: "치료를 미루면 어떤 일이 생기나요?" — 방치 시 진행 과정을 단계별로 (겁주기가 아니라 현실적 정보)
5. H2: "치과에서 어떤 검사를 받게 되나요?" — 진단 과정 설명 (X-ray, CT, 치주 검사 등)
6. H2: "치료 시기는 언제가 좋은가요?" — 최적 시기와 연령별 고려사항
7. FAQ 5~7개
핵심: 환자가 "내가 이 치료의 대상인지 아닌지"를 스스로 판단할 수 있는 기준을 준다. 불필요한 치료 유도는 절대 금지.`
  }
  return guides[type]
}

// ===== 글 구조 다양화 시스템 (6가지 구조 로테이션 — Google Scaled Content Abuse 방지) =====
const ARTICLE_STRUCTURES = [
  { id: 'checklist', label: '체크리스트형', guide: `## 글 구조: 체크리스트형
- 도입부에서 "~하기 전에 반드시 확인해야 할 것들"로 시작
- 본문을 번호 매긴 체크리스트 항목으로 구성 (H2마다 하나의 체크포인트)
- 각 항목을 ✅/❌ 또는 "확인하셨나요?" 형태로 마무리
- 글 마지막에 전체 체크리스트를 한눈에 보는 요약 박스 제공
- H2 예시: "1. 혈압약 복용 중이라면 반드시 미리 말씀하세요", "2. 수술 당일 식사는 이렇게 하세요"` },
  { id: 'timeline', label: '타임라인형', guide: `## 글 구조: 타임라인형
- 시간 흐름을 따라 서술 (치료 전 → 당일 → 직후 → 1주 → 1개월 → 6개월)
- 각 H2가 하나의 시간 구간을 담당
- "이 시점에서 여러분이 느끼실 수 있는 것은..." 으로 각 구간 시작
- 시간 흐름에 따른 변화를 구체적으로 (통증 수준, 할 수 있는 활동, 주의사항)
- H2 예시: "수술 전날 밤 — 준비할 것과 마음가짐", "수술 직후 1~3시간 — 마취가 풀리면서 느끼는 것들"` },
  { id: 'myth_fact', label: '오해 해소형', guide: `## 글 구조: 오해 해소형 ("사실은 이렇습니다")
- 도입부에서 "인터넷에 떠도는 정보 중 잘못된 것이 많습니다"로 시작
- 각 H2를 "❌ 오해: ~" vs "✅ 사실: ~" 구조로 작성
- 환자들이 실제로 잘못 알고 있는 것을 하나씩 교정
- 근거와 수치를 들어 왜 오해인지 설명
- H2 예시: "'임플란트는 엄청 아프다' — 사실은 발치보다 덜 아픈 경우가 많습니다", "'뼈가 약하면 못한다' — 뼈이식으로 가능한 경우가 대부분입니다"` },
  { id: 'scenario', label: '시나리오형', guide: `## 글 구조: 시나리오형 (환자 케이스 기반)
- 도입부에서 가상의 환자 상황을 제시 ("50대 직장인 A씨는 어느 날...")
- 그 환자의 여정을 따라가며 정보를 자연스럽게 전달
- 각 H2는 환자 여정의 단계 (발견 → 고민 → 결심 → 치료 → 회복)
- 중간중간 "A씨처럼 이런 상황이라면..." 으로 독자에게 연결
- 진료실에서 실제로 있을 법한 상황 묘사를 생생하게
- H2 예시: "양치할 때 피가 나기 시작한 건 6개월 전이었습니다", "검사 결과를 듣고 A씨가 가장 먼저 물어본 것"` },
  { id: 'deep_dive', label: '심층 분석형', guide: `## 글 구조: 심층 분석형 (한 가지를 깊이 파고드는 전문가 글)
- 도입부에서 핵심 결론을 먼저 제시하고, "그 이유를 하나씩 설명드리겠습니다"로 이어감
- 의학적 원리를 환자가 이해할 수 있는 수준으로 깊이 있게 설명
- 각 H2는 "왜?", "어떻게?", "만약~라면?" 같은 인과 질문
- 다른 글에서 다루지 않는 디테일을 포함 (조직 재생 원리, 골밀도 영향 등)
- H2 예시: "임플란트가 자연치아와 다른 근본적인 이유", "왜 3개월을 기다려야 하는지 — 뼈와 티타늄의 결합 과정"` },
  { id: 'decision', label: '의사결정형', guide: `## 글 구조: 의사결정형 ("이 글 하나로 결정하세요")
- 도입부에서 "결정이 어려운 건 기준이 없기 때문입니다"로 시작
- 명확한 판단 기준과 조건을 제시 (if-then 구조)
- 비교표, 장단점 매트릭스, 의사결정 트리를 적극 활용
- 각 H2가 하나의 판단 기준을 다룸
- 마지막에 "치과에서 이 3가지만 확인하세요" 같은 액션 아이템
- H2 예시: "이런 경우라면 바로 진행하는 게 좋습니다", "이 조건에 해당하면 조금 더 기다려도 됩니다"` }
]

function getArticleStructure(contentId?: number): typeof ARTICLE_STRUCTURES[0] {
  // contentId 기반 또는 랜덤으로 구조 선택 (동일 구조 연속 방지)
  const idx = contentId ? contentId % ARTICLE_STRUCTURES.length : Math.floor(Math.random() * ARTICLE_STRUCTURES.length)
  return ARTICLE_STRUCTURES[idx]
}

// ===== Experience 마커 풀 (임상 경험 기반 문장 — E-E-A-T 강화) =====
const EXPERIENCE_MARKERS = [
  '진료실에서 환자분들이 가장 많이 하시는 질문이 바로 이겁니다.',
  '수천 케이스를 진행하면서 느낀 것은, 대부분의 걱정이 "모름"에서 온다는 점입니다.',
  '실제 진료 현장에서 보면, 이 부분을 미리 아시는 분과 모르시는 분의 불안감 차이가 큽니다.',
  '처음 오시는 분들이 공통적으로 하시는 질문이 있습니다.',
  '환자분들 중 회복이 빠른 분들의 공통점을 보면, 이 부분을 잘 지키십니다.',
  '상담 시 이 부분을 설명드리면, 대부분 "그렇게 간단한 거였어요?"라고 하십니다.',
  '수술 직후 가장 많이 들리는 말은 "생각보다 괜찮았다"입니다.',
  '오랜 기간 환자분들을 만나면서, 초기 상담에서 이 이야기를 반드시 드립니다.',
  '진료 경험상, 이 증상 때문에 새벽에 응급 전화를 주시는 분들이 계십니다. 미리 알려드리면 불필요한 걱정을 줄일 수 있습니다.',
  '처음 내원하신 날과 치료가 끝난 날, 같은 분이라고 믿기 어려울 만큼 표정이 달라지시는 경우를 많이 봅니다.',
  '이런 질문을 하시는 분들의 90%는 막상 치료를 받고 나서 "왜 더 일찍 안 했을까"라고 하십니다.',
  '진료실에서 실제로 환자분께 보여드리는 자료를 바탕으로 설명드리겠습니다.',
]

function getExperienceMarkers(keyword: string, count: number = 3): string[] {
  // 키워드 해시 기반으로 다양한 조합 선택
  const hash = keyword.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const shuffled = [...EXPERIENCE_MARKERS].sort((a, b) => {
    const ha = (hash + a.charCodeAt(0)) % 100
    const hb = (hash + b.charCodeAt(0)) % 100
    return ha - hb
  })
  return shuffled.slice(0, count)
}

// ===== Claude 시스템 프롬프트 (v3 — 구조 다양화 + Experience + 지역 차별화) =====
function buildSystemPrompt(keyword: string, contentType: ContentType, typeGuide: string, patientQuestion: string, disclaimer: string, emotion?: string, structureOverride?: string): string {
  // 구조 다양화: 키워드 해시 기반으로 6가지 구조 중 하나 선택
  const kwHash = keyword.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const structure = ARTICLE_STRUCTURES[kwHash % ARTICLE_STRUCTURES.length]
  const experienceMarkers = getExperienceMarkers(keyword, 4)

  return `역할: 서울비디치과 의료진으로서, 통합치의학과 전문의의 관점에서 환자의 마음을 먼저 읽는 치과 의료 정보를 전달하는 블로그 글 작성자
목적: 치과 치료를 앞두고 불안하거나, 치료 후 걱정되는 환자의 감정에 공감하고, 정확한 정보로 그 불안을 해소하는 블로그 포스트 작성

## ⚠️ 최우선 원칙: 이 글은 "AI가 대량 생산한 콘텐츠"가 아닌, "전문의가 직접 작성한 글"이어야 합니다
- 교과서를 복사한 듯한 정보 나열 금지
- 모든 섹션에 **임상 경험에서 우러나온 구체적 관찰, 사례, 판단**이 반드시 포함되어야 합니다
- "~입니다", "~합니다"만 반복하는 단조로운 어미 금지 — 문장 구조와 어미를 다양하게 변주하세요
- 동일한 문장 패턴이 3회 이상 연속 반복되면 안 됩니다

## 이 글의 존재 이유
환자가 이 글을 검색하게 된 마음: "${patientQuestion}"
환자의 지금 감정: "${emotion || '불안·걱정'}"

이 사람은 지금 치과 치료 때문에 걱정되고, 모르는 것이 무서워서 밤에 폰으로 이 키워드를 검색하고 있습니다.
이 글은 그 사람의 불안을 줄여주고, "아, 이 정도면 괜찮겠다"는 마음이 들게 해야 합니다.

## 글쓰기 3원칙 (Patient Funnel — 환자 경험 설계)
1. **감정을 먼저 인정한다** — "무섭다", "걱정된다", "모르겠다"는 감정을 부정하지 않고, "당연한 마음입니다"로 시작한다
2. **구체적 정보로 불안을 교체한다** — 막연한 두려움은 모름에서 온다. 수치, 기간, 확률, 단계를 알려주면 두려움이 이해로 바뀐다
3. **환자가 주도권을 갖게 한다** — "이건 치과에서 이렇게 질문하세요", "이 기준으로 판단하세요"처럼 환자가 능동적으로 판단할 수 있는 도구를 준다

${typeGuide}

## 🔀 이번 글의 구조: ${structure.label}
${structureOverride || structure.guide}

**⚠️ 위 구조를 반드시 따르세요. 매번 같은 구조로 쓰면 안 됩니다. 이번에는 "${structure.label}" 방식으로 작성합니다.**

## 🏥 임상 경험 삽입 (Experience — E-E-A-T 핵심, 필수)
이 글에는 반드시 아래와 같은 **실제 임상 경험이 느껴지는 문장**을 3~5개 포함해야 합니다.
글의 자연스러운 맥락 속에 녹여서 삽입하세요 (억지로 끼워넣지 말 것).

활용할 수 있는 경험 기반 표현 예시:
${experienceMarkers.map((m, i) => `${i + 1}. "${m}"`).join('\n')}

추가로 아래 패턴도 자유롭게 활용하세요:
- "진료실에서 자주 보는 패턴은..."
- "이 부분은 환자분들께 늘 강조드리는 내용입니다"
- "실제로 ~한 경우를 종종 봅니다"
- 구체적 수치를 경험과 연결: "제가 본 케이스에서는 보통 ~" (단, 특정 환자 정보 노출 금지)

**이 문장들이 없으면 불합격입니다. 교과서적 정보만 나열한 글은 Google에서 저품질로 분류됩니다.**

## 도입부(첫 단락) — 환자 공감형 구조 (필수)
- 첫 1~2문장: 환자의 감정 인정 ("${keyword}" 때문에 걱정되는 마음, 충분히 이해합니다 / 처음이라 막막한 것도 당연합니다)
- 다음 1문장: 핵심 정보를 바로 제시 (수치, 범위, 결론)
- 마지막 1문장: 이 글을 읽으면 무엇이 해소되는지 약속 ("이 글을 끝까지 읽으시면, ~를 판단할 수 있게 됩니다")
- 절대 쓰지 않는 시작: "안녕하세요", "오늘은 ~에 대해 알아보겠습니다", "많은 분들이"

## 제목(H1) 규칙 — v4 다양한 제목 공식 (SpamBrain 패턴 회피)
- 키워드를 앞쪽 30자 이내에 배치
- ⚠️ **"[키워드], 무서울까?" "아플까?" "괜찮을까?" 공식만 반복하지 마세요**
- ⚠️ **제목에 지역명을 넣지 마세요** — 지역명은 본문에서만 자연스럽게
- 다양한 제목 공식 활용 (아래 중 user 프롬프트에서 지정된 공식을 따르세요):
  - "~할 때 알아야 할 3가지"
  - "~전에 반드시 확인하세요"
  - "~경험자가 말하는 현실적 이야기"
  - "~오해와 진실 — 데이터로 확인하기"
  - "~미루면 생기는 일, 솔직히 말씀드립니다"
  - "~A부터 Z까지 전문의가 정리"
  - "~후 회복 일지: 1일차부터 한 달까지"
  - "~선택 기준: 이것만 알면 됩니다"
  - "~고민이라면 이 글을 먼저 읽으세요"
  - "~검색하다 지친 분을 위한 팩트 정리"
- 40~65자, 숫자 또는 연도 포함 권장
- ⚠️ 맞춤법 필수: "무서울까" (✅) "무섭을까" (❌) — ㅂ불규칙 활용 준수

## H2 작성 원칙 — ⚠️ 최소 6개 필수
- **H2는 반드시 6~8개** 작성 (FAQ H2 포함). 6개 미만 불합격.
- H2는 환자가 머릿속으로 하는 질문 그대로 쓴다
- 각 H2 섹션은 "질문 → 공감 → 구체적 답변 → 판단 기준"의 구조
- 각 H2 섹션: **300~500자** (충분히 깊이 있게 서술)
- ⚠️ **H2 표현이 글마다 반복되면 안 됩니다** — "~에 대해 알아보겠습니다" 같은 천편일률적 H2 금지

## 환자 공감 표현 패턴 (적극 사용)
사용해야 하는 표현:
- "이 상황에서 걱정되는 건 자연스럽습니다"
- "처음 경험하는 분이라면 더 불안할 수 있습니다"
- "실제로 많은 분이 같은 걱정을 합니다. 그래서 정확히 알려드립니다"
- "결론부터 말씀드리면..." (불안한 사람은 빨리 답을 원합니다)
- "~라는 기준으로 판단하시면 됩니다"
- "치과에서 이렇게 질문해보세요: '~'"
- "이 수치를 기억해두세요: ~"

## FAQ 규칙 (필수, 5~7개)
- Q는 환자가 새벽에 폰으로 검색할 법한 표현 그대로 (구어체 OK)
- A는 결론 먼저, 이유는 그다음 (1~3문장)
- "네, 정상입니다" 또는 "아니요, 이 경우는 병원에 가셔야 합니다"로 시작하면 효과적

## 톤 & 보이스 (환자 친화형)
이 글의 화자는 "내 담당 치과 선생님"처럼 느껴져야 합니다.
- 전문적이지만 따뜻하게
- 솔직하지만 안심을 주되
- 정확한 수치로 근거를 제시하되, 공감을 놓치지 않게
- **⚠️ 문장 어미를 다양하게**: "~입니다" "~합니다"만 반복 금지. "~이죠", "~거든요", "~인 셈입니다", "~편입니다", "~수 있습니다" 등 자연스럽게 섞기

## 한국어 맞춤법·문법 (매우 중요)
- 모든 문장은 한국어 맞춤법과 문법을 100% 준수
- ⚠️ ㅂ불규칙: "무서울까" (✅) / "무섭을까" (❌), "아플까" (✅), "어려울까" (✅)
- "되다/돼다" 구분, "안 되다/안 돼요" 준수
- 의학 용어는 대한치과의사협회 표준 용어 사용

써야 하는 것:
- 수치와 기간 ("보통 2~4주", "환자의 95% 이상은")
- 구체적 기준 ("체온 38도 이상이 2일 지속되면")
- 환자 시점 서술 ("여러분이 느끼실 수 있는 것은...")
- 감정 인정 표현 ("두렵다면 당연합니다", "모르면 더 무섭습니다")
- 행동 가이드 ("이 기준으로 판단하세요")

절대 쓰지 않는 것:
- 병원 이름, 원장 이름, 홍보성 문구 일체
- "저희 병원에서는...", "본원에서는..."
- "최선을 다하겠습니다", "빠른 쾌유를 빕니다" (정보 없음)
- "경우에 따라 다릅니다"로 끝내기 (어떤 경우에 어떻게 다른지까지 써야 함)
- "안심하세요" (근거 없는 안심은 오히려 불신)
- 치료 결과 보장 ("100% 성공", "완벽하게 회복")
- 타 병원 비교/비방, 광고성 유도

## 키워드 밀도 원칙
주요 키워드 "${keyword}": 본문 전체에서 3~5회 자연 삽입
- 같은 키워드가 한 단락에 2회 이상 반복 금지
- 관련 시맨틱 키워드 3개 이상 자연 삽입

## 마무리 — 환자 임파워먼트
- 핵심 요약 1~2문장 + 치과에서 할 수 있는 질문 1~2개 제안
- 병원 예약 유도 절대 금지

## 의료광고법 준수 (YMYL)
- 필수 면책 문구를 반드시 글 마지막에 삽입
- 효과 보장 금지, 비교 광고 금지, 비용 단정 금지, 브랜드 추천 금지

## ⛔ 절대 금지 — 비용·가격·보험 정보 (이 규칙을 어기면 글 전체가 무효)
금지 단어: 만원, 만 원, 가격, 비용, 보험 적용, 보험, 실비, 실손, 급여, 비급여, 건강보험, 할부, 할인, 이벤트, 무료 상담, 무료 검진, 수가, 본인부담, 본인 부담, 국민건강, 산정특례, 의료비, 치료비

## 출력 형식 (반드시 유효한 JSON만 출력, 다른 텍스트 금지)
{
  "title": "환자 감정이 느껴지는 SEO 최적화 제목 (40~65자, 키워드 앞 30자, 숫자/연도 포함)",
  "slug": "영문-소문자-하이픈-3-5단어",
  "meta_description": "120~160자 메타 설명 (키워드 포함, 환자가 '이거다!' 하고 클릭할 만한 설명)",
  "content_html": "완전한 HTML 본문 (${structure.label} 구조)",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5"],
  "faq": [{"q":"환자가 실제 검색할 구어체 질문","a":"결론 먼저 + 이유 1~3문장"}],
  "word_count": 숫자,
  "content_type": "${contentType}",
  "article_structure": "${structure.id}"
}

## content_html 필수 구조 — ⚠️ 3,000자 이상 필수
**글 전체 분량은 반드시 3,000~4,500자(공백 포함) 이상이어야 합니다.**

1. 도입부 <p>: 감정 인정 → 핵심 정보 제시 → 이 글의 약속 (200~300자)
2. **<h2> 6~8개 필수**: ${structure.label} 구조에 맞게 작성
3. 각 H2 섹션 내: 공감 + 구체적 답변 + 수치/기준 + **임상 경험 1문장 이상** (각 300~500자)
4. <h3> 세부 소제목 적극 활용
5. <ul>/<ol> 체크리스트, 단계별 리스트 적극 활용
6. 비교 시 <table>
7. **[이미지 위치 마커]**: 본문 중 핵심 H2 섹션 2~3곳에 \`<!-- IMAGE_SLOT:설명 -->\` 마커 삽입
8. FAQ: <h2>자주 묻는 질문</h2> 아래 <details><summary>Q</summary><p>A</p></details> 5~7개
9. 마무리 <p>: 핵심 요약 + 환자 임파워먼트
10. 맨 하단 면책 문구: <div style="background:#f0f7ff;padding:16px;border-radius:8px;margin-top:32px;font-size:13px;color:#555;border-left:3px solid #3b82f6"><strong>📋 의료 정보 안내</strong><br>${disclaimer}</div>

## 주의사항: content_html에 JSON-LD 스키마나 <script> 태그를 절대 포함하지 마세요. 순수 HTML 본문만 출력합니다.`
}

// GET /api/contents - 콘텐츠 목록 조회
contentRoutes.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')
  const status = c.req.query('status') || ''

  let query = 'SELECT * FROM contents WHERE 1=1'
  const params: any[] = []

  if (status) {
    query += ' AND status = ?'
    params.push(status)
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const result = await c.env.DB.prepare(query).bind(...params).all()
  return c.json({ contents: result.results })
})

// GET /api/contents/:id - 콘텐츠 상세 조회
contentRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const result = await c.env.DB.prepare('SELECT * FROM contents WHERE id = ?').bind(id).first()
  if (!result) return c.json({ error: '콘텐츠를 찾을 수 없습니다' }, 404)
  return c.json({ content: result })
})

// POST /api/contents/generate - AI 콘텐츠 생성
contentRoutes.post('/generate', async (c) => {
  const body = await c.req.json()
  const { keyword_id, keyword_text, search_intent } = body

  // Get settings
  const claudeKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'claude_api_key'").first()
  const disclaimerRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'medical_disclaimer'").first()
  const regionRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'clinic_region'").first()
  const minScoreRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'seo_min_score'").first()

  const claudeApiKey = claudeKeyRow?.value as string || c.env.CLAUDE_API_KEY || ''
  const disclaimer = disclaimerRow?.value as string || '본 글은 일반적인 의료 정보를 제공하기 위한 목적으로 작성되었습니다. 개인의 구강 상태에 따라 진단과 치료 방법이 달라질 수 있으므로, 정확한 진단과 치료 계획은 반드시 치과의사와 상담하시기 바랍니다.'
  const regionSetting = regionRow?.value as string || ''
  const minScore = parseInt(minScoreRow?.value as string || '80')

  // 충청권 도시 로테이션
  let region = regionSetting
  if (!region) {
    const CITIES = ['대전','세종','청주','천안','아산','서산','당진','논산','공주','보령','제천','충주','홍성','예산','음성','진천','괴산','옥천','영동','금산']
    const rotRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'region_rotation_index'").first()
    let idx = parseInt(rotRow?.value as string || '0')
    if (isNaN(idx) || idx >= CITIES.length) idx = 0
    region = CITIES[idx]
    const nextIdx = (idx + 1) % CITIES.length
    if (rotRow) {
      await c.env.DB.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'region_rotation_index'").bind(String(nextIdx)).run()
    } else {
      await c.env.DB.prepare("INSERT INTO settings (key, value, description) VALUES ('region_rotation_index', ?, '충청권 도시 로테이션 인덱스')").bind(String(nextIdx)).run()
    }
  }

  if (!claudeApiKey) {
    return c.json({ error: 'Claude API 키가 설정되지 않았습니다. 설정 페이지에서 입력해주세요.' }, 400)
  }

  // 콘텐츠 유형 자동 분류
  const classified = classifyContentType(keyword_text, search_intent || 'info')
  const typeGuide = getTypeGuide(classified.type)

  let bestContent: any = null
  let attempts = 0
  const maxAttempts = 3

  while (attempts < maxAttempts) {
    attempts++
    try {
      const generated = await generateWithClaude(claudeApiKey, keyword_text, region, disclaimer, classified.type, typeGuide, classified.question, classified.emotion)
      const seoScore = calculateSeoScore(generated, keyword_text)

      if (!bestContent || seoScore > (bestContent.seo_score || 0)) {
        bestContent = { ...generated, seo_score: seoScore, attempts }
      }

      if (seoScore >= minScore) break
    } catch (e: any) {
      if (attempts >= maxAttempts) {
        return c.json({ error: 'AI 생성 실패: ' + e.message }, 500)
      }
    }
  }

  if (!bestContent) {
    return c.json({ error: 'AI 콘텐츠 생성에 실패했습니다' }, 500)
  }

  // Generate thumbnail
  let thumbnailUrl = ''
  let thumbnailPrompt = ''
  try {
    const thumbResult = await generateThumbnail(keyword_text, bestContent.title, c.env)
    thumbnailUrl = thumbResult.url
    thumbnailPrompt = thumbResult.prompt
  } catch (e) {
    console.error('Thumbnail generation failed:', e)
  }

  // 콘텐츠 HTML에 썸네일 삽입
  let finalHtml = bestContent.content_html
  if (thumbnailUrl) {
    finalHtml = `<figure style="margin:0 0 24px 0"><img src="${thumbnailUrl}" alt="${keyword_text}" style="width:100%;border-radius:8px;max-height:400px;object-fit:cover" loading="lazy"><figcaption style="text-align:center;font-size:13px;color:#888;margin-top:8px">${keyword_text} 관련 이미지</figcaption></figure>` + finalHtml
  }

  // Save to DB
  const result = await c.env.DB.prepare(
    `INSERT INTO contents (keyword_id, keyword_text, title, slug, meta_description, content_html, tags, faq_json, thumbnail_url, thumbnail_prompt, seo_score, word_count, generation_attempts, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
  ).bind(
    keyword_id || 0,
    keyword_text,
    bestContent.title,
    bestContent.slug,
    bestContent.meta_description,
    finalHtml,
    JSON.stringify(bestContent.tags),
    JSON.stringify(bestContent.faq),
    thumbnailUrl,
    thumbnailPrompt,
    bestContent.seo_score,
    bestContent.word_count,
    bestContent.attempts
  ).run()

  // 키워드 사용횟수 업데이트
  if (keyword_id) {
    await c.env.DB.prepare(
      "UPDATE keywords SET used_count = used_count + 1, last_used_at = datetime('now') WHERE id = ?"
    ).bind(keyword_id).run()
  }

  return c.json({
    id: result.meta.last_row_id,
    title: bestContent.title,
    seo_score: bestContent.seo_score,
    word_count: bestContent.word_count,
    thumbnail_url: thumbnailUrl,
    content_type: classified.type,
    content_type_label: classified.label,
    attempts: bestContent.attempts
  })
})

// ===== Claude API 호출 (환자 공감형 v2) =====
async function generateWithClaude(
  apiKey: string, keyword: string, region: string, disclaimer: string,
  contentType: ContentType, typeGuide: string, patientQuestion: string, emotion?: string
) {
  const systemPrompt = buildSystemPrompt(keyword, contentType, typeGuide, patientQuestion, disclaimer, emotion)

  const userPrompt = `다음 키워드로 환자 공감형 치과 정보 블로그 포스트를 작성해주세요.

키워드: ${keyword}
콘텐츠 유형: ${contentType === 'B' ? '시술 과정/방법' : contentType === 'C' ? '회복/주의사항' : contentType === 'D' ? '비교/선택' : contentType === 'E' ? '불안/공포 해소' : '적응증/필요성'}
환자의 감정: ${emotion || '불안·걱정'}
환자가 이 글을 검색하게 된 마음: ${patientQuestion}
${region ? `## 지역 정보 (본문에만 자연 삽입 — 제목/메타 디스크립션 금지)
지역: ${region}
- ⚠️ **제목, 메타 디스크립션에 지역명 넣지 마세요**
- 본문 중 2~3곳에 자연스럽게 지역 맥락 녹이기
- slug에 지역 영문명 포함 (예: daejeon, cheongju 등)` : ''}
연도: 2026년

핵심 방향:
- 환자의 불안과 걱정을 먼저 인정하고, 구체적 정보로 해소하세요
- 비용/가격/보험 정보는 절대 다루지 마세요. 오직 치료 과정, 적응증, 부작용, 회복, 증상에만 집중하세요
- 환자가 읽고 나서 "아, 이 정도면 괜찮겠다"라고 느낄 수 있어야 합니다
- "치과에서 이렇게 질문해보세요" 같은 환자 임파워먼트 문장을 포함하세요
- ⚠️ 제목에 "~무서울까?", "~아플까?" 같은 동일 패턴만 반복하지 마세요

위 시스템 프롬프트의 모든 규칙을 엄격히 준수하고, 반드시 유효한 JSON만 출력하세요.`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 8000,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Claude API 오류 (${response.status}): ${errText}`)
  }

  const data: any = await response.json()
  const text = data.content?.[0]?.text || ''

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Claude 응답에서 JSON을 파싱할 수 없습니다')

  const parsed = JSON.parse(jsonMatch[0])
  const contentHtml = parsed.content_html || ''
  const plainText = contentHtml.replace(/<[^>]*>/g, '')

  return {
    title: parsed.title || keyword,
    slug: parsed.slug || keyword.replace(/\s+/g, '-').toLowerCase(),
    meta_description: parsed.meta_description || '',
    content_html: contentHtml,
    tags: parsed.tags || [],
    faq: parsed.faq || [],
    word_count: plainText.length
  }
}

// ===== SEO 품질 + 의료광고법 + 환자 공감도 점수 (v2) =====
function calculateSeoScore(content: any, keyword: string): number {
  let score = 0
  const title = content.title || ''
  const meta = content.meta_description || ''
  const slug = content.slug || ''
  const html = content.content_html || ''
  const tags = content.tags || []
  const faq = content.faq || []
  const plainText = html.replace(/<[^>]*>/g, '')

  const violations: string[] = []

  // ===== 1. 키워드 구조 (15점) =====
  if (title.includes(keyword)) score += 5
  const firstParagraph = plainText.substring(0, 200)
  if (firstParagraph.includes(keyword)) score += 5
  const h2Matches = html.match(/<h2[^>]*>(.*?)<\/h2>/gi) || []
  const h2WithKeyword = h2Matches.filter(h => {
    const h2Text = h.replace(/<[^>]*>/g, '')
    const kwWords = keyword.split(/\s+/)
    return kwWords.some(w => h2Text.includes(w))
  })
  if (h2WithKeyword.length >= 2) score += 5
  else if (h2WithKeyword.length >= 1) score += 2

  // ===== 2. 환자 공감도 (NEW — 15점) =====
  let empathyScore = 0
  // 감정 인정 표현 존재 여부
  const empathyPatterns = [
    '걱정', '불안', '두렵', '무섭', '당연합니다', '자연스럽', '충분히 이해',
    '처음이', '막연', '모르면.*더', '솔직하게', '결론부터',
    '판단하시면', '기준으로', '질문해보세요', '기억해두세요'
  ]
  const empathyHits = empathyPatterns.filter(p => new RegExp(p).test(plainText))
  if (empathyHits.length >= 6) empathyScore += 8
  else if (empathyHits.length >= 3) empathyScore += 5
  else if (empathyHits.length >= 1) empathyScore += 2

  // 환자 시점 서술 ("여러분", "~하시면", "~하실 수")
  const patientPov = (plainText.match(/여러분|하시면|하실\s*수|받으시|느끼실|걱정되시/g) || []).length
  if (patientPov >= 3) empathyScore += 4
  else if (patientPov >= 1) empathyScore += 2

  // 환자 임파워먼트 (치과에서 질문하라는 조언)
  if (/치과에서.*질문|질문.*해보|확인.*해보|상담.*시|체크.*리스트/.test(plainText)) empathyScore += 3

  score += Math.min(15, empathyScore)

  // ===== 3. 정보 완결성 (15점) =====
  const hasNumbers = /\d+[\s]*(만\s*원|원|%|개월|주|일|시간|분|mm|회|개|년|cc|mg|도|배)/.test(plainText)
  if (hasNumbers) score += 4
  if (faq.length >= 5) score += 7
  else if (faq.length >= 3) score += 4
  const hasList = html.includes('<ul') || html.includes('<ol') || html.includes('<table')
  if (hasList) score += 4

  // ===== 4. 분량 (10점) — 3,000자+ 권장 =====
  if (plainText.length >= 3000) score += 10
  else if (plainText.length >= 2500) score += 8
  else if (plainText.length >= 2000) score += 6
  else if (plainText.length >= 1500) score += 3

  // ===== 5. SEO 구조 (15점) =====
  const h2Count = (html.match(/<h2/gi) || []).length
  if (h2Count >= 6) score += 7
  else if (h2Count >= 5) score += 5
  else if (h2Count >= 4) score += 3
  else if (h2Count >= 3) score += 1
  // H2가 질문형인지 (가점)
  const questionH2s = h2Matches.filter(h => /\?|나요|은요|까요|할까|인가/.test(h.replace(/<[^>]*>/g, '')))
  if (questionH2s.length >= 2) score += 3
  else if (questionH2s.length >= 1) score += 1

  const slugWords = slug.split('-').filter(Boolean)
  if (slugWords.length >= 3 && slugWords.length <= 6 && /^[a-z0-9-]+$/.test(slug)) score += 3
  if (meta.length >= 120 && meta.length <= 160) score += 2
  else if (meta.length >= 80 && meta.length <= 200) score += 1

  // ===== 6. 의료광고법 위반 검사 (30점 — 위반 시 감점) =====
  let medLawScore = 30

  const clinicNamePatterns = [
    '저희 병원', '우리 병원', '본원', '당원', '본 치과', '우리 치과',
    '원장님', '대표원장', '의료진 소개',
    /[가-힣]{2,4}치과/,
    /[가-힣]{2,3}원장/,
  ]
  for (const pat of clinicNamePatterns) {
    if (typeof pat === 'string') {
      if (plainText.includes(pat)) { medLawScore -= 10; violations.push(`병원명/원장명 노출: "${pat}"`); break }
    } else {
      if (pat.test(plainText)) { medLawScore -= 10; violations.push(`병원명/원장명 패턴 감지`); break }
    }
  }

  const promoPatterns = [
    '최고의', '최첨단', '합리적인 가격', '편안한 진료', '친절한 상담',
    '최신 장비', '믿을 수 있는', '최선을 다', '안심하세요',
    '빠른 쾌유', '특별한 혜택', '이벤트', '할인',
    '무료 상담', '무료 검진', '지금 바로', '서둘러', '한정',
    '전문적인 치료', '숙련된', '풍부한 경험', '다년간',
    '첨단 시스템', '명의', '실력 있는'
  ]
  const foundPromo = promoPatterns.filter(p => plainText.includes(p))
  if (foundPromo.length > 0) {
    medLawScore -= Math.min(8, foundPromo.length * 3)
    violations.push(`홍보성 표현: ${foundPromo.slice(0, 3).join(', ')}`)
  }

  const guaranteePatterns = [
    '100% 성공', '완벽하게', '완벽한 결과', '무조건', '반드시 낫',
    '확실히 효과', '보장합니다', '약속합니다', '틀림없이',
    '부작용 없', '통증 없이', '안전하게 보장', '절대 실패',
    '완전 회복', '즉각적인 효과', '영구적', '평생 사용',
    '단 한 번으로', '고통 없는'
  ]
  const foundGuarantee = guaranteePatterns.filter(p => plainText.includes(p))
  if (foundGuarantee.length > 0) {
    medLawScore -= Math.min(8, foundGuarantee.length * 4)
    violations.push(`결과 보장/과장: ${foundGuarantee.slice(0, 3).join(', ')}`)
  }

  const comparisonPatterns = [
    '다른 병원보다', '타 병원', '일반 치과와 달리', '다른 곳에서는',
    '여기만', '오직 우리만', '유일하게'
  ]
  const foundComparison = comparisonPatterns.filter(p => plainText.includes(p))
  if (foundComparison.length > 0) {
    medLawScore -= 4
    violations.push(`타병원 비교: ${foundComparison.slice(0, 2).join(', ')}`)
  }

  // 비용/보험 정보 포함 시 강력 감점
  const costPatterns = [
    '만원', '만 원', '가격대', '비용은', '보험 적용', '실비', '급여', '비급여',
    '건강보험', '할부', '할인', '이벤트', '무료 상담', '무료 검진'
  ]
  const foundCost = costPatterns.filter(p => plainText.includes(p))
  if (foundCost.length > 0) {
    medLawScore -= Math.min(15, foundCost.length * 5)
    violations.push(`비용/보험 정보 포함 (금지): ${foundCost.slice(0, 3).join(', ')}`)
  }

  score += Math.max(0, medLawScore)

  // ===== 7. 면책 문구 =====
  const hasDisclaimer = html.includes('의료') && (html.includes('치과의사와 상담') || html.includes('치과 전문의') || html.includes('상담하시기 바랍니다'))
  if (!hasDisclaimer) {
    if (html.includes('면책') || html.includes('상담하시기')) {
      score -= 2
      violations.push('면책 문구 불완전')
    } else {
      score -= 5
      violations.push('면책 문구 없음')
    }
  }

  // ===== 8. 인사말/빈말 체크 (-3점) =====
  const fluffPatterns = [
    '안녕하세요', '오늘은.*알아보겠습니다', '사실 이것이 중요',
    /경우에 따라 다릅니다[\.\s]*$/m
  ]
  const foundFluff = fluffPatterns.filter(p => {
    if (typeof p === 'string') return plainText.includes(p)
    return p.test(plainText)
  })
  if (foundFluff.length > 0) {
    score -= Math.min(3, foundFluff.length)
    violations.push(`빈말/인사말: ${foundFluff.length}개`)
  }

  // ===== 9. ㅂ불규칙 맞춤법 위반 검사 (-5점) =====
  const bIrregularViolations = [
    { wrong: /무섭을/, correct: '무서울' },
    { wrong: /아픕을/, correct: '아플' },
    { wrong: /어렵을/, correct: '어려울' },
    { wrong: /가벼을/, correct: '가벼울' },
    { wrong: /춥을/, correct: '추울' },
    { wrong: /됬습니다/, correct: '됐습니다' },
  ]
  const foundSpellingErrors: string[] = []
  const allTextForSpelling = title + ' ' + meta + ' ' + plainText
  for (const check of bIrregularViolations) {
    if (check.wrong.test(allTextForSpelling)) {
      foundSpellingErrors.push(`"${check.wrong.source}" → "${check.correct}"`)
    }
  }
  if (foundSpellingErrors.length > 0) {
    score -= Math.min(5, foundSpellingErrors.length * 2)
    violations.push(`ㅂ불규칙 맞춤법 오류: ${foundSpellingErrors.join(', ')}`)
  }

  // ===== 10. 제목 다양성 검사 v4 (+3점 / -2점) =====
  // 다양한 제목 패턴 인정 (감정 질문만 강제하지 않음)
  const titleHasGoodPattern = /알아야 할|확인하세요|가이드|완전 정리|체크리스트|비교|차이점|경험자|오해와|진실|미루면|판단 기준|선택 기준|A부터 Z|핵심|회복 일지|팩트 정리|무서울까|아플까|괜찮을까|어떻게 되나요|꼭 해야|하면 안 되는|하기 전에|다음 날|질문 \d+가지/.test(title)
  if (titleHasGoodPattern) {
    score += 3
  }
  // 제목에 지역명이 있으면 감점 (v4: 지역명 본문만)
  const REGION_NAMES = ['대전','세종','청주','천안','아산','서산','당진','논산','공주','보령','제천','충주','홍성','예산','음성','진천','괴산','옥천','영동','금산']
  const titleHasRegion = REGION_NAMES.some(r => title.includes(r))
  if (titleHasRegion) {
    score -= 3
    violations.push('제목에 지역명 포함 (v4에서 금지)')
  }

  // ===== 11. Experience 마커 체크 (v3 신규 — Google E-E-A-T 대응, 10점) =====
  const experiencePatterns = [
    '진료실에서', '진료 현장', '임상 경험', '환자분들이 가장', '처음 오시는 분',
    '수천 케이스', '상담 시', '실제로 환자', '자주 듣는', '종종 봅니다',
    '늘 강조드리는', '제가 본', '새벽에 응급', '회복이 빠른 분들',
    '처음 내원', '표정이 달라', '실제 진료'
  ]
  const experienceHits = experiencePatterns.filter(p => plainText.includes(p))
  if (experienceHits.length >= 3) {
    score += 10
  } else if (experienceHits.length >= 2) {
    score += 6
  } else if (experienceHits.length >= 1) {
    score += 3
  } else {
    score -= 5
    violations.push('Experience 마커 부재 — 임상 경험 문장 없음')
  }

  // ===== 12. 문장 다양성 체크 (v3 신규 — AI 패턴 탐지 방지, -5점) =====
  const sentences = plainText.split(/[.!?]\s+/).filter(s => s.length > 10)
  const endingCounts: Record<string, number> = {}
  for (const s of sentences) {
    const ending = s.slice(-6).trim()
    const endPattern = ending.match(/(입니다|합니다|습니다|세요|니다|이죠|거든요|됩니다|십니다)$/)?.[1] || 'other'
    endingCounts[endPattern] = (endingCounts[endPattern] || 0) + 1
  }
  const dominantEnding = Math.max(...Object.values(endingCounts))
  const endingDominanceRatio = sentences.length > 0 ? dominantEnding / sentences.length : 0
  if (endingDominanceRatio > 0.6) {
    score -= 5
    violations.push(`문장 어미 단조로움: 동일 어미 ${Math.round(endingDominanceRatio * 100)}% 반복`)
  }

  if (violations.length > 0) {
    console.log(`[SEO 검증] "${keyword}" 위반사항: ${violations.join(' | ')}`)
  }

  return Math.min(100, Math.max(0, score))
}

// ===== 썸네일 생성 (프리미엄 AI 이미지 — fal.ai FLUX.2 pro 우선) =====
async function generateThumbnail(keyword: string, title: string, env?: any): Promise<{ url: string; prompt: string }> {
  const prompt = `High quality photorealistic 3D dental medical illustration about "${keyword}". Soft pastel colors, light blue and white palette, clean modern design, absolutely no text no letters no words no numbers anywhere in the image, no human faces, no logos, professional healthcare aesthetic, studio lighting, cinematic composition, 8k ultra-detailed, suitable for medical blog OG image thumbnail 1200x630.`
  
  // 폴백용 플레이스홀더
  const colors = ['4A90D9', '5B8C5A', '8B5CF6', 'D97706', 'DC2626', '0891B2', '7C3AED', '059669']
  const colorIdx = Math.abs(keyword.length * 7) % colors.length
  const placeholderUrl = `https://placehold.co/1200x630/${colors[colorIdx]}/ffffff?text=${encodeURIComponent(keyword)}&font=sans-serif`

  try {
    // fal.ai API 키 읽기
    let falApiKey = ''
    try {
      const falKeyRow = await env?.DB?.prepare("SELECT value FROM settings WHERE key = 'fal_api_key'").first()
      falApiKey = falKeyRow?.value as string || ''
    } catch (e) {}
    
    if (falApiKey) {
      // fal.ai 프리미엄 모델 체인 (최고급 → 고급 → 기본)
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
          console.log(`[썸네일] ${model.name} 시도 중... (${model.cost})`)
          const falResponse = await fetch(model.url, {
            method: 'POST',
            headers: {
              'Authorization': `Key ${falApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(model.body),
            signal: AbortSignal.timeout(60000)
          })
          
          if (falResponse.ok) {
            const falData: any = await falResponse.json()
            const imageUrl = falData?.images?.[0]?.url
            if (imageUrl) {
              console.log(`[썸네일] ✅ ${model.name} 성공: ${keyword} ${model.cost}`)
              return { url: imageUrl, prompt }
            }
          } else {
            const errText = await falResponse.text()
            console.warn(`[썸네일] ❌ ${model.name} 실패 (${falResponse.status}): ${errText.substring(0, 200)}`)
            continue
          }
        } catch (falErr: any) {
          console.warn(`[썸네일] ❌ ${model.name} 에러: ${falErr.message}`)
          continue
        }
      }
      console.warn('[썸네일] fal.ai 전체 모델 실패, Pollinations 폴백')
    }
    
    // 폴백: Pollinations AI turbo (무료)
    const seed = Math.abs(Date.now() % 999999)
    const encodedPrompt = encodeURIComponent(prompt.substring(0, 200))
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1200&height=630&model=turbo&nologo=true&seed=${seed}`
    
    const checkResponse = await fetch(pollinationsUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20000) })
    
    if (checkResponse.ok || checkResponse.status === 302 || checkResponse.status === 301) {
      return { url: pollinationsUrl, prompt }
    }

    return { url: pollinationsUrl, prompt }
  } catch (e) {
    console.error('썸네일 생성 실패, 플레이스홀더 사용:', e)
    return { url: placeholderUrl, prompt }
  }
}

// ===== 외부에서 사용할 수 있도록 export =====
export { contentRoutes, classifyContentType, getTypeGuide, buildSystemPrompt, calculateSeoScore, ARTICLE_STRUCTURES, getArticleStructure, getExperienceMarkers }
