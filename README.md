# 철의장재 PR 분석 AI Agent

## 프로젝트 개요
- **Name**: 철의장재 PR 분석 AI Agent (PoC Demo)
- **Goal**: AI Agent의 PR 분석 과정을 시각적으로 보여주는 데모 UI
- **Client**: 세창앰앤이 단가계약

## 주요 기능

### 1. PR 목록 관리
- 81건의 PR 데이터 표시
- 분석 상태별 표시 (미분석/분석중/완료/오류)
- 최종분류 결과 배지 표시

### 2. 3단계 분석 과정 시각화
- **STEP 1 (Input)**: PR 기본 정보 표시
- **STEP 2 (AI Agent 추론)**: Claude API 호출 과정
- **STEP 3 (Output)**: 분석 결과 및 근거

### 3. 통계 대시보드
- 총 분석 건수, 물량검토/견적대상/HITL필요 분류
- 자동처리율 계산

## 기술 스택
- **Backend**: Hono + Node.js (TypeScript)
- **Frontend**: TailwindCSS (CDN), Vanilla JavaScript
- **AI**: Claude API (claude-sonnet-4-20250514)
- **Deployment**: Railway / Cloudflare Pages

## API Endpoints

| Endpoint | Method | 설명 |
|----------|--------|------|
| `/api/pr-list` | GET | PR 목록 조회 |
| `/api/pr/:prNo` | GET | PR 상세 정보 |
| `/api/price-table` | GET | 단가테이블 정보 |
| `/api/statistics` | GET | 통계 정보 |
| `/api/prompts/:prNo` | GET | System/User Prompt |
| `/api/analyze/:prNo` | POST | 단건 분석 실행 |
| `/api/reset` | POST | 분석 결과 초기화 |

## 로컬 개발

```bash
# 의존성 설치
npm install

# 빌드
npm run build

# 개발 서버
npm run dev

# 프로덕션 실행
npm start
```

## 환경 변수

| 변수 | 설명 |
|------|------|
| `ANTHROPIC_API_KEY` | Claude API 키 (필수) |
| `PORT` | 서버 포트 (기본: 3000) |

## Railway 배포

### 1. GitHub 연동
1. Railway 대시보드에서 "New Project" 클릭
2. "Deploy from GitHub repo" 선택
3. 저장소 연결

### 2. 환경 변수 설정
Railway Variables 탭에서:
```
ANTHROPIC_API_KEY=your-api-key-here
PORT=3000
```

### 3. 자동 배포
- Push 시 자동 빌드 및 배포
- Dockerfile 기반 빌드

## Cloudflare Pages 배포 (대안)

```bash
# Cloudflare 빌드 및 배포
npm run build:cf
npm run deploy:cf

# Secret 설정
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name pr-analysis-agent
```

## 데이터 구조

### PR 데이터 (81건)
- 대표PR, 자재내역, 자재속성, 재질, 철의장유형코드 등

### 단가테이블 (7개 자재속성그룹)
- PQPA, PQPD, PQPG, PQPM, PQPS, PQPU, PQPC

### 철의장상세구분 코드
- B: 상선 기본(SS400)
- A: SUS304L(ANGLE, PLATE)
- S: SUS316L(ANGLE, PLATE)
- G: BENDING류(COVER류, BOX류)
- I: PIPE, SQ. TUBE, BEAM TYPE
- M: SUS316L(PIPE)
- N: CHECK PLATE 소요
- E: COAMING (SUS316L) - PQPC 전용

## 배포 상태
- **Platform**: Railway (권장) / Cloudflare Pages
- **Status**: 개발 완료
- **Last Updated**: 2026-01-26
