# Inblog AutoPublish SaaS

치과 SEO 콘텐츠 자동 적립 플랫폼

## 프로젝트 개요
- **목적**: 키워드만 등록하면 매일 3건의 SEO 최적화 포스트가 인블로그에 자동 발행되는 시스템
- **기술 스택**: Hono + Cloudflare Workers + D1 + Tailwind CSS + Claude API + Inblog REST API
- **핵심 가치**: SEO 자산 자동 적립 (연간 1,095건 구글 인덱싱)

## 완성된 기능

### Layer 1 — 키워드 엔진
- 치과 키워드 DB 313개 내장 (임플란트/교정/일반치료/예방/지역)
- 카테고리별 가중치 기반 자동 선택
- 중복 방지 (사용횟수 + 마지막 사용일 추적)
- 커스텀 키워드 수동 추가/삭제/활성화 관리

### Layer 2 — 콘텐츠 엔진 (AI)
- Claude API (Sonnet) 연동 SEO 콘텐츠 자동 생성
- **콘텐츠 유형 자동 분류**: A(비용/가격), B(시술과정), C(회복/주의사항), D(비교/선택)
- **환자 질문 기반 글쓰기**: 키워드 → 환자 질문 자동 정의 → 질문에 직접 답하는 구조
- SEO 품질 점수 자동 채점 (100점 만점, 80점 미만 재생성)
  - 키워드 구조 20점, 정보 완결성 20점, 분량 15점, SEO 구조 20점, 어조 15점, 면책 10점
- 홍보성 문구 자동 제거 (의료법 준수)
- 병원명 노출 금지 (정보 제공형 콘텐츠)
- 의료 면책 문구 자동 삽입
- 썸네일 자동 생성 및 콘텐츠 내 삽입
- 키워드 밀도 제어 (1,500자 기준 3~5회)

### Layer 3 — 발행 엔진 (Inblog JSON:API v1.0)
- **JSON:API 표준 준수**: OpenAPI 3.0.3 스펙 기반 완전한 인블로그 API 통합
- **GET /me**: API 키 검증 + subdomain/blog_id 자동 조회
- **POST /posts**: JSON:API `data.attributes` 형식 포스트 생성 (draft)
- **PATCH /posts/{id}/publish**: 즉시 발행 / 예약 발행 / 발행 취소
- **태그 자동 동기화**: 콘텐츠 태그 → Inblog 태그 자동 생성/매핑 (GET /tags, POST /tags, POST /posts/{id}/tags)
- **2단계 워크플로**: 포스트 생성(draft) → 발행(publish) 분리
- 실패 감지 → 최대 3회 자동 재시도
- 슬러그 중복 시 타임스탬프 자동 추가
- **자동 발행 모드**: cron에서 생성 즉시 발행까지 원스톱 처리

### 대시보드 (5개 화면)
1. **Dashboard** — 오늘 발행 현황, 주간 차트, 카테고리 분포, 예정 키워드, 실패 알림
2. **Keywords** — 키워드 DB 검색/필터/추가/삭제, 카테고리별 관리
3. **Schedule** — 발행 시간/건수 설정, 카테고리 배분 비율
4. **History** — 콘텐츠 생성 이력, 상태 필터, 미리보기, 수동 발행
5. **Settings** — API 키(검증 기능 포함), 병원 정보, 알림, 의료 면책 문구 관리

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/health` | 헬스체크 |
| GET | `/api/dashboard/stats` | 대시보드 통계 |
| GET | `/api/keywords?limit=&offset=&category=&search=` | 키워드 목록 |
| GET | `/api/keywords/stats` | 키워드 통계 |
| POST | `/api/keywords` | 키워드 추가 |
| PATCH | `/api/keywords/:id` | 키워드 수정 |
| DELETE | `/api/keywords/:id` | 키워드 삭제 |
| POST | `/api/keywords/pick` | 키워드 자동 선택 |
| GET | `/api/contents?limit=&status=` | 콘텐츠 목록 |
| GET | `/api/contents/:id` | 콘텐츠 상세 |
| POST | `/api/contents/generate` | AI 콘텐츠 생성 |
| POST | `/api/publish/verify` | **인블로그 API 키 검증 (GET /me)** |
| POST | `/api/publish/:contentId` | **인블로그 발행 (JSON:API)** |
| POST | `/api/publish/retry/:logId` | 발행 재시도 |
| GET | `/api/publish/tags` | 인블로그 태그 목록 조회 |
| GET | `/api/schedule` | 스케줄 조회 |
| PUT | `/api/schedule` | 스케줄 수정 |
| GET | `/api/settings` | 설정 조회 |
| PUT | `/api/settings` | 설정 일괄 저장 |
| POST | `/api/cron/generate` | 자동 콘텐츠 생성 + 선택적 자동 발행 |

## Inblog API 통합 상세

### 사용 중인 Inblog API 엔드포인트
| Inblog API | 용도 |
|---|---|
| `GET /me` | API 키 검증, subdomain/blog_id 조회 |
| `GET /tags` | 블로그 태그 목록 조회 |
| `POST /tags` | 새 태그 생성 |
| `POST /posts` | 포스트 생성 (draft, 태그 관계 포함) |
| `PATCH /posts/{id}/publish` | 즉시/예약 발행 |

### JSON:API 요청 형식 (POST /posts)
```json
{
  "jsonapi": { "version": "1.0" },
  "data": {
    "type": "posts",
    "attributes": {
      "title": "임플란트 비용 총정리 — 2026년 기준",
      "slug": "implant-cost-guide-2026",
      "description": "메타 설명",
      "content_html": "<h2>...</h2><p>...</p>",
      "meta_description": "120~160자",
      "published": false,
      "image": "https://..."
    },
    "relationships": {
      "tags": {
        "data": [
          { "type": "tags", "id": "123" },
          { "type": "tags", "id": "456" }
        ]
      }
    }
  }
}
```

## 데이터 모델

- **keywords** — 치과 키워드 DB (카테고리, 검색의도, 우선순위, 사용횟수)
- **contents** — 생성된 SEO 콘텐츠 (제목, 슬러그, 메타, HTML, 태그, FAQ, 썸네일, SEO점수)
- **publish_logs** — 발행 이력 (inblog_post_id, inblog_url, 상태, 재시도횟수, 에러메시지)
- **schedules** — 스케줄 설정 (발행건수, 시간, 카테고리 비율)
- **settings** — 사이트 설정 (API키, 병원정보, 알림)
- **daily_reports** — 일간 리포트

## 사용법

### 초기 설정
1. Settings 탭에서 **Claude API 키** 입력
2. Settings 탭에서 **인블로그 API 키** 입력 → **[검증]** 버튼으로 연결 확인
   - subdomain, blog_id, 권한(scopes) 자동 표시
   - 필수 권한: `posts:write`, `tags:read`, `tags:write`
3. Settings 탭에서 **병원 지역** 입력 (선택)
4. Schedule 탭에서 발행 건수/시간/카테고리 비율 설정

### 자동 발행
- Cloudflare Cron Trigger가 매일 06:50에 자동 실행
- 키워드 자동 선택 → AI 콘텐츠 생성 → SEO 점수 검증 → 썸네일 생성 → 태그 동기화 → 인블로그 발행
- 자동 발행 on/off는 Settings에서 토글

### 수동 생성
- 대시보드 우측 상단 [수동 생성] 버튼 클릭
- History 탭에서 생성된 콘텐츠 미리보기 및 수동 발행

## 콘텐츠 생성 규칙
- **환자 질문 기반**: 모든 글은 하나의 환자 질문에 답하는 구조
- **4가지 유형**: A(비용/가격), B(시술과정), C(회복/주의사항), D(비교/선택)
- **홍보성 문구 금지**: "최고", "최첨단", "합리적인 가격" 등 광고성 표현 제거
- **병원명 노출 금지**: 정보 제공형 콘텐츠로만 작성
- **의료법 준수 (YMYL)**: 효과 보장 금지, 비교 광고 금지, 비용 단정 금지
- **E-E-A-T 기준**: 경험/전문성/권위/신뢰 갖춘 콘텐츠
- **SEO 기준**: 제목 40~65자, 메타 120~160자, H2 4~6개, FAQ 5~7개, 본문 1,500자+

## 배포
- **플랫폼**: Cloudflare Pages
- **기술 스택**: Hono + TypeScript + Tailwind CSS + D1 + Claude API + Inblog API
- **Status**: ✅ Active
- **Last Updated**: 2026-03-22

## 다음 단계 (미구현)
- [ ] 실제 이미지 생성 API 연동 (현재 placeholder)
- [ ] Google Search Console 연동 (성과 추적 — Inblog API 지원)
- [ ] Analytics 연동 (트래픽/포스트 성과 — Inblog API 지원)
- [ ] Patient Signal 연동 (AI 검색 키워드 역추적)
- [ ] 이메일 알림 (Resend 연동)
- [ ] 멀티 병원 지원
- [ ] 페이션트퍼널 수강생 온보딩 화면
