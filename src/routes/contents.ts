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

// ===== Experience 마커 풀 (임상 경험 기반 문장 — E-E-A-T 강화 v7.0) =====
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
  // v7.0 추가: 더 구체적이고 생생한 임상 경험
  '진료 중에 이 상태를 발견하면, 환자분보다 제가 더 안타까운 경우가 많습니다. 조금만 일찍 오셨으면 하는 마음이 들거든요.',
  '정기검진에서 이 부분을 체크할 때, "이전과 비교해서 어떤가요?"라고 여쭤봅니다. 그 답변 하나로 현재 관리 상태를 짐작할 수 있습니다.',
  'CT를 찍어보면, 겉으로는 멀쩡해 보이는데 속은 전혀 다른 경우가 있습니다. 그래서 정확한 진단이 중요합니다.',
  '환자분이 가져오시는 인터넷 정보 중 70%는 맞지만, 나머지 30%가 판단을 완전히 바꿀 수 있는 부분이에요.',
  '같은 치료라도 환자분의 뼈 상태, 전신 건강, 생활 습관에 따라 결과가 확연히 달라집니다. 그래서 맞춤 계획이 필수입니다.',
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

// ===== 도입부 첫 문장 패턴 풀 (12가지 — 매번 다른 시작, v5.1 확장) =====
const OPENING_PATTERNS = [
  { id: 'direct_answer', guide: '결론부터: 핵심 답변을 첫 문장에 던지세요. "결론부터 말씀드리면, ~입니다."' },
  { id: 'empathy', guide: '공감형: 환자의 감정을 그대로 인정하며 시작하세요. "~때문에 밤에 검색하고 계시다면, 그 마음 충분히 이해합니다."' },
  { id: 'stat_hook', guide: '수치 훅: 의외의 통계로 시작하세요. "실제로 ~환자의 92%는 치료 후 이렇게 말합니다."' },
  { id: 'scenario', guide: '상황 묘사: 구체적 장면으로 시작하세요. "거울 앞에서 양치하다 잇몸에서 피가 나는 걸 발견한 순간..."' },
  { id: 'myth_break', guide: '오해 깨기: 잘못된 상식을 바로잡으며 시작하세요. "인터넷에서 흔히 볼 수 있는 이 이야기, 사실이 아닙니다."' },
  { id: 'question', guide: '질문형: 독자의 마음속 질문을 대신 꺼내세요. "혹시 ~하신 적 있으신가요?"' },
  { id: 'clinical_obs', guide: '임상 관찰: 진료실 경험으로 시작하세요. "진료실에서 이 주제로 상담할 때, 환자분들이 공통적으로 하시는 말이 있습니다."' },
  { id: 'contrast', guide: '대조형: 기대와 현실의 차이로 시작하세요. "많은 분이 ~라고 생각하시지만, 실제로는 정반대입니다."' },
  { id: 'timeline', guide: '시간 프레임: 구체적 시점으로 시작하세요. "치과에 앉은 순간부터 집에 돌아올 때까지, 실제로 어떤 일이 벌어지는지 말씀드리겠습니다."' },
  { id: 'promise', guide: '약속형: 이 글의 가치를 먼저 제시하세요. "이 글을 끝까지 읽으시면, ~를 스스로 판단할 수 있게 됩니다."' },
  { id: 'confession', guide: '고백형: 의외의 사실을 먼저 꺼내세요. "사실 치과의사도 이 질문을 받으면 한 번은 멈추고 생각합니다."' },
  { id: 'patient_voice', guide: '환자 목소리: 실제 환자 말투로 시작하세요. "\"선생님, 이거 진짜 안 아프긴 한 거예요?\" — 거의 매일 듣는 질문입니다."' },
]

function getOpeningPattern(keyword: string, contentId: number): typeof OPENING_PATTERNS[0] {
  const hash = keyword.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return OPENING_PATTERNS[(hash + contentId) % OPENING_PATTERNS.length]
}

// ===== 원장 관점 문장 풀 v7.0 (문석준 원장의 진료 철학 + 판단 기준 기반) =====
const DOCTOR_PERSPECTIVES = [
  '제가 환자분들께 늘 말씀드리는 기준이 있습니다. "지금 불편한 게 일상을 방해하는가?"입니다. 방해한다면 미루는 것 자체가 손해입니다.',
  '치과의사로서 강조하고 싶은 건, 단편적인 치료보다 전체 구강 상태를 보는 시각이 중요하다는 점입니다.',
  '이 치료에 대해 환자분들이 잘못 알고 계신 부분이 하나 있습니다. 실제 진료 데이터를 보면 결과가 다릅니다.',
  '치료 결정을 내리기 전에, 반드시 "내 뼈 상태가 어떤지" "전신 건강에 문제는 없는지" 이 두 가지를 먼저 확인하셔야 합니다.',
  '이 부분에서 환자분들이 가장 많이 오해하시는 것은, 아프면 이미 늦었다고 생각하시는 겁니다. 대부분의 경우 아직 충분히 회복 가능합니다.',
  '저는 첫 상담에서 반드시 이 질문을 드립니다. "가장 걱정되는 게 뭐세요?" 그 답에 따라 설명 방향이 완전히 달라지거든요.',
  '수천 건의 케이스를 진행하면서 확신하게 된 것은, 환자가 정확히 알수록 치료 결과가 좋다는 사실입니다.',
  '치료 자체보다 "언제 하느냐"가 결과를 더 크게 좌우합니다. 같은 치료도 6개월 먼저 시작하면 난이도가 완전히 달라집니다.',
  '진료실에서 CT를 찍어보면, 본인이 생각했던 것보다 상태가 나쁜 경우도 좋은 경우도 있습니다. 그래서 "일단 검사부터"가 맞습니다.',
  '환자분이 두 가지 선택지 사이에서 고민하실 때, 저는 "5년 뒤에 어떤 선택을 했으면 좋겠냐"고 여쭤봅니다. 대부분 그 질문 하나로 결정이 됩니다.',
  '젊은 분들이 "나이가 더 먹으면 하려고요"라고 하시는데, 사실은 정반대입니다. 뼈 상태도 전신 건강도 지금이 가장 좋은 시기거든요.',
  '이 치료를 할지 말지 고민하시는 분께는 항상 이렇게 말씀드립니다. "안 하시면 안 되는 건 아닙니다. 다만, 미루실수록 선택지가 줄어듭니다."',
  // v7.0 추가: Patient Funnel 철학 기반 심화
  '환자분이 두려워하시는 것과 실제로 일어나는 일 사이에는 큰 간극이 있습니다. 그 간극을 메우는 것이 첫 상담의 핵심이에요.',
  '저는 치료 계획을 세울 때 항상 "최악의 경우"도 함께 말씀드립니다. 그래야 환자분이 진짜 결정을 내릴 수 있거든요.',
  '진료실에서 20년간 보아온 패턴이 있습니다. 정보를 충분히 이해한 환자분은, 치료 후 만족도가 현저히 높습니다.',
  '"필요한 진료를 받지 못하는 사람이 없도록 하자" — 이것이 제가 매일 진료실에 서는 이유입니다.',
]

function getDoctorPerspective(keyword: string, contentId: number): string {
  const hash = keyword.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return DOCTOR_PERSPECTIVES[(hash + contentId) % DOCTOR_PERSPECTIVES.length]
}

// ===== GPT 시스템 프롬프트 (v7.0 — 간소화 정보 전달형) =====
function buildSystemPrompt(keyword: string, contentType: ContentType, typeGuide: string, patientQuestion: string, disclaimer: string, emotion?: string, structureOverride?: string): string {
  const kwHash = keyword.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const timeSeed = Math.floor(Date.now() / 60000)
  const diversitySeed = kwHash + timeSeed
  const structure = ARTICLE_STRUCTURES[diversitySeed % ARTICLE_STRUCTURES.length]
  const experienceMarkers = getExperienceMarkers(keyword, 3)
  const h2Count = 5 + (diversitySeed % 4)

  return `당신은 치과의사 시점에서 환자용 정보 블로그를 작성하는 전문 작성자입니다.

## 핵심 원칙
- 치과의사가 직접 쓴 글처럼 보여야 합니다 (임상 경험, 조건부 설명 포함)
- "~입니다" 반복 금지 — "~이죠", "~거든요", "~편입니다" 등 자연스럽게 섞기
- 매 문단이 이 키워드만의 고유 내용이어야 합니다

## 독자
- 검색 의도: "${patientQuestion}"
- 감정: "${emotion || '불안·걱정'}"

## 글쓰기 원칙
1. 감정을 먼저 인정 → 구체적 정보로 불안 해소
2. 조건부 수치 사용 ("보통 ~이지만, ~한 경우에는 ~")
3. 환자에게 주도권 ("치과에서 이렇게 질문하세요")

${typeGuide}

## 글 구조: ${structure.label}
${structureOverride || structure.guide}

## 임상 경험 삽입 (본문에 자연스럽게 2~3개)
${experienceMarkers.map((m, i) => `${i + 1}. "${m}"`).join('\n')}

## 범위 명시 (도입부에 포함)
<div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:8px;padding:16px;margin:16px 0;font-size:14px">
<strong>📌 이 글의 범위</strong><br>
이 글은 <strong>[대상/조건]</strong> 기준으로 작성되었습니다.<br>
• 다루는 것: [항목 2~3개] / 다루지 않는 것: [항목 2~3개]
</div>

## 제목 규칙
- 키워드를 앞쪽 30자 이내에 배치, 40~65자 권장
- 제목 금지어: "가이드", "총정리", "완전 정리", "완벽", "2026", "핵심 정리", "~하는 법"
- 제목에 지역명 금지
- 커뮤니티명 금지 (더쿠, 디시, 에펨코리아, 뽐뿌, 클리앙, 루리웹, 인벤, 블라인드 등)

## H2 작성: ${h2Count}개
- 환자가 머릿속으로 하는 질문 그대로
- 각 H2: 300~500자, 공감 + 답변 + 조건부 수치 + 임상 경험
- "~에 대해 알아보겠습니다" 같은 천편일률 H2 금지

## 필수 포함 요소
- 오해 교정 1개 이상 (❌ 오해 → ✅ 사실)
- 첫 문단에 검색 의도 명시 ("이 글은 ~한 분을 위한 글입니다")
- 조건부 수치 + 출처 맥락 2회 이상 ("임상 문헌에 따르면", "대한치과의사협회 기준")
- FAQ 5~7개 (<details><summary>Q</summary><p>A</p></details>)
- 면책: <div style="background:#f0f7ff;padding:16px;border-radius:8px;margin-top:32px;font-size:13px;color:#555;border-left:3px solid #3b82f6"><strong>📋 의료 정보 안내</strong><br>${disclaimer}</div>

## 금지 사항
- 비용/가격/보험 관련 단어 일체 금지 (만원, 가격, 비용, 보험, 실비, 급여 등)
- 실명 사용 금지 (환자 사례는 "~모 씨", "50대 환자분" 등으로 익명화)
- 병원명/원장명/홍보 문구 금지
- content_html에 JSON-LD, <script> 태그 금지
- "안녕하세요", "오늘은 ~에 대해" 같은 도입부 금지

## 톤
"내 담당 치과 선생님"처럼 — 전문적이지만 따뜻하게, 솔직하지만 안심을 주는 톤

## 키워드 밀도
"${keyword}": 본문 3~5회 자연 삽입, 시맨틱 키워드 3개 이상

## 출력 형식 (유효한 JSON만)
{
  "title": "SEO 제목 (40~65자)",
  "slug": "영문-소문자-하이픈-3-5단어",
  "meta_description": "120~160자",
  "content_html": "완전한 HTML (3,000자 이상, H2 ${h2Count}개)",
  "tags": ["태그1","태그2","태그3","태그4","태그5"],
  "faq": [{"q":"질문","a":"답변"}],
  "word_count": 숫자,
  "content_type": "${contentType}",
  "article_structure": "${structure.id}",
  "scope_notice": "범위 한 문장",
  "differentiation_angle": "차별화 포인트 한 문장",
  "myth_correction": "교정한 오해 한 문장",
  "search_intent_sentence": "검색 의도 명시 문장"
}`
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

  // Get settings — OpenAI API key (settings DB → env fallback)
  const openaiKeyRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").first()
  const disclaimerRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'medical_disclaimer'").first()
  const regionRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'clinic_region'").first()
  const minScoreRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'seo_min_score'").first()
  const openaiBaseRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'openai_base_url'").first()

  const gptApiKey = openaiKeyRow?.value as string || c.env.OPENAI_API_KEY || ''
  const gptBaseUrl = openaiBaseRow?.value as string || 'https://www.genspark.ai/api/llm_proxy/v1'
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

  if (!gptApiKey) {
    return c.json({ error: 'OpenAI API 키가 설정되지 않았습니다. 설정 페이지에서 입력해주세요.' }, 400)
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
      const generated = await callGPT(gptApiKey, gptBaseUrl, keyword_text, region, disclaimer, classified.type, typeGuide, classified.question, classified.emotion)
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

  // 썸네일 생성 제거됨 (v7.0) — Inblog 자체 OG 이미지 사용
  const finalHtml = bestContent.content_html

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
    '',  // thumbnail_url — removed
    '',  // thumbnail_prompt — removed
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
    content_type: classified.type,
    content_type_label: classified.label,
    attempts: bestContent.attempts
  })
})

// ===== GPT API 호출 (v6.0 — 수동 생성용, 제목 사후검증 포함) =====
async function callGPT(
  apiKey: string, baseUrl: string, keyword: string, region: string, disclaimer: string,
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
- ⚠️ 제목에 "가이드", "총정리", "완전 정리", "2026", "핵심 정리" 절대 금지

⛔ 절대 금지: "만원", "만 원", "가격", "비용", "보험 적용", "보험", "실비", "실손", "급여", "비급여", "건강보험", "할부", "할인", "무료 상담", "무료 검진", "수가", "본인부담", "의료비", "치료비"

위 시스템 프롬프트의 모든 규칙을 엄격히 준수하고, 반드시 유효한 JSON만 출력하세요.`

  // GPT 5.5 → 4o 자동 폴백
  const models = [
    { id: 'gpt-5.5', timeout: 240000 },
    { id: 'gpt-4o', timeout: 180000 }
  ]
  let lastError = ''

  for (const model of models) {
    try {
      console.log(`[GPT] ${model.id} 시도 중... (수동 생성)`)
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model.id,
          max_tokens: 8000,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          response_format: { type: 'json_object' }
        }),
        signal: AbortSignal.timeout(model.timeout)
      })

      if (!response.ok) {
        const errText = await response.text()
        lastError = `GPT API 오류 (${model.id}, ${response.status}): ${errText}`
        console.warn(`[GPT] ${lastError}`)
        continue
      }

      const data: any = await response.json()
      const text = data.choices?.[0]?.message?.content || ''
      console.log(`[GPT] ${model.id} 응답 수신 (${text.length}자)`)

      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        lastError = `${model.id} 응답에서 JSON을 파싱할 수 없습니다`
        console.warn(`[GPT] ${lastError}`)
        continue
      }

      var parsed = JSON.parse(jsonMatch[0])
      break // 성공 시 루프 탈출
    } catch (e: any) {
      lastError = `${model.id}: ${e.message}`
      console.warn(`[GPT] ${lastError}`)
      continue
    }
  }

  if (!parsed) throw new Error(`모든 GPT 모델 실패: ${lastError}`)
  // @ts-ignore — parsed is assigned in loop
  const contentHtml = parsed.content_html || ''
  const plainText = contentHtml.replace(/<[^>]*>/g, '')

  // v5.1: 제목 사후검증 — 남용 키워드 자동 제거
  let finalTitle = parsed.title || keyword
  const TITLE_BANNED = ['가이드', '총정리', '완전 정리', '모든 것', 'A부터 Z', '완벽 정리', '완벽', '핵심 정리']
  for (const banned of TITLE_BANNED) {
    if (finalTitle.includes(banned)) {
      finalTitle = finalTitle.replace(new RegExp(banned, 'g'), '').replace(/\s{2,}/g, ' ').trim()
    }
  }
  if (/202[0-9]년?/.test(finalTitle)) {
    finalTitle = finalTitle.replace(/\s*202[0-9]년?\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  }
  // 지역명 제거
  const REGIONS = ['대전','세종','청주','천안','아산','서산','당진','논산','공주','보령','제천','충주','홍성','예산','음성','진천','괴산','옥천','영동','금산']
  for (const r of REGIONS) {
    if (finalTitle.includes(r)) {
      finalTitle = finalTitle.replace(new RegExp(r, 'g'), '').replace(/\s{2,}/g, ' ').trim()
    }
  }

  // v6.0: 범위 명시 박스 사후 검증 — GPT가 빠뜨렸을 때 자동 삽입
  let finalContentHtml = contentHtml
  const hasScopeBox = /이 글의 범위|이 글에서 다루지 않|다루는 것|다루지 않는 것/.test(plainText)
  if (!hasScopeBox) {
    const scopeText = parsed.scope_notice || `일반적인 ${keyword} 기준`
    const scopeBox = `<div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:8px;padding:16px;margin:16px 0;font-size:14px"><strong>📌 이 글의 범위</strong><br>이 글은 <strong>${scopeText}</strong>으로 작성되었습니다.<br>• 개인별 구강 상태, 전신 건강에 따라 내용이 달라질 수 있습니다.<br>• 특수한 경우(전신질환, 복합 시술 등)는 별도 글을 참고해주세요.</div>`
    const firstH2 = finalContentHtml.indexOf('<h2')
    if (firstH2 !== -1) {
      finalContentHtml = finalContentHtml.slice(0, firstH2) + scopeBox + '\n' + finalContentHtml.slice(firstH2)
    } else {
      const firstPEnd = finalContentHtml.indexOf('</p>')
      if (firstPEnd !== -1) {
        finalContentHtml = finalContentHtml.slice(0, firstPEnd + 4) + '\n' + scopeBox + finalContentHtml.slice(firstPEnd + 4)
      }
    }
  }

  return {
    title: finalTitle,
    slug: parsed.slug || keyword.replace(/\s+/g, '-').toLowerCase(),
    meta_description: parsed.meta_description || '',
    content_html: finalContentHtml,
    tags: parsed.tags || [],
    faq: parsed.faq || [],
    word_count: plainText.length
  }
}

// ===== SEO 품질 + 의료광고법 + 환자 공감도 점수 (v2) =====
function calculateSeoScore(content: any, keyword: string): number {
  try {
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
  const hasDisclaimer = html.includes('의료') && (html.includes('치과의사와 상담') || html.includes('치과의사') || html.includes('상담하시기 바랍니다'))
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

  // ===== 10. 제목 다양성 + 남용 키워드 검사 v5.1 =====
  // 제목에 남용 금지 키워드가 있으면 강력 감점
  const TITLE_BANNED_WORDS = ['가이드', '총정리', '완전 정리', '모든 것', 'A부터 Z', '완벽 정리', '완벽', '핵심 정리']
  const foundBannedInTitle = TITLE_BANNED_WORDS.filter(w => title.includes(w))
  if (foundBannedInTitle.length > 0) {
    score -= Math.min(8, foundBannedInTitle.length * 4)
    violations.push(`제목 남용 키워드: ${foundBannedInTitle.join(', ')}`)
  }
  // 제목에 연도(2026 등)가 있으면 감점
  if (/202[0-9]/.test(title)) {
    score -= 3
    violations.push('제목에 연도 포함 (남용 방지)')
  }
  // 다양한 제목 패턴 인정 (v5.1: 4가지 형태 혼용 확인)
  const titleHasGoodPattern = /할까|일까|인가|나요|세요|전에|후기|경험|비교|차이|체크|리스트|기준|실제|현실|데이터|팩트|습관|타임라인|신호|비결/.test(title)
  if (titleHasGoodPattern) {
    score += 3
  }
  // 제목에 지역명이 있으면 감점 (v4+: 지역명 본문만)
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

  // ===== 12. 문장 다양성 체크 (v3 — AI 패턴 탐지 방지, -5점) =====
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

  // ===== 13. 조건부 수치 표현 가점 (v5.1 신규 — +5점) =====
  const conditionalPatterns = [
    '보통.*이지만', '경우에.*따라', '상태에.*따라', '조건.*에서는',
    '건강.*경우', '다만.*경우', '반면.*경우', '위험.*요인이',
    '~이지만.*경우', '충분하지만', '가능하지만'
  ]
  const conditionalHits = conditionalPatterns.filter(p => new RegExp(p).test(plainText))
  if (conditionalHits.length >= 3) {
    score += 5
  } else if (conditionalHits.length >= 1) {
    score += 2
  } else {
    score -= 3
    violations.push('조건부 수치 표현 부재 — 단정적 정보만 제공')
  }

  // ===== 14. 원장 관점/판단 기준 가점 (v5.1 신규 — +5점) =====
  const doctorViewPatterns = [
    '제가.*판단', '기준이.*있습니다', '말씀드리는', '강조.*싶은',
    '진료.*데이터', '확인하셔야', '먼저 확인', '제가.*본',
    '확신하게 된', '여쭤봅니다', '말씀드립니다', '결정이 됩니다'
  ]
  const doctorHits = doctorViewPatterns.filter(p => new RegExp(p).test(plainText))
  if (doctorHits.length >= 2) {
    score += 5
  } else if (doctorHits.length >= 1) {
    score += 3
  } else {
    score -= 2
    violations.push('원장 관점/판단 기준 부재')
  }

  // ===== 15. 도입부 패턴 체크 (v5.1 — 금지 시작 패턴 감점) =====
  const first50 = plainText.substring(0, 50)
  if (/^안녕하세요|^오늘은.*알아보|^많은 분들이|^오늘 이 글에서는/.test(first50)) {
    score -= 5
    violations.push('도입부 금지 패턴 사용')
  }

  // ===== 16. 범위 명시 박스 검증 (v5.2 — 스팸 구별 핵심 신호, +7점) =====
  const hasScopeNotice = /이 글의 범위|이 글에서 다루지 않|다루는 것.*다루지 않는 것|다루지 않는 것/.test(plainText)
  if (hasScopeNotice) {
    score += 7
    // "다루지 않는 것"이 구체적으로 2개 이상 나열되어 있으면 추가 가점
    const scopeItems = (plainText.match(/다루지 않[는습]|별도 글을 참고|이 글은.*기준/g) || []).length
    if (scopeItems >= 2) score += 3
  } else {
    score -= 5
    violations.push('범위 명시 박스 누락 — AI 스팸과 구별 불가')
  }

  // ===== 17. 차별화 앵글 검증 (v5.2 — 경쟁글 대비 고유 관점, +5점) =====
  // 차별화 포인트가 될 수 있는 패턴: 치과의사 판단 기준, 구체적 수치, 시간 경과 정보
  const diffPatterns = [
    /다른 글에서|흔히 다루지 않|잘 알려지지 않/,
    /CT에서|X-ray에서|파노라마에서|mm\s*이[상하]|ml\s*이/,
    /\d+개월 후|정기검진에서|장기적으로|시간이 지나면/,
    /진료실에서 자주 보는|실제 케이스|임상에서|경험상/,
    /환자분들이 잘 모르시는|의외로|사실은 정반대/,
  ]
  const diffHits = diffPatterns.filter(p => p.test(plainText))
  if (diffHits.length >= 3) {
    score += 5
  } else if (diffHits.length >= 2) {
    score += 3
  } else if (diffHits.length >= 1) {
    score += 1
  } else {
    score -= 3
    violations.push('차별화 앵글 부재 — 경쟁글과 동일한 내용')
  }

  // ===== 18. 오해 교정 섹션 검증 (v5.3 — E-E-A-T 핵심 신호, +8점) =====
  const mythCorrectionPatterns = [
    /오해.*사실|사실.*오해/,
    /잘못\s*알|잘못된\s*정보|잘못\s*알려/,
    /실제로는|사실은\s*그렇지|정반대/,
    /❌.*✅|❌.*→.*✅/,
    /흔히.*생각.*하지만|많이.*오해/,
    /~간다.*실제|평생.*실제/,
  ]
  const mythHits = mythCorrectionPatterns.filter(p => p.test(plainText))
  if (mythHits.length >= 2) {
    score += 8
  } else if (mythHits.length >= 1) {
    score += 5
  } else {
    score -= 5
    violations.push('오해 교정 섹션 누락 — E-E-A-T 신호 부재')
  }

  // ===== 19. 수치 출처 맥락 검증 (v5.3 — 신뢰도 신호, +6점) =====
  const sourcePatterns = [
    /건강보험심사평가원|심평원/,
    /대한치과의사협회|치의협/,
    /대한[가-힣]*학회/,
    /학술지|저널|journal|연구.*따르면|연구.*결과/i,
    /가이드라인\s*기준|권고안\s*기준/,
    /임상\s*문헌|임상\s*데이터|임상\s*연구/,
    /메타분석|다기관\s*연구|체계적\s*문헌고찰/,
    /통계.*따르면|보고.*있습니다|발표.*연구/,
    /치과의사\s*사이에서|일반적으로\s*인정/,
  ]
  const sourceHits = sourcePatterns.filter(p => p.test(plainText))
  if (sourceHits.length >= 3) {
    score += 6
  } else if (sourceHits.length >= 2) {
    score += 4
  } else if (sourceHits.length >= 1) {
    score += 2
  } else {
    score -= 4
    violations.push('수치 출처 맥락 부재 — 근거 없는 숫자 나열')
  }

  // ===== 20. 첫 문단 검색 의도 명시 검증 (v5.3 — 이탈률 감소 신호, +5점) =====
  // 첫 200자 안에 "~위한 글", "~분이라면", "~고민 중이시라면", "~상황에서" 등
  const first200 = plainText.substring(0, 200)
  const intentPatterns = [
    /위한\s*(글|정보|안내)/,
    /분이라면|분께|분을\s*위해/,
    /고민\s*중이시|검색.*계신|찾고.*계신/,
    /상황에서|상황이라면|경우라면/,
    /들으신\s*분|들은\s*분|받으신\s*분|받은\s*분/,
    /궁금하신\s*분|걱정되시는\s*분/,
  ]
  const intentHits = intentPatterns.filter(p => p.test(first200))
  if (intentHits.length >= 1) {
    score += 5
  } else {
    score -= 3
    violations.push('첫 문단 검색 의도 명시 부재 — 이탈률 위험')
  }

  // ===== 21. 인터렉티브 요소 검증 (v7.0 — 체류시간 극대화, +8점) =====
  let interactiveScore = 0
  // 자가진단 체크리스트
  if (/해당|☐|체크|확인해보세요|자가진단|자가\s*테스트|몇\s*개.*해당/.test(plainText)) {
    interactiveScore += 3
  }
  // "이렇게 질문하세요" 박스
  if (/질문해보세요|질문해\s*보세요|물어보세요|확인해보세요.*치과에서/.test(plainText)) {
    interactiveScore += 2
  }
  // 비교 테이블
  if (html.includes('<table') && html.includes('<th')) {
    interactiveScore += 2
  }
  // 타임라인/단계별 구조
  if (/당일.*→|1일.*→|1주.*→|단계별|타임라인|STEP\s*\d|[①②③④⑤]/.test(plainText)) {
    interactiveScore += 2
  }
  // 핵심 요약 하이라이트 박스
  if (/핵심 요약|핵심 포인트|한눈에 보기|💎/.test(plainText) || /background.*#fef3c7/.test(html)) {
    interactiveScore += 2
  }
  score += Math.min(8, interactiveScore)
  if (interactiveScore === 0) {
    violations.push('인터렉티브 요소 부재 — 체류시간 위험')
  }

  // ===== 22. 가독성 & 시각적 구조 검증 (v7.0 — +5점) =====
  let readabilityScore = 0
  // <strong> 또는 <b> 사용 빈도 (키워드 강조)
  const boldCount = (html.match(/<(strong|b)>/gi) || []).length
  if (boldCount >= 5 && boldCount <= 30) readabilityScore += 2
  // <h3> 사용 (세부 구조화)
  const h3Count = (html.match(/<h3/gi) || []).length
  if (h3Count >= 2) readabilityScore += 2
  // 단락 길이 — 200자 이상인 단락이 3개 미만이면 가독성 좋음
  const paragraphs = plainText.split(/\n\n+/).filter(p => p.trim().length > 0)
  const longParagraphs = paragraphs.filter(p => p.length > 400)
  if (longParagraphs.length <= 2) readabilityScore += 1
  else if (longParagraphs.length >= 5) {
    readabilityScore -= 2
    violations.push(`긴 단락 ${longParagraphs.length}개 — 가독성 저하 위험`)
  }
  score += Math.min(5, readabilityScore)

  // ===== 23. 시맨틱 키워드 다양성 (v7.0 — +4점) =====
  const semanticTerms = [
    '원인', '증상', '치료', '회복', '주의', '관리', '진단', '검사',
    '부작용', '장점', '단점', '기간', '과정', '방법', '효과', '예방',
    '상담', '치과의사', '추천', '경험'
  ]
  const semanticHits = semanticTerms.filter(t => plainText.includes(t))
  if (semanticHits.length >= 8) score += 4
  else if (semanticHits.length >= 5) score += 2
  else if (semanticHits.length < 3) {
    score -= 2
    violations.push('시맨틱 키워드 부족 — 토픽 깊이 부족')
  }

  if (violations.length > 0) {
    console.log(`[SEO 검증] "${keyword}" 위반사항: ${violations.join(' | ')}`)
  }

  return Math.min(100, Math.max(0, score))
  } catch (seoErr: any) {
    console.error(`[SEO 스코어링] 예외 발생 (기본값 50 반환): ${seoErr.message || seoErr}`)
    return 50 // 스코어링 실패 시 중간값 반환 — 콘텐츠 생성 자체는 중단하지 않음
  }
}

// generateThumbnail 제거됨 (v7.0) — Inblog 자체 OG 이미지 활용

// ===== 외부에서 사용할 수 있도록 export =====
export { contentRoutes, classifyContentType, getTypeGuide, buildSystemPrompt, calculateSeoScore, ARTICLE_STRUCTURES, getArticleStructure, getExperienceMarkers }
