import { Hono } from 'hono'
import { cors } from 'hono/cors'

// 데이터 임포트
import { prData } from './pr-data.js'
import { reviewData } from './review-data.js'
import { priceTableRaw, priceCodeList, assetGroupCodeList } from './price-table.js'
import { drawingMapping } from './drawing-mapping.js'

type Bindings = {
  ANTHROPIC_API_KEY?: string
}

// 제작사-도장사 매핑 테이블 (도장사코드 포함)
const PAINTING_COMPANY_MAP: Record<string, { name: string; code: string }> = {
  "세창앰앤이(주)": { name: "대림에스엔피", code: "V484" },
  "(주)케이이엠": { name: "진명에프앤피", code: "V486" },
  "(주)동진테크": { name: "피에스산업", code: "V485" },
  "한빛이엔지": { name: "성원기업", code: "V487" },
  "한덕": { name: "대림에스엔피", code: "V484" }
}

// 협력사 코드 매핑
const COMPANY_CODE_MAP: Record<string, string> = {
  "세창앰앤이(주)": "SC001",
  "(주)케이이엠": "KEM01",
  "(주)동진테크": "DJ001",
  "한빛이엔지": "HB001",
  "한덕": "HD001"
}

// 유형코드별 시뮬레이션 단가 (PoC용 - 실제 서비스에서는 단가테이블에서 조회)
// 단가단위: KG당 단가 (원)
const TYPE_CODE_UNIT_PRICES: Record<string, number> = {
  "B": 15000,  // 상선 기본(SS400)
  "G": 22000,  // BENDING류/COVER류/BOX류
  "I": 28000,  // PIPE, SQ.TUBE, BEAM TYPE
  "N": 25000,  // CHECK PLATE 소요
  "A": 35000,  // SUS304L
  "S": 42000,  // SUS316L
  "M": 45000,  // SUS316L - PIPE
  "E": 40000   // COAMING (SUS316L)
}

// 시뮬레이션 중량 범위 (kg) - PoC용
const SIMULATED_WEIGHT_RANGE = { min: 50, max: 500 }

// 발주금액 계산 함수 (유형코드 기반)
function calculateOrderAmount(typeCode: string, materialNo: string): number {
  // 자재번호를 seed로 사용하여 일관된 중량 생성 (같은 자재는 항상 같은 금액)
  let seed = 0
  for (let i = 0; i < materialNo.length; i++) {
    seed += materialNo.charCodeAt(i)
  }
  const weight = SIMULATED_WEIGHT_RANGE.min + (seed % (SIMULATED_WEIGHT_RANGE.max - SIMULATED_WEIGHT_RANGE.min))
  const unitPrice = TYPE_CODE_UNIT_PRICES[typeCode] || TYPE_CODE_UNIT_PRICES["B"]
  return Math.round(weight * unitPrice)
}

// PO 번호 채번 클래스 (룰: 40 + YYMMDD + NN)
class PONumberGenerator {
  private sequence: number = 0
  private dateStr: string
  
  constructor() {
    const now = new Date()
    const yy = String(now.getFullYear()).slice(-2)
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    this.dateStr = `${yy}${mm}${dd}`
  }
  
  generate(): string {
    this.sequence++
    return `40${this.dateStr}${String(this.sequence).padStart(2, '0')}`
  }
  
  reset(): void {
    this.sequence = 0
  }
}

// ============================================================================
// 타입 정의
// ============================================================================

// Phase 1 결과 타입 (배치)
type Phase1BatchResult = {
  자재번호: string
  PR_NO?: string  // 대표PR 번호 추가
  계약단가존재: string
  계약단가_근거: string
  유형코드: string
  유형코드_적정여부: string
  권장코드: string
  유형코드_근거: string
  도장사경유: string
  도장사: string
  도장사_근거: string
  최종분류: string
  물량검토필요: string
  최종_근거: string
  // 원본 데이터 필드
  자재내역?: string
  자재속성?: string
  재질?: string
  업체명?: string
  철의장유형코드_원본?: string
  // 추가 필드 (아코디언 펼침용)
  발주수량?: number
  도급수량?: number
  중량단위?: string
  기본단가?: number
  발주금액?: number
  도장사코드?: string
  도면번호?: string
}

// Phase 2 결과 타입 (배치) - HITL 화면 개선을 위해 확장
type Phase2BatchResult = {
  자재번호: string
  PR_NO?: string  // 대표PR 번호 추가
  검토구분: string
  검증결과: string
  권장조치: string
  검증근거: string
  LLM_추론?: any
  // PR 정보 (HITL 화면용)
  자재내역?: string
  현재유형코드?: string
  변경요청코드?: string
  업체명?: string
  도면번호?: string
  발주금액?: number
  발주수량?: number
  도급수량?: number
  중량단위?: string
  기본단가?: number
  // Review 정보 (HITL 화면용)
  변경요청단가?: number
  변경유형코드명?: string
  // HITL 유형 구분
  HITL유형?: '협상필요' | 'Vision불일치' | '도면없음'
}

// PO 결과 타입
type POResult = {
  PO_번호: string
  PR_NO: string
  자재번호: string
  업체명: string
  발주금액: number
  발주일자: string
  발주상태: string
  검토구분: string
  검증결과: string
}

// Step 상태 타입
type StepStatus = 'pending' | 'processing' | 'completed' | 'error'

// 통합 실행 상태 (6단계로 확장)
type IntegratedRunState = {
  isRunning: boolean
  currentStep: number
  steps: {
    step1: { status: StepStatus; message: string; data?: any }
    step2: { status: StepStatus; message: string; data?: any }
    step3: { status: StepStatus; message: string; data?: any }
    step4: { status: StepStatus; message: string; data?: any }
    step5: { status: StepStatus; message: string; data?: any }  // PO 자동 생성
    step6: { status: StepStatus; message: string; data?: any }  // 최종 결과 요약
  }
  phase1Results: Phase1BatchResult[]
  phase2Results: Phase2BatchResult[]
  poResults: POResult[]  // PO 결과 추가
  summary?: {
    phase1: {
      총_분석건수: number
      물량검토대상: number
      견적대상: number
      유형코드_부적정: number
      도장사_경유: number
    }
    phase2: {
      총_검증건수: number
      확정: number
      HITL: number
      검토취소: number
    }
    po: {
      총_PO건수: number
      총_발주금액: number
    }
    자동처리율: string
  }
  error?: string
  startTime?: number
  endTime?: number
}

// 글로벌 상태
let integratedState: IntegratedRunState = {
  isRunning: false,
  currentStep: 0,
  steps: {
    step1: { status: 'pending', message: '' },
    step2: { status: 'pending', message: '' },
    step3: { status: 'pending', message: '' },
    step4: { status: 'pending', message: '' },
    step5: { status: 'pending', message: '' },
    step6: { status: 'pending', message: '' }
  },
  phase1Results: [],
  phase2Results: [],
  poResults: []
}

// PO 번호 생성기 인스턴스
let poGenerator = new PONumberGenerator()

const app = new Hono<{ Bindings: Bindings }>()

// CORS 설정
app.use('/api/*', cors())

// ============================================================================
// 배치 프롬프트 빌더 (PRD v5)
// ============================================================================

function buildBatchPhase1SystemPrompt(): string {
  return `당신은 조선소 철의장재 구매 업무를 지원하는 AI Agent입니다.

## 역할
여러 건의 PR(구매요청)을 한번에 분석하여 각 PR별로 다음 4가지를 판단합니다:
1. 계약단가 존재 여부
2. 철의장유형코드 적정성
3. 도장사 경유 여부 및 도장사 지정
4. 최종 발주 방식 결정

## Process 1: 계약단가 존재 확인
- 자재속성(자재속성그룹)이 단가테이블의 자재속성그룹 코드 목록에 존재하면 "Y", 아니면 "N"
- 단가테이블 자재속성그룹 코드: ${assetGroupCodeList.join(', ')}
- 예: PQPD → 존재(Y), FSGP → 미존재(N)

## Process 2: 철의장유형코드 검증
- B: 기본 상선 (Angle + Plate 단순 조합, PIPE SUPPORT)
- G: BENDING류/COVER류/BOX류 (밴딩, 커버, 박스, COAMING)
- I: PIPE/SQ.TUBE/BEAM TYPE (파이프 피스, 튜브)
- N: CHECK PLATE 소요
- A: SUS304L (재질 SUS304, STS304)
- S: SUS316L (재질 SUS316, STS316)
- M: SUS316L - PIPE
- E: COAMING (SUS316L)

검증 기준:
- "PIPE PIECE" 또는 "PIPE("가 포함 → I
- "COAMING", "COVER", "BOX", "BENDING" 포함 → G
- "PIPE SUPPORT"만 있으면 → B
- 재질 SUS304/STS304 → A
- 재질 SUS316/STS316 → S 또는 M(파이프)

## Process 3: 도장사 경유 판단
- 도장사경유여부가 "Y"이면 경유 Y
- "N" 또는 공란이면 경유 N
- 외부도장이 "N0"이면 경유 N

도장사 매핑:
- 세창앰앤이(주) → 대림에스엔피
- (주)케이이엠 → 진명에프앤피
- (주)동진테크 → 피에스산업
- 한빛이엔지 → 성원기업
- 한덕 → 대림에스엔피

## Process 4: 최종 분류
- 계약단가 미존재 → "견적대상"
- 계약단가 존재 → "물량검토대상"

## 응답 형식
반드시 JSON 배열로 응답하세요. 각 PR별 결과를 포함합니다.
\`\`\`json
[
    {
        "자재번호": "PR의 자재번호",
        "계약단가존재": "Y 또는 N",
        "계약단가_근거": "판단 이유",
        "유형코드": "추출된 유형코드",
        "유형코드_적정여부": "Y 또는 N",
        "권장코드": "부적정 시 권장 코드 (적정이면 빈 문자열)",
        "유형코드_근거": "판단 이유",
        "도장사경유": "Y 또는 N",
        "도장사": "지정된 도장사 (경유 N이면 빈 문자열)",
        "도장사_근거": "판단 이유",
        "최종분류": "물량검토대상 또는 견적대상",
        "물량검토필요": "Y 또는 N",
        "최종_근거": "종합 판단 이유"
    }
]
\`\`\``
}

function buildBatchPhase1UserPrompt(prList: any[]): string {
  const prDataForLLM = prList.map(pr => ({
    자재번호: String(pr['자재번호'] || ''),
    자재속성: String(pr['자재속성'] || ''),
    자재내역: String(pr['자재내역'] || '').substring(0, 100),
    재질: String(pr['재질'] || ''),
    철의장유형코드: String(pr['철의장유형코드'] || ''),
    업체명: String(pr['업체명'] || ''),
    도장사경유여부: String(pr['도장사경유여부'] || ''),
    외부도장: String(pr['외부도장'] || '')
  }))

  return `## 분석 대상 PR 리스트 (${prDataForLLM.length}건)

${JSON.stringify(prDataForLLM, null, 2)}

## 단가테이블 철의장상세구분 코드 목록
${priceCodeList.join(', ')}

위 ${prDataForLLM.length}건의 PR을 분석하여 각 PR별로 Process 1~4 결과를 JSON 배열로 응답하세요.`
}

// Vision 검증용 프롬프트
function buildVisionSystemPrompt(): string {
  return `당신은 조선소 철의장재 도면을 분석하여 단가유형을 판단하는 AI Agent입니다.

## 단가유형별 판단 기준
- B (기본 상선): 단순 Angle + Plate 조합, 밴딩/커버/파이프 특수 형상 없음
- G (BENDING류/COVER류): 점선 밴딩 표기, 커버/박스류 형태
- I (PIPE/TUBE TYPE): 원형 파이프 단면, PIPE 명기
- N (CHECK PLATE): CHECK PLATE 텍스트 표기
- A (SUS304L): SUS304/STS304 재질 명기
- S (SUS316L): SUS316/STS316 재질 명기

## 응답 형식
\`\`\`json
{
    "추론_단가유형": "B / G / I / N / A / S 중 하나",
    "신뢰도": "높음 / 중간 / 낮음",
    "판단근거": ["근거1", "근거2", "근거3"]
}
\`\`\``
}

function buildVisionUserPrompt(review: any, dwgNo: string): string {
  return `## 검증 대상
- DWG NO: ${dwgNo}
- 자재내역: ${review['자재내역'] || ''}
- 현재 유형코드: ${review['철의장유형코드'] || ''}
- 공급사 변경 요청코드: ${review['변경유형코드'] || ''}

도면을 분석하여 적정 단가유형을 판단하세요.`
}

// ============================================================================
// API: 데이터 조회
// ============================================================================

app.get('/api/pr-list', (c) => {
  const prList = (prData as any[]).map((pr, index) => ({
    index: index + 1,
    prNo: pr['대표PR'],
    자재번호: pr['자재번호'],
    자재내역: pr['자재내역'],
    자재속성: pr['자재속성'],
    업체명: pr['업체명'],
    철의장유형코드: pr['철의장유형코드'],
    status: 'pending'
  }))
  return c.json({ total: prList.length, data: prList })
})

app.get('/api/review-list', (c) => {
  const reviewList = (reviewData as any[]).map((review, index) => ({
    index: index + 1,
    prNo: review['PR'],
    자재번호: review['자재번호'],
    자재내역: review['자재내역'],
    검토구분: review['검토구분'],
    변경유형코드: review['변경유형코드'],
    변경요청단가: review['변경요청단가']
  }))
  return c.json({ total: reviewList.length, data: reviewList })
})

app.get('/api/price-table', (c) => {
  return c.json({
    total: priceTableRaw.length,
    codes: priceCodeList,
    data: priceTableRaw.slice(0, 20)
  })
})

// ============================================================================
// API: 통합 통계 (Healthcheck 호환)
// ============================================================================

app.get('/api/statistics', (c) => {
  const p1 = integratedState.phase1Results
  const p2 = integratedState.phase2Results
  
  return c.json({
    total: (prData as any[]).length,
    analyzed: p1.length,
    물량검토: p1.filter(r => r.최종분류 === '물량검토대상').length,
    견적대상: p1.filter(r => r.최종분류 === '견적대상').length,
    HITL필요: p2.filter(r => r.권장조치 === 'HITL').length,
    자동처리율: integratedState.summary?.자동처리율 || '0.0'
  })
})

app.get('/api/statistics/phase1', (c) => {
  const p1 = integratedState.phase1Results
  
  return c.json({
    total: (prData as any[]).length,
    analyzed: p1.length,
    물량검토: p1.filter(r => r.최종분류 === '물량검토대상').length,
    견적대상: p1.filter(r => r.최종분류 === '견적대상').length,
    유형코드부적정: p1.filter(r => r.유형코드_적정여부 === 'N').length,
    도장사경유: p1.filter(r => r.도장사경유 === 'Y').length
  })
})

app.get('/api/statistics/phase2', (c) => {
  const p2 = integratedState.phase2Results
  const 확정 = p2.filter(r => r.권장조치 === '확정').length
  const HITL = p2.filter(r => r.권장조치 === 'HITL').length
  const 검토취소 = p2.filter(r => r.권장조치 === '검토취소').length
  const verified = p2.length
  const 자동처리 = 확정 + 검토취소
  
  return c.json({
    total: (reviewData as any[]).length,
    verified,
    자동확정: 확정,
    HITL,
    검토취소,
    자동처리율: verified > 0 ? ((자동처리 / verified) * 100).toFixed(1) : '0.0'
  })
})

// ============================================================================
// API: 통합 실행 상태 조회
// ============================================================================

app.get('/api/integrated/state', (c) => {
  return c.json(integratedState)
})

// ============================================================================
// API: 통합 실행 (PRD v5 배치 처리)
// ============================================================================

app.post('/api/integrated/run-all', async (c) => {
  const apiKey = process.env.ANTHROPIC_API_KEY || c.env?.ANTHROPIC_API_KEY
  if (!apiKey) {
    return c.json({ 
      error: 'ANTHROPIC_API_KEY not configured',
      message: '환경 변수에 ANTHROPIC_API_KEY를 설정해주세요.'
    }, 500)
  }

  if (integratedState.isRunning) {
    return c.json({ error: '이미 실행 중입니다.' }, 400)
  }

  // 상태 초기화
  poGenerator = new PONumberGenerator()  // PO 채번기 초기화
  integratedState = {
    isRunning: true,
    currentStep: 1,
    startTime: Date.now(),
    steps: {
      step1: { status: 'processing', message: 'PR 검토 및 발주 방식 판단 중...' },
      step2: { status: 'pending', message: '' },
      step3: { status: 'pending', message: '' },
      step4: { status: 'pending', message: '' },
      step5: { status: 'pending', message: '' },
      step6: { status: 'pending', message: '' }
    },
    phase1Results: [],
    phase2Results: [],
    poResults: []
  }

  try {
    // ================================================================
    // Step 1: PR 검토 및 발주 방식 판단 (Process 1~4) - 배치 LLM 호출
    // ================================================================
    const prList = prData as any[]
    
    const phase1Response = await callClaudeBatch(
      apiKey, 
      buildBatchPhase1SystemPrompt(), 
      buildBatchPhase1UserPrompt(prList),
      8192
    )
    
    let phase1Results = parseJsonArrayResponse(phase1Response)
    
    // 원본 데이터와 병합 및 도장사 지정
    phase1Results = phase1Results.map((result: Phase1BatchResult, i: number) => {
      const pr = prList[i] || {}
      
      // 도장사 정보 가져오기
      const 제작사 = pr['업체명'] || ''
      const paintingInfo = PAINTING_COMPANY_MAP[제작사]
      
      // 도장사 지정 (경유 Y인 경우)
      if (result.도장사경유 === 'Y') {
        result.도장사 = paintingInfo?.name || '미지정'
      }
      
      // 유형코드 기반 발주금액 계산
      const typeCode = result.유형코드 || pr['철의장유형코드'] || 'B'
      const materialNo = result.자재번호 || ''
      const calculatedAmount = calculateOrderAmount(typeCode, materialNo)
      
      return {
        ...result,
        PR_NO: pr['대표PR'] || pr['PR'] || '',
        자재내역: pr['자재내역'],
        자재속성: pr['자재속성'],
        재질: pr['재질'],
        업체명: pr['업체명'],
        철의장유형코드_원본: pr['철의장유형코드'],
        // 추가 필드 (아코디언 펼침용)
        발주수량: pr['발주수량'] || 1,
        도급수량: pr['도급수량'] || 100,
        중량단위: pr['중량단위'] || 'KG',
        기본단가: pr['기본단가'] || TYPE_CODE_UNIT_PRICES[typeCode] || 15000,
        발주금액: calculatedAmount,
        도장사코드: paintingInfo?.code || '',
        도면번호: pr['도면번호'] || ''
      }
    })
    
    integratedState.phase1Results = phase1Results
    integratedState.steps.step1 = { 
      status: 'completed', 
      message: `분석 완료: ${phase1Results.length}건`,
      data: {
        물량검토대상: phase1Results.filter((r: Phase1BatchResult) => r.최종분류 === '물량검토대상').length,
        견적대상: phase1Results.filter((r: Phase1BatchResult) => r.최종분류 === '견적대상').length,
        유형코드_부적정: phase1Results.filter((r: Phase1BatchResult) => r.유형코드_적정여부 === 'N').length
      }
    }
    integratedState.currentStep = 2

    // ================================================================
    // Step 2: 협력사 물량검토 요청 (시뮬레이션)
    // ================================================================
    integratedState.steps.step2 = { status: 'processing', message: '협력사 물량검토 요청 중...' }
    
    // 협력사별 집계
    const companyTargets: Record<string, number> = {}
    const reviewTargets = phase1Results.filter((r: Phase1BatchResult) => r.최종분류 === '물량검토대상')
    
    for (const r of reviewTargets) {
      const company = r.업체명 || '미지정'
      companyTargets[company] = (companyTargets[company] || 0) + 1
    }
    
    // 시뮬레이션 대기 (실제로는 클라이언트에서 처리)
    integratedState.steps.step2 = { 
      status: 'completed', 
      message: '요청 완료',
      data: { 
        총요청건수: reviewTargets.length,
        협력사별: companyTargets 
      }
    }
    integratedState.currentStep = 3

    // ================================================================
    // Step 3: 물량검토 결과 수신 (시뮬레이션)
    // ================================================================
    integratedState.steps.step3 = { status: 'processing', message: '결과 수신 중...' }
    
    // ★★★ 중요: 물량검토대상 자재번호만 필터링하여 처리 ★★★
    // 견적대상(7건)은 물량검토 프로세스를 거치지 않음
    const reviewTargetMaterialNos = new Set(reviewTargets.map(r => r.자재번호))
    const reviewList = (reviewData as any[]).filter(r => reviewTargetMaterialNos.has(r['자재번호']))
    
    const reviewCounts: Record<string, number> = {}
    
    for (const r of reviewList) {
      const 검토구분 = r['검토구분'] || '기타'
      reviewCounts[검토구분] = (reviewCounts[검토구분] || 0) + 1
    }
    
    integratedState.steps.step3 = { 
      status: 'completed', 
      message: `수신 완료: ${reviewList.length}건`,
      data: { 
        총수신건수: reviewList.length,
        검토구분별: reviewCounts 
      }
    }
    integratedState.currentStep = 4

    // ================================================================
    // Step 4: 물량검토 결과 검증 (Process 5) - 배치
    // ================================================================
    integratedState.steps.step4 = { status: 'processing', message: '결과 검증 중...' }
    
    const phase2Results: Phase2BatchResult[] = []
    
    // 검토구분별 분류
    const unchanged = reviewList.filter((r: any) => r['검토구분'] === '단가유형미변경')
    const changed = reviewList.filter((r: any) => r['검토구분'] === '단가유형변경')
    const negotiation = reviewList.filter((r: any) => r['검토구분'] === '협상필요')
    const impossible = reviewList.filter((r: any) => r['검토구분'] === '제작불가')
    
    // 1. 단가유형미변경 - 일괄 자동 확정
    for (const review of unchanged) {
      const prInfo = phase1Results.find((p: Phase1BatchResult) => p.자재번호 === review['자재번호'])
      const typeCode = review['변경유형코드'] || review['철의장유형코드'] || prInfo?.유형코드 || 'B'
      const orderAmount = calculateOrderAmount(typeCode, review['자재번호'])
      
      phase2Results.push({
        자재번호: review['자재번호'],
        PR_NO: prInfo?.PR_NO || review['PR'] || '',
        검토구분: '단가유형미변경',
        검증결과: '적합',
        권장조치: '확정',
        검증근거: '공급사 검토 결과: 단가유형 미변경. 자동 확정 처리',
        // 업체명 및 발주금액 추가
        업체명: review['업체명'] || prInfo?.업체명 || '',
        자재내역: review['자재내역'] || prInfo?.자재내역 || '',
        현재유형코드: typeCode,
        발주금액: orderAmount
      })
    }
    
    // 2. 제작불가 - 일괄 자동 취소
    for (const review of impossible) {
      const prInfo = phase1Results.find((p: Phase1BatchResult) => p.자재번호 === review['자재번호'])
      phase2Results.push({
        자재번호: review['자재번호'],
        PR_NO: prInfo?.PR_NO || review['PR'] || '',
        검토구분: '제작불가',
        검증결과: '해당없음',
        권장조치: '검토취소',
        검증근거: '공급사 검토 결과: 제작불가. 자동 검토취소 처리',
        // 업체명 추가 (발주금액은 취소이므로 0)
        업체명: review['업체명'] || prInfo?.업체명 || '',
        자재내역: review['자재내역'] || prInfo?.자재내역 || '',
        발주금액: 0
      })
    }
    
    // 3. 협상필요 - 일괄 HITL
    for (const review of negotiation) {
      const requestPrice = review['변경요청단가'] || 0
      // PR 정보 조회 (자재번호로 조인)
      const prInfo = phase1Results.find((p: Phase1BatchResult) => p.자재번호 === review['자재번호'])
      const typeCode = review['변경유형코드'] || review['철의장유형코드'] || prInfo?.유형코드 || 'B'
      // 협상필요 건도 예상 발주금액 계산 (HITL이지만 참고용)
      const estimatedAmount = calculateOrderAmount(typeCode, review['자재번호'])
      
      phase2Results.push({
        자재번호: review['자재번호'],
        PR_NO: prInfo?.PR_NO || review['PR'] || '',
        검토구분: '협상필요',
        검증결과: '검토필요',
        권장조치: 'HITL',
        검증근거: `공급사 검토 결과: 협상필요. 요청단가 ${requestPrice.toLocaleString()}원. 담당자 검토 필요`,
        // PR 정보
        자재내역: prInfo?.자재내역 || review['자재내역'],
        현재유형코드: prInfo?.유형코드 || review['철의장유형코드'],
        변경요청코드: review['변경유형코드'],
        업체명: prInfo?.업체명 || review['업체명'],
        도면번호: review['도면번호'],
        // 발주금액 (예상)
        발주금액: estimatedAmount,
        // Review 정보
        변경요청단가: requestPrice,
        변경유형코드명: review['변경유형코드명'],
        // HITL 유형
        HITL유형: '협상필요'
      })
    }
    
    // 4. 단가유형변경 - Vision 검증 (개별 또는 텍스트 기반)
    for (const review of changed) {
      const dwgFull = String(review['도면번호'] || '')
      const dwgNo = dwgFull.length > 4 ? dwgFull.substring(4) : dwgFull
      const drawingInfo = (drawingMapping as any).index?.[dwgNo]
      
      const currentType = review['철의장유형코드'] || ''
      const changeType = review['변경유형코드'] || ''
      
      // PR 정보 조회 (자재번호로 조인)
      const prInfo = phase1Results.find((p: Phase1BatchResult) => p.자재번호 === review['자재번호'])
      
      // 발주금액 계산 (변경요청코드 기준)
      const orderAmount = calculateOrderAmount(changeType || currentType, review['자재번호'])
      
      // 공통 PR/Review 정보 (발주금액 포함)
      const commonInfo = {
        PR_NO: prInfo?.PR_NO || review['PR'] || '',
        자재내역: prInfo?.자재내역 || review['자재내역'],
        현재유형코드: currentType,
        변경요청코드: changeType,
        업체명: prInfo?.업체명 || review['업체명'],
        도면번호: review['도면번호'],
        변경유형코드명: review['변경유형코드명'],
        발주금액: orderAmount
      }
      
      if (drawingInfo) {
        // 도면 정보가 있으면 LLM Vision 검증 시뮬레이션
        // 실제 Vision API 호출 대신 규칙 기반 검증
        const llmType = inferTypeFromDrawing(review, drawingInfo)
        const llmResult = { 
          추론_단가유형: llmType, 
          신뢰도: changeType === llmType ? '높음' : '중간',
          판단근거: inferReasonFromDrawing(review, llmType)
        }
        
        if (changeType === llmType) {
          phase2Results.push({
            자재번호: review['자재번호'],
            검토구분: '단가유형변경',
            검증결과: '적합',
            권장조치: '확정',
            검증근거: `공급사 변경유형코드 '${changeType}'이 도면 분석 결과와 일치`,
            LLM_추론: llmResult,
            ...commonInfo
          })
        } else {
          phase2Results.push({
            자재번호: review['자재번호'],
            검토구분: '단가유형변경',
            검증결과: '부적합',
            권장조치: 'HITL',
            검증근거: `공급사 '${changeType}' ≠ 도면 분석 '${llmType}'. 담당자 검토 필요`,
            LLM_추론: llmResult,
            HITL유형: 'Vision불일치',
            ...commonInfo
          })
        }
      } else {
        // 도면 정보 없음 - 텍스트 기반 검증
        if (currentType === changeType) {
          phase2Results.push({
            자재번호: review['자재번호'],
            검토구분: '단가유형변경',
            검증결과: '적합',
            권장조치: '확정',
            검증근거: `유형코드 동일 (${currentType}). 세부 유형 변경으로 자동 확정`,
            ...commonInfo
          })
        } else {
          phase2Results.push({
            자재번호: review['자재번호'],
            검토구분: '단가유형변경',
            검증결과: '검토필요',
            권장조치: 'HITL',
            검증근거: `유형코드 변경 (${currentType} → ${changeType}). 도면 확인 필요`,
            HITL유형: '도면없음',
            ...commonInfo
          })
        }
      }
    }
    
    integratedState.phase2Results = phase2Results
    
    const step4Data = {
      자동확정: phase2Results.filter(r => r.권장조치 === '확정').length,
      HITL: phase2Results.filter(r => r.권장조치 === 'HITL').length,
      검토취소: phase2Results.filter(r => r.권장조치 === '검토취소').length
    }
    
    integratedState.steps.step4 = { 
      status: 'completed', 
      message: `검증 완료: ${phase2Results.length}건`,
      data: step4Data
    }
    integratedState.currentStep = 5

    // ================================================================
    // Step 5: PO 자동 생성 (확정 건에 대해)
    // ================================================================
    integratedState.steps.step5 = { status: 'processing', message: 'PO 자동 생성 중...' }
    
    const confirmedItems = phase2Results.filter(r => r.권장조치 === '확정')
    const poResults: POResult[] = []
    let totalOrderAmount = 0
    
    const now = new Date()
    const orderDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    
    for (const item of confirmedItems) {
      const poNumber = poGenerator.generate()
      const orderAmount = item.발주금액 || 0
      totalOrderAmount += orderAmount
      
      poResults.push({
        PO_번호: poNumber,
        PR_NO: item.PR_NO || '',
        자재번호: item.자재번호,
        업체명: item.업체명 || '',
        발주금액: orderAmount,
        발주일자: orderDate,
        발주상태: '발주완료',
        검토구분: item.검토구분,
        검증결과: item.검증결과
      })
    }
    
    integratedState.poResults = poResults
    integratedState.steps.step5 = { 
      status: 'completed', 
      message: `PO 생성 완료: ${poResults.length}건`,
      data: {
        총_PO건수: poResults.length,
        총_발주금액: totalOrderAmount
      }
    }
    integratedState.currentStep = 6

    // ================================================================
    // Step 6: 최종 결과 요약
    // ================================================================
    integratedState.steps.step6 = { status: 'processing', message: '결과 집계 중...' }
    
    const 확정 = phase2Results.filter(r => r.권장조치 === '확정').length
    const 검토취소 = phase2Results.filter(r => r.권장조치 === '검토취소').length
    const HITL = phase2Results.filter(r => r.권장조치 === 'HITL').length
    const 총검증 = phase2Results.length
    const 자동처리 = 확정 + 검토취소
    const 자동처리율 = 총검증 > 0 ? ((자동처리 / 총검증) * 100).toFixed(1) : '0.0'
    
    integratedState.summary = {
      phase1: {
        총_분석건수: phase1Results.length,
        물량검토대상: phase1Results.filter((r: Phase1BatchResult) => r.최종분류 === '물량검토대상').length,
        견적대상: phase1Results.filter((r: Phase1BatchResult) => r.최종분류 === '견적대상').length,
        유형코드_부적정: phase1Results.filter((r: Phase1BatchResult) => r.유형코드_적정여부 === 'N').length,
        도장사_경유: phase1Results.filter((r: Phase1BatchResult) => r.도장사경유 === 'Y').length
      },
      phase2: {
        총_검증건수: 총검증,
        확정,
        HITL,
        검토취소
      },
      po: {
        총_PO건수: poResults.length,
        총_발주금액: totalOrderAmount
      },
      자동처리율
    }
    
    integratedState.steps.step6 = { 
      status: 'completed', 
      message: `자동처리율: ${자동처리}/${총검증}건 (${자동처리율}%)`,
      data: integratedState.summary
    }
    
    integratedState.isRunning = false
    integratedState.endTime = Date.now()
    
    return c.json({
      success: true,
      message: '전체 프로세스 완료',
      state: integratedState,
      processingTime: integratedState.endTime - (integratedState.startTime || 0)
    })

  } catch (error: any) {
    integratedState.isRunning = false
    integratedState.error = error.message
    integratedState.steps[`step${integratedState.currentStep}` as keyof typeof integratedState.steps] = {
      status: 'error',
      message: error.message
    }
    
    return c.json({
      success: false,
      error: error.message,
      state: integratedState
    }, 500)
  }
})

// ============================================================================
// API: 초기화
// ============================================================================

app.post('/api/reset', (c) => {
  poGenerator = new PONumberGenerator()  // PO 채번기 초기화
  integratedState = {
    isRunning: false,
    currentStep: 0,
    steps: {
      step1: { status: 'pending', message: '' },
      step2: { status: 'pending', message: '' },
      step3: { status: 'pending', message: '' },
      step4: { status: 'pending', message: '' },
      step5: { status: 'pending', message: '' },
      step6: { status: 'pending', message: '' }
    },
    phase1Results: [],
    phase2Results: [],
    poResults: []
  }
  return c.json({ success: true, message: '모든 결과가 초기화되었습니다.' })
})

// ============================================================================
// 헬퍼 함수
// ============================================================================

async function callClaudeBatch(apiKey: string, systemPrompt: string, userPrompt: string, maxTokens: number = 4096): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`API Error: ${response.status} - ${errorText}`)
  }

  const data = await response.json() as any
  return data.content[0].text
}

function parseJsonArrayResponse(text: string): any[] {
  let jsonStr = text
  if (text.includes('```json')) {
    jsonStr = text.split('```json')[1].split('```')[0]
  } else if (text.includes('```')) {
    jsonStr = text.split('```')[1].split('```')[0]
  }
  return JSON.parse(jsonStr.trim())
}

function inferTypeFromDrawing(review: any, drawingInfo: any): string {
  // 규칙 기반 유형 추론 (실제 Vision 대신)
  const 자재내역 = String(review['자재내역'] || '').toUpperCase()
  const 재질 = String(review['재질'] || '').toUpperCase()
  
  if (자재내역.includes('PIPE PIECE') || 자재내역.includes('PIPE(')) {
    return 'I'
  }
  if (자재내역.includes('COAMING') || 자재내역.includes('COVER') || 
      자재내역.includes('BOX') || 자재내역.includes('BENDING')) {
    return 'G'
  }
  if (재질.includes('SUS304') || 재질.includes('STS304')) {
    return 'A'
  }
  if (재질.includes('SUS316') || 재질.includes('STS316')) {
    return 'S'
  }
  if (자재내역.includes('CHECK PLATE')) {
    return 'N'
  }
  return 'B'
}

function inferReasonFromDrawing(review: any, inferredType: string): string[] {
  // Vision 분석 근거 생성 (시뮬레이션)
  const 자재내역 = String(review['자재내역'] || '').toUpperCase()
  const 재질 = String(review['재질'] || '').toUpperCase()
  const reasons: string[] = []
  
  switch (inferredType) {
    case 'I':
      if (자재내역.includes('PIPE')) reasons.push('도면에 PIPE 형태 확인')
      reasons.push('원형 파이프 단면 구조')
      break
    case 'G':
      if (자재내역.includes('COAMING')) reasons.push('COAMING 형태 구조')
      if (자재내역.includes('COVER')) reasons.push('COVER/BOX류 형태')
      if (자재내역.includes('BENDING')) reasons.push('점선 밴딩 표기 확인')
      reasons.push('특수 형상 가공 필요')
      break
    case 'A':
      reasons.push('재질 SUS304 확인')
      reasons.push('스테인리스 재질 적용')
      break
    case 'S':
      reasons.push('재질 SUS316 확인')
      reasons.push('고내식성 스테인리스 적용')
      break
    case 'N':
      reasons.push('CHECK PLATE 텍스트 확인')
      reasons.push('미끄럼 방지 플레이트')
      break
    default:
      reasons.push('기본 Angle + Plate 조합')
      reasons.push('단순 구조물')
  }
  
  return reasons
}

// ============================================================================
// 메인 페이지 - HTML UI (PRD v5 통합 실행 화면)
// ============================================================================

app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>철의장재 PR-to-PO AI Agent PoC v5</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        .step-box { transition: all 0.3s; }
        .step-box.pending { background-color: #F3F4F6; border-color: #D1D5DB; }
        .step-box.processing { background-color: #FEF3C7; border-color: #F59E0B; animation: pulse 1.5s infinite; }
        .step-box.completed { background-color: #D1FAE5; border-color: #10B981; }
        .step-box.error { background-color: #FEE2E2; border-color: #EF4444; }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }
        
        .progress-bar { transition: width 0.5s ease-in-out; }
        
        .badge-물량검토 { background-color: #10B981; color: white; }
        .badge-견적대상 { background-color: #3B82F6; color: white; }
        .badge-확정 { background-color: #10B981; color: white; }
        .badge-HITL { background-color: #F59E0B; color: white; }
        .badge-검토취소 { background-color: #6B7280; color: white; }
        
        .stat-card { transition: transform 0.2s; }
        .stat-card:hover { transform: translateY(-2px); }
        
        .scrollbar-thin::-webkit-scrollbar { width: 6px; }
        .scrollbar-thin::-webkit-scrollbar-track { background: #f1f1f1; }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: #c1c1c1; border-radius: 3px; }
        
        .result-table { border-collapse: collapse; }
        .result-table th { background: #F9FAFB; }
        .result-table td, .result-table th { border: 1px solid #E5E7EB; padding: 8px 12px; }
    </style>
</head>
<body class="bg-gray-100 min-h-screen">
    <!-- Header -->
    <header class="bg-gradient-to-r from-indigo-700 to-purple-700 text-white px-6 py-4 shadow-lg">
        <div class="max-w-7xl mx-auto flex items-center justify-between">
            <div class="flex items-center space-x-4">
                <i class="fas fa-robot text-3xl"></i>
                <div>
                    <h1 class="text-xl font-bold">철의장재 PR-to-PO AI Agent</h1>
                    <p class="text-indigo-200 text-sm">PoC Demo v5 - 배치 처리 + 통합 실행</p>
                </div>
            </div>
            <div class="flex items-center space-x-3">
                <button id="btn-run-all" class="bg-white text-indigo-700 hover:bg-indigo-100 px-6 py-2.5 rounded-lg font-bold transition flex items-center space-x-2 shadow-md">
                    <i class="fas fa-play"></i>
                    <span>전체 실행</span>
                </button>
                <button id="btn-reset" class="bg-indigo-600 hover:bg-indigo-500 px-4 py-2.5 rounded-lg font-medium transition flex items-center space-x-2">
                    <i class="fas fa-redo"></i>
                    <span>초기화</span>
                </button>
            </div>
        </div>
    </header>

    <main class="max-w-7xl mx-auto p-6">
        <!-- 진행 상황 섹션 -->
        <section id="progress-section" class="bg-white rounded-xl shadow-md p-6 mb-6">
            <div class="flex items-center justify-between mb-4">
                <h2 class="text-lg font-bold text-gray-800 flex items-center">
                    <i class="fas fa-tasks mr-2 text-indigo-600"></i>
                    진행 상황
                </h2>
                <span id="overall-status" class="text-sm text-gray-500">대기 중</span>
            </div>
            
            <!-- 진행률 바 -->
            <div class="w-full bg-gray-200 rounded-full h-3 mb-6 overflow-hidden">
                <div id="progress-bar" class="progress-bar bg-gradient-to-r from-indigo-500 to-purple-500 h-3 rounded-full" style="width: 0%"></div>
            </div>
            
            <!-- 상단 흐름 요약 (물량검토대상 → 협력사요청 → 수신완료) -->
            <div id="flow-summary" class="hidden mb-6">
                <div class="flex items-center justify-center space-x-4 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-lg p-4">
                    <div class="text-center">
                        <div class="text-xs text-gray-500">물량검토대상</div>
                        <div class="text-2xl font-bold text-indigo-600" id="flow-review-target">-</div>
                        <div class="text-xs text-gray-400">건</div>
                    </div>
                    <div class="text-2xl text-gray-300"><i class="fas fa-arrow-right"></i></div>
                    <div class="text-center">
                        <div class="text-xs text-gray-500">협력사 요청</div>
                        <div class="text-2xl font-bold text-purple-600" id="flow-request">-</div>
                        <div class="text-xs text-gray-400">건</div>
                    </div>
                    <div class="text-2xl text-gray-300"><i class="fas fa-arrow-right"></i></div>
                    <div class="text-center">
                        <div class="text-xs text-gray-500">수신완료</div>
                        <div class="text-2xl font-bold text-green-600" id="flow-received">-</div>
                        <div class="text-xs text-gray-400">건</div>
                    </div>
                </div>
            </div>
            
            <!-- Step 목록 (6단계) -->
            <div class="grid grid-cols-6 gap-3">
                <!-- Step 1 -->
                <div id="step-1" class="step-box pending border-2 rounded-lg p-3">
                    <div class="flex items-center mb-2">
                        <span id="step-1-icon" class="w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center text-white font-bold mr-2 text-sm">1</span>
                        <div>
                            <p class="text-xs text-gray-500">PR 검토 및 발주 방식 판단</p>
                        </div>
                    </div>
                    <p id="step-1-message" class="text-xs text-gray-400 mt-1">대기</p>
                </div>
                
                <!-- Step 2 -->
                <div id="step-2" class="step-box pending border-2 rounded-lg p-3">
                    <div class="flex items-center mb-2">
                        <span id="step-2-icon" class="w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center text-white font-bold mr-2 text-sm">2</span>
                        <div>
                            <p class="text-xs text-gray-500">협력사 물량검토 요청</p>
                        </div>
                    </div>
                    <p id="step-2-message" class="text-xs text-gray-400 mt-1">대기</p>
                </div>
                
                <!-- Step 3 -->
                <div id="step-3" class="step-box pending border-2 rounded-lg p-3">
                    <div class="flex items-center mb-2">
                        <span id="step-3-icon" class="w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center text-white font-bold mr-2 text-sm">3</span>
                        <div>
                            <p class="text-xs text-gray-500">협력사 물량검토 결과 수신</p>
                        </div>
                    </div>
                    <p id="step-3-message" class="text-xs text-gray-400 mt-1">대기</p>
                </div>
                
                <!-- Step 4 -->
                <div id="step-4" class="step-box pending border-2 rounded-lg p-3">
                    <div class="flex items-center mb-2">
                        <span id="step-4-icon" class="w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center text-white font-bold mr-2 text-sm">4</span>
                        <div>
                            <p class="text-xs text-gray-500">협력사 물량검토 결과 검증</p>
                        </div>
                    </div>
                    <p id="step-4-message" class="text-xs text-gray-400 mt-1">대기</p>
                </div>
                
                <!-- Step 5: PO 자동 생성 -->
                <div id="step-5" class="step-box pending border-2 rounded-lg p-3">
                    <div class="flex items-center mb-2">
                        <span id="step-5-icon" class="w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center text-white font-bold mr-2 text-sm">5</span>
                        <div>
                            <p class="text-xs text-gray-500">PO 자동 생성</p>
                        </div>
                    </div>
                    <p id="step-5-message" class="text-xs text-gray-400 mt-1">대기</p>
                </div>
                
                <!-- Step 6: 최종 결과 요약 -->
                <div id="step-6" class="step-box pending border-2 rounded-lg p-3">
                    <div class="flex items-center mb-2">
                        <span id="step-6-icon" class="w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center text-white font-bold mr-2 text-sm">6</span>
                        <div>
                            <p class="text-xs text-gray-500">최종 결과 요약</p>
                        </div>
                    </div>
                    <p id="step-6-message" class="text-xs text-gray-400 mt-1">대기</p>
                </div>
            </div>
        </section>
        
        <!-- AI Agent 처리 로그 패널 -->
        <section id="log-section" class="hidden bg-gray-900 rounded-xl shadow-lg mb-6 overflow-hidden">
            <div class="bg-gray-800 px-4 py-3 flex items-center justify-between border-b border-gray-700">
                <div class="flex items-center space-x-2">
                    <i class="fas fa-robot text-green-400"></i>
                    <span class="text-white font-medium text-sm">AI Agent 처리 로그</span>
                </div>
                <button id="btn-clear-log" class="text-gray-400 hover:text-white text-xs">
                    <i class="fas fa-trash mr-1"></i>로그 지우기
                </button>
            </div>
            <div id="log-container" class="h-64 overflow-y-auto p-4 font-mono text-xs leading-relaxed scrollbar-thin" style="scrollbar-color: #4B5563 #1F2937;">
                <div class="text-gray-500">로그가 여기에 표시됩니다...</div>
            </div>
        </section>
        
        <!-- =============================================== -->
        <!-- 순차적 결과 표시 영역 (Step별 완료 후 나타남) -->
        <!-- =============================================== -->
        
        <!-- PR 검토 결과 (PR 검토 및 발주 방식 판단 완료 후 표시) -->
        <section id="phase1-inline-section" class="hidden bg-white rounded-xl shadow-md mb-6 overflow-hidden">
            <div class="bg-gradient-to-r from-indigo-500 to-indigo-600 px-4 py-3 flex items-center justify-between">
                <div class="flex items-center space-x-2 text-white">
                    <i class="fas fa-search"></i>
                    <span class="font-semibold">PR 검토 및 발주 방식 판단 결과</span>
                </div>
                <div class="flex items-center space-x-4 text-white text-sm">
                    <span>물량검토: <strong id="p1i-review">0</strong>건</span>
                    <span>견적대상: <strong id="p1i-quote">0</strong>건</span>
                </div>
            </div>
            <div id="phase1-inline-content" class="p-4 max-h-72 overflow-auto scrollbar-thin">
                <table class="result-table w-full text-xs">
                    <thead>
                        <tr>
                            <th>자재번호</th>
                            <th>PR NO</th>
                            <th>계약단가</th>
                            <th>유형코드</th>
                            <th>적정성</th>
                            <th>권장코드</th>
                            <th>도장경유</th>
                            <th>최종분류</th>
                        </tr>
                    </thead>
                    <tbody id="phase1-inline-body">
                    </tbody>
                </table>
            </div>
        </section>
        
        <!-- 협력사 물량검토 현황판 (협력사 물량검토 요청 완료 후 표시) - 아코디언 UI -->
        <section id="company-status-section" class="hidden bg-white rounded-xl shadow-md mb-6 overflow-hidden">
            <div class="bg-gradient-to-r from-purple-500 to-purple-600 px-4 py-3 flex items-center justify-between">
                <div class="flex items-center space-x-2 text-white">
                    <i class="fas fa-industry"></i>
                    <span class="font-semibold">협력사 물량검토 현황</span>
                </div>
                <div class="text-white text-sm">
                    요청 완료: <strong id="cs-total-request">0</strong>건
                </div>
            </div>
            <div class="p-4">
                <!-- 협력사 현황 테이블 (아코디언 지원) -->
                <table class="result-table w-full text-sm">
                    <thead>
                        <tr>
                            <th class="text-center w-8"></th>
                            <th class="text-left">협력사코드</th>
                            <th class="text-left">협력사명</th>
                            <th class="text-center">요청건수</th>
                            <th class="text-center">수신건수</th>
                            <th class="text-center">상태</th>
                            <th class="text-center">도장사코드</th>
                            <th class="text-left">도장사지정업체</th>
                            <th class="text-right">예상발주금액</th>
                        </tr>
                    </thead>
                    <tbody id="company-status-body">
                    </tbody>
                </table>
            </div>
        </section>
        
        <!-- 물량검토 검증 결과 (협력사 물량검토 결과 검증 완료 후 표시) -->
        <section id="phase2-inline-section" class="hidden bg-white rounded-xl shadow-md mb-6 overflow-hidden">
            <div class="bg-gradient-to-r from-emerald-500 to-emerald-600 px-4 py-3 flex items-center justify-between">
                <div class="flex items-center space-x-2 text-white">
                    <i class="fas fa-check-double"></i>
                    <span class="font-semibold">협력사 물량검토 결과 검증</span>
                </div>
                <div class="flex items-center space-x-4 text-white text-sm">
                    <span>확정: <strong id="p2i-confirmed">0</strong>건</span>
                    <span>HITL: <strong id="p2i-hitl">0</strong>건</span>
                    <span>취소: <strong id="p2i-canceled">0</strong>건</span>
                </div>
            </div>
            <div id="phase2-inline-content" class="p-4 max-h-72 overflow-auto scrollbar-thin">
                <table class="result-table w-full text-xs">
                    <thead>
                        <tr>
                            <th>자재번호</th>
                            <th>PR NO</th>
                            <th>검토구분</th>
                            <th>검증결과</th>
                            <th>권장조치</th>
                            <th>검증근거</th>
                        </tr>
                    </thead>
                    <tbody id="phase2-inline-body">
                    </tbody>
                </table>
            </div>
        </section>
        
        <!-- PO 자동 생성 결과 (PO 자동 생성 완료 후 표시) -->
        <section id="po-generation-section" class="hidden bg-white rounded-xl shadow-md mb-6 overflow-hidden">
            <div class="bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-3 flex items-center justify-between">
                <div class="flex items-center space-x-2 text-white">
                    <i class="fas fa-file-invoice-dollar"></i>
                    <span class="font-semibold">PO 자동 생성 결과</span>
                </div>
                <div class="flex items-center space-x-4 text-white text-sm">
                    <span>총 PO: <strong id="po-total-count">0</strong>건</span>
                    <span>총 발주금액: <strong id="po-total-amount">0</strong>원</span>
                </div>
            </div>
            <div id="po-generation-content" class="p-4 max-h-72 overflow-auto scrollbar-thin">
                <table class="result-table w-full text-xs">
                    <thead>
                        <tr>
                            <th>PO 번호</th>
                            <th>PR NO</th>
                            <th>자재번호</th>
                            <th>협력사</th>
                            <th class="text-right">발주금액</th>
                            <th class="text-center">상태</th>
                        </tr>
                    </thead>
                    <tbody id="po-table-body">
                    </tbody>
                </table>
            </div>
        </section>
        
        <!-- 결과 요약 섹션 (완료 시 표시) -->
        <section id="summary-section" class="hidden">
            <!-- HITL 필요 건 목록 -->
            <div id="hitl-section" class="bg-white rounded-xl shadow-md p-6 mb-6">
                <h3 class="text-lg font-bold text-gray-800 mb-4 flex items-center">
                    <i class="fas fa-user-cog mr-2 text-yellow-600"></i>
                    HITL 필요 건 (<span id="hitl-count">0</span>건) - 담당자 검토 필요
                </h3>
                
                <!-- HITL 유형별 필터 탭 -->
                <div class="flex space-x-2 mb-4 border-b">
                    <button id="hitl-filter-all" class="px-4 py-2 text-sm font-medium text-indigo-600 border-b-2 border-indigo-600">전체</button>
                    <button id="hitl-filter-negotiation" class="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700">협상필요</button>
                    <button id="hitl-filter-vision" class="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700">Vision 불일치</button>
                    <button id="hitl-filter-nodrawing" class="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700">도면 없음</button>
                </div>
                
                <div id="hitl-list" class="space-y-4 max-h-[600px] overflow-y-auto scrollbar-thin">
                </div>
            </div>
            
            <!-- 상세 결과 탭 -->
            <div class="bg-white rounded-xl shadow-md overflow-hidden">
                <div class="flex border-b">
                    <button id="tab-phase1-results" class="flex-1 py-3 px-4 text-center font-medium text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50">
                        PR 검토 결과
                    </button>
                    <button id="tab-phase2-results" class="flex-1 py-3 px-4 text-center font-medium text-gray-500 hover:bg-gray-50">
                        물량검토 검증 결과
                    </button>
                </div>
                
                <div id="phase1-results-content" class="p-4 max-h-96 overflow-auto scrollbar-thin">
                    <table class="result-table w-full text-xs">
                        <thead>
                            <tr>
                                <th>자재번호</th>
                                <th>PR NO</th>
                                <th>계약단가</th>
                                <th>유형코드</th>
                                <th>적정성</th>
                                <th>권장코드</th>
                                <th>도장경유</th>
                                <th>최종분류</th>
                            </tr>
                        </thead>
                        <tbody id="phase1-table-body">
                        </tbody>
                    </table>
                </div>
                
                <div id="phase2-results-content" class="hidden p-4 max-h-96 overflow-auto scrollbar-thin">
                    <table class="result-table w-full text-xs">
                        <thead>
                            <tr>
                                <th>자재번호</th>
                                <th>PR NO</th>
                                <th>검토구분</th>
                                <th>검증결과</th>
                                <th>권장조치</th>
                                <th>검증근거</th>
                            </tr>
                        </thead>
                        <tbody id="phase2-table-body">
                        </tbody>
                    </table>
                </div>
            </div>
        </section>

        <!-- 초기 상태 (실행 전) -->
        <section id="initial-section" class="text-center py-16">
            <div class="inline-block p-8 bg-white rounded-2xl shadow-lg">
                <i class="fas fa-rocket text-6xl text-indigo-500 mb-4"></i>
                <h2 class="text-2xl font-bold text-gray-800 mb-2">전체 실행 준비 완료</h2>
                <p class="text-gray-500 mb-6">버튼을 클릭하면 전체 Work Process가 자동으로 연속 실행됩니다</p>
                <div class="flex justify-center space-x-8 text-sm text-gray-600">
                    <div class="flex items-center">
                        <i class="fas fa-database mr-2 text-indigo-500"></i>
                        PR 데이터: <span class="font-bold ml-1">20</span>건
                    </div>
                    <div class="flex items-center">
                        <i class="fas fa-clipboard-check mr-2 text-purple-500"></i>
                        물량검토 결과: <span class="font-bold ml-1">20</span>건
                    </div>
                </div>
                <button id="btn-run-all-center" class="mt-6 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white px-8 py-3 rounded-lg font-bold transition shadow-lg">
                    <i class="fas fa-play mr-2"></i>
                    전체 실행 시작
                </button>
            </div>
        </section>
    </main>

    <script>
        // ====================================================================
        // State
        // ====================================================================
        let isRunning = false;
        let currentState = null;

        // ====================================================================
        // DOM Elements
        // ====================================================================
        const btnRunAll = document.getElementById('btn-run-all');
        const btnRunAllCenter = document.getElementById('btn-run-all-center');
        const btnReset = document.getElementById('btn-reset');
        const progressBar = document.getElementById('progress-bar');
        const overallStatus = document.getElementById('overall-status');
        const initialSection = document.getElementById('initial-section');
        const summarySection = document.getElementById('summary-section');
        
        // Tab elements
        const tabPhase1Results = document.getElementById('tab-phase1-results');
        const tabPhase2Results = document.getElementById('tab-phase2-results');
        const phase1ResultsContent = document.getElementById('phase1-results-content');
        const phase2ResultsContent = document.getElementById('phase2-results-content');
        
        // Log elements
        const logSection = document.getElementById('log-section');
        const logContainer = document.getElementById('log-container');
        const btnClearLog = document.getElementById('btn-clear-log');

        // ====================================================================
        // Log Functions
        // ====================================================================
        function getTimestamp() {
            const now = new Date();
            return now.toTimeString().substring(0, 8);
        }
        
        function addLog(message, type = 'info', indent = 0) {
            const timestamp = getTimestamp();
            const indentStr = indent > 0 ? '&nbsp;&nbsp;'.repeat(indent) + '└ ' : '';
            
            let colorClass = 'text-gray-300';
            let icon = '';
            
            if (type === 'success') {
                colorClass = 'text-green-400';
                icon = '✅ ';
            } else if (type === 'warning') {
                colorClass = 'text-yellow-400';
                icon = '⚠️ ';
            } else if (type === 'error') {
                colorClass = 'text-red-400';
                icon = '❌ ';
            } else if (type === 'processing') {
                colorClass = 'text-blue-400';
                icon = '🔍 ';
            } else if (type === 'header') {
                colorClass = 'text-white font-semibold';
            } else if (type === 'divider') {
                logContainer.innerHTML += '<div class="text-gray-600 my-2">────────────────────────────────────────────────</div>';
                return;
            }
            
            const logEntry = '<div class="' + colorClass + '">' +
                '<span class="text-gray-500">[' + timestamp + ']</span> ' +
                indentStr + icon + message +
                '</div>';
            
            logContainer.innerHTML += logEntry;
            logContainer.scrollTop = logContainer.scrollHeight;
        }
        
        function clearLog() {
            logContainer.innerHTML = '<div class="text-gray-500">로그가 여기에 표시됩니다...</div>';
        }

        // ====================================================================
        // Initialize
        // ====================================================================
        async function init() {
            // 초기 상태 확인
            const response = await fetch('/api/integrated/state');
            const state = await response.json();
            
            if (state.phase1Results && state.phase1Results.length > 0) {
                currentState = state;
                updateUI(state);
                showSummary();
            }
            
            setupEventListeners();
        }

        // ====================================================================
        // Event Listeners
        // ====================================================================
        function setupEventListeners() {
            btnRunAll.addEventListener('click', runAll);
            btnRunAllCenter.addEventListener('click', runAll);
            btnReset.addEventListener('click', resetAll);
            btnClearLog.addEventListener('click', clearLog);
            
            tabPhase1Results.addEventListener('click', () => switchResultTab('phase1'));
            tabPhase2Results.addEventListener('click', () => switchResultTab('phase2'));
        }

        // ====================================================================
        // Run All
        // ====================================================================
        async function runAll() {
            if (isRunning) return;
            
            isRunning = true;
            btnRunAll.disabled = true;
            btnRunAll.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>실행 중...</span>';
            btnRunAllCenter.classList.add('hidden');
            initialSection.classList.add('hidden');
            summarySection.classList.add('hidden');
            
            // 로그 패널 표시 및 초기화
            logSection.classList.remove('hidden');
            clearLog();
            
            // Step 초기화 (6단계)
            for (let i = 1; i <= 6; i++) {
                updateStepUI(i, 'pending', '대기');
            }
            updateProgressBar(0);
            overallStatus.textContent = '실행 중...';
            
            // 순차적 결과 영역 숨기기
            document.getElementById('phase1-inline-section').classList.add('hidden');
            document.getElementById('company-status-section').classList.add('hidden');
            document.getElementById('phase2-inline-section').classList.add('hidden');
            document.getElementById('po-generation-section').classList.add('hidden');
            
            try {
                // Step 1 시작
                updateStepUI(1, 'processing', 'PR 검토 및 발주 방식 판단 중... (배치 LLM 호출)');
                updateProgressBar(10);
                
                addLog('PR 검토 및 발주 방식 판단 시작', 'header');
                addLog('분석 대상: 20건', 'info', 1);
                addLog('PR 자재별 계약 여부 판별 중...', 'info', 1);
                
                const response = await fetch('/api/integrated/run-all', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    currentState = result.state;
                    
                    // 순차적으로 Step UI 업데이트 (시각적 효과)
                    await animateSteps(result.state);
                    
                    showSummary();
                    overallStatus.textContent = '완료 (' + (result.processingTime / 1000).toFixed(1) + '초)';
                } else {
                    throw new Error(result.error);
                }
            } catch (error) {
                console.error('Error:', error);
                overallStatus.textContent = '오류 발생: ' + error.message;
                addLog('오류 발생: ' + error.message, 'error');
                const currentStep = currentState?.currentStep || 1;
                updateStepUI(currentStep, 'error', '오류: ' + error.message);
            }
            
            isRunning = false;
            btnRunAll.disabled = false;
            btnRunAll.innerHTML = '<i class="fas fa-play"></i> <span>전체 실행</span>';
        }

        async function animateSteps(state) {
            // 흐름 요약 표시
            const flowSummary = document.getElementById('flow-summary');
            flowSummary.classList.remove('hidden');
            
            // Step 1 완료 로그
            addLog('철의장유형코드 검증/수정 중...', 'info', 1);
            await sleep(200);
            addLog('도장사 경유 및 지정 중...', 'info', 1);
            await sleep(200);
            addLog('발주 방식 결정 중...', 'info', 1);
            await sleep(200);
            addLog('분석 완료: ' + state.phase1Results.length + '건', 'success', 1);
            
            updateStepUI(1, 'completed', 
                '분석 완료: ' + state.steps.step1.data.물량검토대상 + '건 물량검토, ' + 
                state.steps.step1.data.유형코드_부적정 + '건 유형코드 부적정'
            );
            updateProgressBar(20);
            
            // 흐름 요약 - 물량검토대상 업데이트
            document.getElementById('flow-review-target').textContent = state.steps.step1.data.물량검토대상;
            
            // ★ Step 1 완료 후 Phase 1 결과 테이블 표시
            renderPhase1Inline(state);
            await sleep(300);
            
            // Step 2
            addLog('', 'divider');
            addLog('협력사 물량검토 요청', 'header');
            addLog('물량검토 대상: ' + state.steps.step2.data.총요청건수 + '건', 'info', 1);
            
            updateStepUI(2, 'processing', '협력사 물량검토 요청 중...');
            
            // 협력사별 요청 로그
            const companies = state.steps.step2.data.협력사별 || {};
            for (const company in companies) {
                await sleep(150);
                addLog(company + ': ' + companies[company] + '건 → 요청 완료', 'success', 1);
            }
            
            updateStepUI(2, 'completed', 
                '요청 완료: ' + state.steps.step2.data.총요청건수 + '건'
            );
            updateProgressBar(40);
            
            // 흐름 요약 - 협력사 요청 업데이트
            document.getElementById('flow-request').textContent = state.steps.step2.data.총요청건수;
            
            // ★ Step 2 완료 후 협력사 현황판 표시
            renderCompanyStatus(state);
            await sleep(300);
            
            // Step 3
            addLog('', 'divider');
            addLog('협력사 물량검토 결과 수신', 'header');
            updateStepUI(3, 'processing', '결과 수신 중...');
            await sleep(300);
            
            addLog('📥 수신 완료: ' + state.steps.step3.data.총수신건수 + '건', 'info', 1);
            
            // 검토구분별 로그
            const reviewTypes = state.steps.step3.data.검토구분별 || {};
            for (const type in reviewTypes) {
                addLog(type + ': ' + reviewTypes[type] + '건', 'info', 1);
            }
            
            updateStepUI(3, 'completed', 
                '수신 완료: ' + state.steps.step3.data.총수신건수 + '건'
            );
            updateProgressBar(60);
            
            // 흐름 요약 - 수신완료 업데이트
            document.getElementById('flow-received').textContent = state.steps.step3.data.총수신건수;
            
            // 협력사 현황판 상태 업데이트 (수신완료로)
            updateCompanyStatusReceived(state);
            await sleep(300);
            
            // Step 4
            addLog('', 'divider');
            addLog('협력사 물량검토 결과 검증', 'header');
            addLog('검증 대상: ' + state.phase2Results.length + '건', 'info', 1);
            
            updateStepUI(4, 'processing', '결과 검증 중...');
            await sleep(200);
            
            // 검토구분별 처리 결과
            const unchanged = state.phase2Results.filter(function(r) { return r.검토구분 === '단가유형미변경'; });
            const impossible = state.phase2Results.filter(function(r) { return r.검토구분 === '제작불가'; });
            const negotiation = state.phase2Results.filter(function(r) { return r.검토구분 === '협상필요'; });
            const changed = state.phase2Results.filter(function(r) { return r.검토구분 === '단가유형변경'; });
            
            if (unchanged.length > 0) {
                addLog('단가유형미변경 ' + unchanged.length + '건 → 자동 확정', 'success', 1);
            }
            await sleep(150);
            
            if (impossible.length > 0) {
                addLog('제작불가 ' + impossible.length + '건 → 자동 취소', 'success', 1);
            }
            await sleep(150);
            
            if (negotiation.length > 0) {
                addLog('협상필요 ' + negotiation.length + '건 → HITL', 'warning', 1);
            }
            await sleep(150);
            
            if (changed.length > 0) {
                addLog('단가유형변경 Vision 검증 중... (' + changed.length + '건)', 'processing', 1);
                await sleep(200);
                
                // 단가유형변경 상세 로그
                for (const item of changed) {
                    await sleep(100);
                    const shortId = (item.자재번호 || '').substring(0, 15);
                    if (item.권장조치 === '확정') {
                        addLog(shortId + ': ' + (item.현재유형코드 || '-') + ' → ' + (item.변경요청코드 || '-') + ' 도면 일치', 'success', 2);
                    } else if (item.HITL유형 === 'Vision불일치') {
                        addLog(shortId + ': 공급사 [' + (item.변경요청코드 || '-') + '] ≠ 도면 분석 → HITL', 'error', 2);
                    } else {
                        addLog(shortId + ': 도면 없음 → HITL', 'warning', 2);
                    }
                }
            }
            
            addLog('검증 완료: ' + state.phase2Results.length + '건', 'success', 1);
            
            updateStepUI(4, 'completed', 
                '검증 완료: ' + state.steps.step4.data.자동확정 + '건 확정, ' + 
                state.steps.step4.data.HITL + '건 HITL'
            );
            updateProgressBar(67);
            
            // ★ Step 4 완료 후 Phase 2 결과 테이블 표시
            renderPhase2Inline(state);
            await sleep(300);
            
            // Step 5: PO 자동 생성
            addLog('', 'divider');
            addLog('PO 자동 생성', 'header');
            updateStepUI(5, 'processing', 'PO 자동 생성 중...');
            await sleep(200);
            
            const poResults = state.poResults || [];
            const totalPOAmount = state.summary?.po?.총_발주금액 || 0;
            
            addLog('PO 생성 대상: ' + poResults.length + '건 (확정 건)', 'info', 1);
            
            // PO 생성 상세 로그
            for (const po of poResults.slice(0, 5)) {  // 처음 5개만 로그
                await sleep(80);
                addLog('PR ' + (po.PR_NO || '-') + ' → ' + po.PO_번호 + ' 생성', 'success', 1);
            }
            if (poResults.length > 5) {
                addLog('... 외 ' + (poResults.length - 5) + '건 PO 생성', 'info', 1);
            }
            
            addLog('💰 총 발주금액: ' + totalPOAmount.toLocaleString() + '원', 'success', 1);
            
            updateStepUI(5, 'completed', state.steps.step5.message);
            updateProgressBar(84);
            
            // ★ Step 5 완료 후 PO 생성 결과 테이블 표시
            renderPOTable(state);
            await sleep(300);
            
            // Step 6: 최종 결과 요약
            addLog('', 'divider');
            addLog('최종 결과 요약', 'header');
            updateStepUI(6, 'processing', '결과 집계 중...');
            await sleep(200);
            
            const autoRate = state.summary?.자동처리율 || '0.0';
            const autoCount = (state.summary?.phase2?.확정 || 0) + (state.summary?.phase2?.검토취소 || 0);
            const totalCount = state.summary?.phase2?.총_검증건수 || 0;
            const hitlCount = state.summary?.phase2?.HITL || 0;
            
            addLog('📊 자동처리율: ' + autoCount + '/' + totalCount + '건 (' + autoRate + '%)', 'success');
            addLog('📦 PO 자동생성: ' + poResults.length + '건 / ' + totalPOAmount.toLocaleString() + '원', 'success');
            addLog('⚠️ HITL 필요: ' + hitlCount + '건', hitlCount > 0 ? 'warning' : 'info');
            
            updateStepUI(6, 'completed', state.steps.step6.message);
            updateProgressBar(100);
        }
        
        // ====================================================================
        // 순차적 결과 렌더링 함수
        // ====================================================================
        function renderPhase1Inline(state) {
            const section = document.getElementById('phase1-inline-section');
            const tbody = document.getElementById('phase1-inline-body');
            const p1 = state.phase1Results;
            
            // 통계 업데이트
            const reviewCount = p1.filter(function(r) { return r.최종분류 && r.최종분류.includes('물량검토'); }).length;
            const quoteCount = p1.filter(function(r) { return r.최종분류 && r.최종분류.includes('견적'); }).length;
            document.getElementById('p1i-review').textContent = reviewCount;
            document.getElementById('p1i-quote').textContent = quoteCount;
            
            // 테이블 렌더링
            tbody.innerHTML = p1.map(function(item) {
                var 분류Badge = (item.최종분류 || '').includes('물량검토') ? 'badge-물량검토' : 'badge-견적대상';
                var 적정성Color = item.유형코드_적정여부 === 'Y' ? 'text-green-600' : 'text-red-600';
                
                return '<tr>' +
                    '<td class="font-mono">' + (item.자재번호 || '').substring(0, 18) + '...</td>' +
                    '<td class="text-indigo-600 font-semibold">' + (item.PR_NO || '-') + '</td>' +
                    '<td class="text-center font-bold ' + (item.계약단가존재 === 'Y' ? 'text-green-600' : 'text-red-600') + '">' + item.계약단가존재 + '</td>' +
                    '<td class="text-center">' + item.유형코드 + '</td>' +
                    '<td class="text-center ' + 적정성Color + '">' + item.유형코드_적정여부 + '</td>' +
                    '<td class="text-center text-indigo-600">' + (item.권장코드 || '-') + '</td>' +
                    '<td class="text-center">' + item.도장사경유 + '</td>' +
                    '<td class="text-center"><span class="px-2 py-1 rounded text-xs ' + 분류Badge + '">' + item.최종분류 + '</span></td>' +
                '</tr>';
            }).join('');
            
            section.classList.remove('hidden');
        }
        
        function renderCompanyStatus(state) {
            const section = document.getElementById('company-status-section');
            const tbody = document.getElementById('company-status-body');
            const companies = state.steps.step2.data.협력사별 || {};
            
            // 총 요청건수
            document.getElementById('cs-total-request').textContent = state.steps.step2.data.총요청건수;
            
            // 협력사 코드 매핑
            const companyCodeMap = {
                '세창앰앤이(주)': 'SC001',
                '(주)케이이엠': 'KEM01',
                '(주)동진테크': 'DJ001',
                '한빛이엔지': 'HB001',
                '한덕': 'HD001'
            };
            
            // 도장사 매핑 (협력사 → 도장사)
            const paintingCompanyMap = {
                '세창앰앤이(주)': { name: '대림에스엔피', code: 'V484' },
                '(주)케이이엠': { name: '진명에프앤피', code: 'V486' },
                '(주)동진테크': { name: '피에스산업', code: 'V485' },
                '한빛이엔지': { name: '성원기업', code: 'V487' },
                '한덕': { name: '대림에스엔피', code: 'V484' }
            };
            
            // 예상 발주금액 계산 (Phase1 결과 기반)
            // 유형코드별 단가 (백엔드와 동일 로직)
            const typeCodeUnitPrices = {
                'B': 15000, 'G': 22000, 'I': 28000, 'N': 25000,
                'A': 35000, 'S': 42000, 'M': 45000, 'E': 40000
            };
            function calcOrderAmount(typeCode, materialNo) {
                let seed = 0;
                for (let i = 0; i < materialNo.length; i++) {
                    seed += materialNo.charCodeAt(i);
                }
                const weight = 50 + (seed % 450);
                const unitPrice = typeCodeUnitPrices[typeCode] || typeCodeUnitPrices['B'];
                return Math.round(weight * unitPrice);
            }
            
            // 협력사별 예상 발주금액 계산 (물량검토대상 건들의 합계)
            const estimatedAmounts = {};
            const p1 = state.phase1Results || [];
            const reviewTargets = p1.filter(r => r.최종분류 === '물량검토대상');
            for (const item of reviewTargets) {
                const company = item.업체명 || '미지정';
                const typeCode = item.유형코드 || 'B';
                const amount = calcOrderAmount(typeCode, item.자재번호);
                estimatedAmounts[company] = (estimatedAmounts[company] || 0) + amount;
            }
            
            let html = '';
            for (const company in companies) {
                const code = companyCodeMap[company] || 'N/A';
                const requestCount = companies[company];
                const amount = estimatedAmounts[company] || 0;
                const paintingInfo = paintingCompanyMap[company] || { name: '-', code: '-' };
                
                // 해당 협력사의 PR 상세 목록 가져오기
                const companyPRs = reviewTargets.filter(r => r.업체명 === company);
                
                html += '<tr class="company-row cursor-pointer hover:bg-gray-50" data-company="' + company + '">' +
                    '<td class="text-center w-8"><i class="fas fa-chevron-right text-gray-400 toggle-icon"></i></td>' +
                    '<td class="font-mono text-gray-600">' + code + '</td>' +
                    '<td class="font-medium">' + company + '</td>' +
                    '<td class="text-center font-bold text-purple-600">' + requestCount + '건</td>' +
                    '<td class="text-center text-gray-400" id="cs-recv-' + code + '">-</td>' +
                    '<td class="text-center"><span class="status-badge px-2 py-1 rounded text-xs bg-yellow-100 text-yellow-800" id="cs-status-' + code + '">' +
                    '<i class="fas fa-clock mr-1"></i>요청중</span></td>' +
                    '<td class="text-center font-mono text-sm text-gray-500">' + paintingInfo.code + '</td>' +
                    '<td class="text-gray-700">' + paintingInfo.name + '</td>' +
                    '<td class="text-right font-medium text-gray-700">' + amount.toLocaleString() + '원</td>' +
                '</tr>' +
                '<tr class="detail-row hidden" data-company-detail="' + company + '">' +
                    '<td colspan="9" class="bg-gray-50 p-0">' +
                    '<div class="p-4">' +
                    '<div class="text-gray-600 mb-3 font-semibold text-sm flex items-center">' +
                    '<i class="fas fa-list-ul mr-2"></i>PR 상세 목록 (' + companyPRs.length + '건)</div>' +
                    '<div class="overflow-x-auto">' +
                    '<table class="min-w-full text-xs border border-gray-200 rounded">' +
                    '<thead class="bg-gray-100">' +
                    '<tr>' +
                    '<th class="px-2 py-2 text-left font-semibold text-gray-700">PR번호</th>' +
                    '<th class="px-2 py-2 text-left font-semibold text-gray-700">자재번호</th>' +
                    '<th class="px-2 py-2 text-left font-semibold text-gray-700">자재내역</th>' +
                    '<th class="px-2 py-2 text-center font-semibold text-gray-700">유형코드</th>' +
                    '<th class="px-2 py-2 text-right font-semibold text-gray-700">발주수량</th>' +
                    '<th class="px-2 py-2 text-right font-semibold text-gray-700">도급수량</th>' +
                    '<th class="px-2 py-2 text-center font-semibold text-gray-700">중량단위</th>' +
                    '<th class="px-2 py-2 text-right font-semibold text-gray-700">기본단가</th>' +
                    '<th class="px-2 py-2 text-right font-semibold text-gray-700">발주금액</th>' +
                    '<th class="px-2 py-2 text-center font-semibold text-gray-700">도장사코드</th>' +
                    '<th class="px-2 py-2 text-left font-semibold text-gray-700">도장사</th>' +
                    '</tr>' +
                    '</thead>' +
                    '<tbody class="bg-white divide-y divide-gray-100">';
                
                // PR 상세 목록 행 추가
                for (const pr of companyPRs) {
                    const prAmount = pr.발주금액 || calcOrderAmount(pr.유형코드 || 'B', pr.자재번호);
                    const prPaintingInfo = paintingCompanyMap[pr.업체명] || { name: '-', code: '-' };
                    
                    html += '<tr class="hover:bg-blue-50">' +
                        '<td class="px-2 py-1.5 font-mono text-blue-600">' + (pr.PR_NO || '-') + '</td>' +
                        '<td class="px-2 py-1.5 font-mono text-gray-600">' + (pr.자재번호 || '-') + '</td>' +
                        '<td class="px-2 py-1.5 text-gray-700 truncate max-w-[200px]" title="' + (pr.자재내역 || '') + '">' + (pr.자재내역 || '-') + '</td>' +
                        '<td class="px-2 py-1.5 text-center"><span class="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-bold">' + (pr.유형코드 || pr.철의장유형코드_원본 || '-') + '</span></td>' +
                        '<td class="px-2 py-1.5 text-right font-medium">' + (pr.발주수량 || 1) + '</td>' +
                        '<td class="px-2 py-1.5 text-right font-medium">' + (pr.도급수량 || 100).toLocaleString() + '</td>' +
                        '<td class="px-2 py-1.5 text-center text-gray-500">' + (pr.중량단위 || 'KG') + '</td>' +
                        '<td class="px-2 py-1.5 text-right text-gray-600">' + (pr.기본단가 || 15000).toLocaleString() + '</td>' +
                        '<td class="px-2 py-1.5 text-right font-bold text-green-600">' + prAmount.toLocaleString() + '원</td>' +
                        '<td class="px-2 py-1.5 text-center font-mono text-gray-500">' + (pr.도장사코드 || prPaintingInfo.code || '-') + '</td>' +
                        '<td class="px-2 py-1.5 text-gray-700">' + (pr.도장사 || prPaintingInfo.name || '-') + '</td>' +
                        '</tr>';
                }
                
                html += '</tbody></table></div></div></td></tr>';
            }
            
            tbody.innerHTML = html;
            section.classList.remove('hidden');
            
            // 아코디언 이벤트 설정
            setupCompanyAccordion();
        }
        
        function setupCompanyAccordion() {
            const companyRows = document.querySelectorAll('.company-row');
            companyRows.forEach(row => {
                row.addEventListener('click', function() {
                    const company = this.getAttribute('data-company');
                    const detailRow = document.querySelector('[data-company-detail="' + company + '"]');
                    const icon = this.querySelector('.toggle-icon');
                    
                    if (detailRow) {
                        detailRow.classList.toggle('hidden');
                        if (icon) {
                            icon.classList.toggle('fa-chevron-right');
                            icon.classList.toggle('fa-chevron-down');
                        }
                    }
                });
            });
        }
        
        function updateCompanyStatusReceived(state) {
            const companies = state.steps.step2.data.협력사별 || {};
            
            const companyCodeMap = {
                '세창앰앤이(주)': 'SC001',
                '(주)케이이엠': 'KEM01',
                '(주)동진테크': 'DJ001',
                '한빛이엔지': 'HB001',
                '한덕': 'HD001'
            };
            
            for (const company in companies) {
                const code = companyCodeMap[company] || 'N/A';
                const requestCount = companies[company];
                
                // 수신건수 업데이트
                const recvEl = document.getElementById('cs-recv-' + code);
                if (recvEl) {
                    recvEl.textContent = requestCount + '건';
                    recvEl.className = 'text-center font-bold text-green-600';
                }
                
                // 상태 업데이트
                const statusEl = document.getElementById('cs-status-' + code);
                if (statusEl) {
                    statusEl.innerHTML = '<i class="fas fa-check-circle mr-1"></i>수신완료';
                    statusEl.className = 'px-2 py-1 rounded text-xs bg-green-100 text-green-800';
                }
            }
        }
        
        function renderPhase2Inline(state) {
            const section = document.getElementById('phase2-inline-section');
            const tbody = document.getElementById('phase2-inline-body');
            const p2 = state.phase2Results;
            
            // 통계 업데이트
            const confirmedCount = p2.filter(function(r) { return r.권장조치 === '확정'; }).length;
            const hitlCount = p2.filter(function(r) { return r.권장조치 === 'HITL'; }).length;
            const canceledCount = p2.filter(function(r) { return r.권장조치 === '검토취소'; }).length;
            
            document.getElementById('p2i-confirmed').textContent = confirmedCount;
            document.getElementById('p2i-hitl').textContent = hitlCount;
            document.getElementById('p2i-canceled').textContent = canceledCount;
            
            // 테이블 렌더링
            tbody.innerHTML = p2.map(function(item) {
                var 조치Badge = 'badge-HITL';
                if (item.권장조치 === '확정') 조치Badge = 'badge-확정';
                else if (item.권장조치 === '검토취소') 조치Badge = 'badge-검토취소';
                
                var 결과Color = 'text-yellow-600';
                if (item.검증결과 === '적합') 결과Color = 'text-green-600';
                else if (item.검증결과 === '부적합') 결과Color = 'text-red-600';
                
                return '<tr>' +
                    '<td class="font-mono">' + (item.자재번호 || '').substring(0, 18) + '...</td>' +
                    '<td class="text-indigo-600 font-semibold">' + (item.PR_NO || '-') + '</td>' +
                    '<td>' + item.검토구분 + '</td>' +
                    '<td class="' + 결과Color + '">' + item.검증결과 + '</td>' +
                    '<td class="text-center"><span class="px-2 py-1 rounded text-xs ' + 조치Badge + '">' + item.권장조치 + '</span></td>' +
                    '<td class="text-xs text-gray-600">' + item.검증근거 + '</td>' +
                '</tr>';
            }).join('');
            
            section.classList.remove('hidden');
        }
        
        function renderPOTable(state) {
            const section = document.getElementById('po-generation-section');
            const tbody = document.getElementById('po-table-body');
            const poResults = state.poResults || [];
            
            // 통계 업데이트
            const totalAmount = state.summary?.po?.총_발주금액 || 0;
            document.getElementById('po-total-count').textContent = poResults.length;
            document.getElementById('po-total-amount').textContent = totalAmount.toLocaleString();
            
            // 테이블 렌더링
            tbody.innerHTML = poResults.map(function(item) {
                return '<tr>' +
                    '<td class="font-mono font-bold text-blue-600">' + (item.PO_번호 || '-') + '</td>' +
                    '<td class="text-indigo-600 font-semibold">' + (item.PR_NO || '-') + '</td>' +
                    '<td class="font-mono text-xs">' + (item.자재번호 || '').substring(0, 20) + '...</td>' +
                    '<td>' + (item.업체명 || '-') + '</td>' +
                    '<td class="text-right font-medium">' + (item.발주금액 || 0).toLocaleString() + '원</td>' +
                    '<td class="text-center"><span class="px-2 py-1 rounded text-xs bg-green-100 text-green-800">' +
                    '<i class="fas fa-check-circle mr-1"></i>' + (item.발주상태 || '-') + '</span></td>' +
                '</tr>';
            }).join('');
            
            section.classList.remove('hidden');
        }
        
        // renderFinalSummary 함수 제거됨 (카드 삭제)

        // ====================================================================
        // Reset
        // ====================================================================
        async function resetAll() {
            if (isRunning) return;
            
            await fetch('/api/reset', { method: 'POST' });
            
            currentState = null;
            
            // UI 초기화 (6단계)
            for (let i = 1; i <= 6; i++) {
                updateStepUI(i, 'pending', '대기');
            }
            updateProgressBar(0);
            overallStatus.textContent = '대기 중';
            
            // 순차적 결과 섹션 숨기기
            document.getElementById('phase1-inline-section').classList.add('hidden');
            document.getElementById('company-status-section').classList.add('hidden');
            document.getElementById('phase2-inline-section').classList.add('hidden');
            document.getElementById('po-generation-section').classList.add('hidden');
            document.getElementById('flow-summary').classList.add('hidden');
            document.getElementById('log-section').classList.add('hidden');
            
            // 흐름 요약 초기화
            document.getElementById('flow-review-target').textContent = '-';
            document.getElementById('flow-request').textContent = '-';
            document.getElementById('flow-received').textContent = '-';
            
            initialSection.classList.remove('hidden');
            summarySection.classList.add('hidden');
            btnRunAllCenter.classList.remove('hidden');
        }

        // ====================================================================
        // UI Update Functions
        // ====================================================================
        function updateStepUI(step, status, message) {
            const stepBox = document.getElementById('step-' + step);
            const stepIcon = document.getElementById('step-' + step + '-icon');
            const stepMessage = document.getElementById('step-' + step + '-message');
            
            stepBox.className = 'step-box ' + status + ' border-2 rounded-lg p-3';
            
            if (status === 'pending') {
                stepIcon.className = 'w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center text-white font-bold mr-2 text-sm';
                stepIcon.innerHTML = step;
            } else if (status === 'processing') {
                stepIcon.className = 'w-7 h-7 rounded-full bg-yellow-500 flex items-center justify-center text-white font-bold mr-2 text-sm';
                stepIcon.innerHTML = '<i class="fas fa-spinner fa-spin text-xs"></i>';
            } else if (status === 'completed') {
                stepIcon.className = 'w-7 h-7 rounded-full bg-green-500 flex items-center justify-center text-white font-bold mr-2 text-sm';
                stepIcon.innerHTML = '<i class="fas fa-check text-xs"></i>';
            } else if (status === 'error') {
                stepIcon.className = 'w-7 h-7 rounded-full bg-red-500 flex items-center justify-center text-white font-bold mr-2 text-sm';
                stepIcon.innerHTML = '<i class="fas fa-times text-xs"></i>';
            }
            
            stepMessage.textContent = message;
            
            if (status === 'processing') {
                stepMessage.className = 'text-xs text-yellow-700 mt-1 font-medium';
            } else if (status === 'completed') {
                stepMessage.className = 'text-xs text-green-700 mt-1';
            } else if (status === 'error') {
                stepMessage.className = 'text-xs text-red-700 mt-1';
            } else {
                stepMessage.className = 'text-xs text-gray-400 mt-1';
            }
        }

        function updateProgressBar(percent) {
            progressBar.style.width = percent + '%';
        }

        function updateUI(state) {
            if (!state) return;
            
            // Step 상태 업데이트 (6단계)
            for (let i = 1; i <= 6; i++) {
                const stepKey = 'step' + i;
                const step = state.steps[stepKey];
                if (step) {
                    updateStepUI(i, step.status, step.message || '대기');
                }
            }
            
            // 진행률 업데이트
            const completedSteps = Object.values(state.steps).filter(s => s.status === 'completed').length;
            updateProgressBar(completedSteps * 20);
        }

        // ====================================================================
        // Summary Display
        // ====================================================================
        function showSummary() {
            if (!currentState || !currentState.summary) return;
            
            // HITL 목록
            renderHitlList();
            
            // 상세 결과 테이블
            renderPhase1Table();
            renderPhase2Table();
            
            summarySection.classList.remove('hidden');
        }

        // HITL 전역 상태
        let currentHitlFilter = 'all';
        let allHitlItems = [];

        function renderHitlList() {
            const container = document.getElementById('hitl-list');
            allHitlItems = currentState.phase2Results.filter(r => r.권장조치 === 'HITL');
            
            document.getElementById('hitl-count').textContent = allHitlItems.length;
            
            if (allHitlItems.length === 0) {
                document.getElementById('hitl-section').classList.add('hidden');
                return;
            }
            
            document.getElementById('hitl-section').classList.remove('hidden');
            
            // 필터 이벤트 설정
            setupHitlFilters();
            
            // 초기 렌더링 (전체)
            renderHitlCards(allHitlItems);
        }
        
        function setupHitlFilters() {
            const filters = ['all', 'negotiation', 'vision', 'nodrawing'];
            const filterMap = {
                'all': null,
                'negotiation': '협상필요',
                'vision': 'Vision불일치',
                'nodrawing': '도면없음'
            };
            
            filters.forEach(filter => {
                const btn = document.getElementById('hitl-filter-' + filter);
                if (btn) {
                    btn.onclick = () => {
                        currentHitlFilter = filter;
                        
                        // 탭 스타일 업데이트
                        filters.forEach(f => {
                            const b = document.getElementById('hitl-filter-' + f);
                            if (f === filter) {
                                b.className = 'px-4 py-2 text-sm font-medium text-indigo-600 border-b-2 border-indigo-600';
                            } else {
                                b.className = 'px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700';
                            }
                        });
                        
                        // 필터링된 아이템 렌더링
                        const filtered = filter === 'all' 
                            ? allHitlItems 
                            : allHitlItems.filter(item => item.HITL유형 === filterMap[filter]);
                        renderHitlCards(filtered);
                    };
                }
            });
        }
        
        function renderHitlCards(items) {
            const container = document.getElementById('hitl-list');
            
            if (items.length === 0) {
                container.innerHTML = '<div class="text-center text-gray-500 py-8">해당 유형의 HITL 건이 없습니다.</div>';
                return;
            }
            
            container.innerHTML = items.map(item => {
                const hitlType = item.HITL유형 || '협상필요';
                
                // HITL 유형별 배지 색상
                let typeBadgeClass = 'bg-yellow-100 text-yellow-800';
                let typeIcon = 'fas fa-handshake';
                if (hitlType === 'Vision불일치') {
                    typeBadgeClass = 'bg-red-100 text-red-800';
                    typeIcon = 'fas fa-eye';
                } else if (hitlType === '도면없음') {
                    typeBadgeClass = 'bg-gray-100 text-gray-800';
                    typeIcon = 'fas fa-file-alt';
                }
                
                // HITL 유형별 추가 정보 섹션
                let additionalInfo = '';
                
                if (hitlType === '협상필요') {
                    const price = item.변경요청단가 || 0;
                    additionalInfo = '<div class="bg-orange-50 border border-orange-200 rounded-lg p-3">' +
                        '<div class="flex items-center mb-2">' +
                        '<i class="fas fa-won-sign text-orange-500 mr-2"></i>' +
                        '<span class="font-semibold text-orange-800">요청단가</span>' +
                        '</div>' +
                        '<div class="text-2xl font-bold text-orange-600">' + price.toLocaleString() + '원</div>' +
                        '<div class="text-xs text-orange-500 mt-1">공급사가 단가 협상을 요청했습니다</div>' +
                        '</div>';
                } else if (hitlType === 'Vision불일치') {
                    const llm = item.LLM_추론 || {};
                    const llmType = llm.추론_단가유형 || '-';
                    const confidence = llm.신뢰도 || '중간';
                    const reasons = llm.판단근거 || [];
                    const confClass = confidence === '높음' ? 'bg-green-100 text-green-800' : confidence === '중간' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-800';
                    const reasonsHtml = reasons.map(function(r) { return '<li>' + r + '</li>'; }).join('');
                    
                    additionalInfo = '<div class="bg-red-50 border border-red-200 rounded-lg p-3">' +
                        '<div class="flex items-center mb-2">' +
                        '<i class="fas fa-balance-scale text-red-500 mr-2"></i>' +
                        '<span class="font-semibold text-red-800">코드 비교</span>' +
                        '</div>' +
                        '<div class="flex items-center space-x-4 mb-3">' +
                        '<div class="flex-1 bg-white rounded p-2 text-center">' +
                        '<div class="text-xs text-gray-500">공급사 요청</div>' +
                        '<div class="text-xl font-bold text-red-600">' + (item.변경요청코드 || '-') + '</div>' +
                        '</div>' +
                        '<div class="text-gray-400"><i class="fas fa-not-equal"></i></div>' +
                        '<div class="flex-1 bg-white rounded p-2 text-center">' +
                        '<div class="text-xs text-gray-500">LLM 분석</div>' +
                        '<div class="text-xl font-bold text-blue-600">' + llmType + '</div>' +
                        '</div>' +
                        '</div>' +
                        '<div class="text-sm">' +
                        '<div class="flex items-center mb-1">' +
                        '<span class="text-gray-600">신뢰도:</span>' +
                        '<span class="ml-2 px-2 py-0.5 rounded text-xs ' + confClass + '">' + confidence + '</span>' +
                        '</div>' +
                        '<div class="text-xs text-gray-600 mt-2">' +
                        '<div class="font-medium mb-1">판단 근거:</div>' +
                        '<ul class="list-disc list-inside space-y-0.5">' + reasonsHtml + '</ul>' +
                        '</div>' +
                        '</div>' +
                        '</div>';
                } else if (hitlType === '도면없음') {
                    additionalInfo = '<div class="bg-gray-50 border border-gray-200 rounded-lg p-3">' +
                        '<div class="flex items-center mb-2">' +
                        '<i class="fas fa-exchange-alt text-gray-500 mr-2"></i>' +
                        '<span class="font-semibold text-gray-800">유형코드 변경</span>' +
                        '</div>' +
                        '<div class="flex items-center justify-center space-x-4">' +
                        '<div class="text-center">' +
                        '<div class="text-xs text-gray-500">변경 전</div>' +
                        '<div class="text-2xl font-bold text-gray-600">' + (item.현재유형코드 || '-') + '</div>' +
                        '</div>' +
                        '<div class="text-2xl text-gray-400"><i class="fas fa-arrow-right"></i></div>' +
                        '<div class="text-center">' +
                        '<div class="text-xs text-gray-500">변경 후</div>' +
                        '<div class="text-2xl font-bold text-indigo-600">' + (item.변경요청코드 || '-') + '</div>' +
                        '</div>' +
                        '</div>' +
                        '<div class="text-xs text-gray-500 mt-2 text-center">도면 정보가 없어 자동 검증 불가</div>' +
                        '</div>';
                }
                
                return '<div class="border border-gray-200 rounded-xl overflow-hidden hover:shadow-md transition">' +
                    '<div class="bg-gray-50 px-4 py-3 flex items-center justify-between border-b">' +
                    '<div class="flex items-center space-x-3">' +
                    '<span class="px-3 py-1 rounded-full text-xs font-medium ' + typeBadgeClass + '">' +
                    '<i class="' + typeIcon + ' mr-1"></i>' + hitlType +
                    '</span>' +
                    '<span class="text-xs text-gray-500">' + item.검토구분 + '</span>' +
                    '</div>' +
                    '<div class="flex space-x-2">' +
                    '<button class="px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white text-xs rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed" disabled title="PoC - 기능 비활성화">' +
                    '<i class="fas fa-check mr-1"></i>확정' +
                    '</button>' +
                    '<button class="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed" disabled title="PoC - 기능 비활성화">' +
                    '<i class="fas fa-times mr-1"></i>반려' +
                    '</button>' +
                    '<button class="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white text-xs rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed" disabled title="PoC - 기능 비활성화">' +
                    '<i class="fas fa-image mr-1"></i>도면보기' +
                    '</button>' +
                    '</div>' +
                    '</div>' +
                    '<div class="p-4">' +
                    '<div class="grid grid-cols-2 gap-4 mb-4">' +
                    '<div class="space-y-2">' +
                    '<div>' +
                    '<label class="text-xs text-gray-500">자재번호</label>' +
                    '<div class="font-mono text-sm font-medium text-gray-800">' + (item.자재번호 || '-') + '</div>' +
                    '</div>' +
                    '<div>' +
                    '<label class="text-xs text-gray-500">PR NO</label>' +
                    '<div class="text-sm font-semibold text-indigo-600">' + (item.PR_NO || '-') + '</div>' +
                    '</div>' +
                    '<div>' +
                    '<label class="text-xs text-gray-500">업체명</label>' +
                    '<div class="text-sm text-gray-700">' + (item.업체명 || '-') + '</div>' +
                    '</div>' +
                    '</div>' +
                    '<div class="space-y-2">' +
                    '<div class="flex space-x-4">' +
                    '<div>' +
                    '<label class="text-xs text-gray-500">현재유형코드</label>' +
                    '<div class="text-lg font-bold text-gray-700">' + (item.현재유형코드 || '-') + '</div>' +
                    '</div>' +
                    '<div>' +
                    '<label class="text-xs text-gray-500">변경요청코드</label>' +
                    '<div class="text-lg font-bold text-indigo-600">' + (item.변경요청코드 || '-') + '</div>' +
                    '</div>' +
                    '</div>' +
                    '<div>' +
                    '<label class="text-xs text-gray-500">도면번호</label>' +
                    '<div class="text-sm text-gray-700 font-mono">' + (item.도면번호 || '-') + '</div>' +
                    '</div>' +
                    '</div>' +
                    '</div>' +
                    (additionalInfo ? '<div class="mb-4">' + additionalInfo + '</div>' : '') +
                    '<div class="bg-blue-50 rounded-lg p-3">' +
                    '<div class="flex items-center mb-1">' +
                    '<i class="fas fa-info-circle text-blue-500 mr-2"></i>' +
                    '<span class="text-xs font-medium text-blue-800">검증 근거</span>' +
                    '</div>' +
                    '<div class="text-sm text-blue-700">' + (item.검증근거 || '-') + '</div>' +
                    '</div>' +
                    '</div>' +
                    '</div>';
            }).join('');
        }

        function renderPhase1Table() {
            const tbody = document.getElementById('phase1-table-body');
            const p1 = currentState.phase1Results;
            
            tbody.innerHTML = p1.map(item => {
                const 분류Badge = item.최종분류?.includes('물량검토') ? 'badge-물량검토' : 'badge-견적대상';
                const 적정성Color = item.유형코드_적정여부 === 'Y' ? 'text-green-600' : 'text-red-600';
                
                return '<tr>' +
                    '<td class="font-mono">' + (item.자재번호 || '').substring(0, 18) + '...</td>' +
                    '<td class="text-indigo-600 font-semibold">' + (item.PR_NO || '-') + '</td>' +
                    '<td class="text-center font-bold ' + (item.계약단가존재 === 'Y' ? 'text-green-600' : 'text-red-600') + '">' + item.계약단가존재 + '</td>' +
                    '<td class="text-center">' + item.유형코드 + '</td>' +
                    '<td class="text-center ' + 적정성Color + '">' + item.유형코드_적정여부 + '</td>' +
                    '<td class="text-center text-indigo-600">' + (item.권장코드 || '-') + '</td>' +
                    '<td class="text-center">' + item.도장사경유 + '</td>' +
                    '<td class="text-center"><span class="px-2 py-1 rounded text-xs ' + 분류Badge + '">' + item.최종분류 + '</span></td>' +
                '</tr>';
            }).join('');
        }

        function renderPhase2Table() {
            const tbody = document.getElementById('phase2-table-body');
            const p2 = currentState.phase2Results;
            
            tbody.innerHTML = p2.map(item => {
                let 조치Badge = 'badge-HITL';
                if (item.권장조치 === '확정') 조치Badge = 'badge-확정';
                else if (item.권장조치 === '검토취소') 조치Badge = 'badge-검토취소';
                
                let 결과Color = 'text-yellow-600';
                if (item.검증결과 === '적합') 결과Color = 'text-green-600';
                else if (item.검증결과 === '부적합') 결과Color = 'text-red-600';
                
                return '<tr>' +
                    '<td class="font-mono">' + (item.자재번호 || '').substring(0, 18) + '...</td>' +
                    '<td class="text-indigo-600 font-semibold">' + (item.PR_NO || '-') + '</td>' +
                    '<td>' + item.검토구분 + '</td>' +
                    '<td class="' + 결과Color + '">' + item.검증결과 + '</td>' +
                    '<td class="text-center"><span class="px-2 py-1 rounded text-xs ' + 조치Badge + '">' + item.권장조치 + '</span></td>' +
                    '<td class="text-xs text-gray-600">' + item.검증근거 + '</td>' +
                '</tr>';
            }).join('');
        }

        // ====================================================================
        // Tab Switching
        // ====================================================================
        function switchResultTab(tab) {
            if (tab === 'phase1') {
                tabPhase1Results.className = 'flex-1 py-3 px-4 text-center font-medium text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50';
                tabPhase2Results.className = 'flex-1 py-3 px-4 text-center font-medium text-gray-500 hover:bg-gray-50';
                phase1ResultsContent.classList.remove('hidden');
                phase2ResultsContent.classList.add('hidden');
            } else {
                tabPhase1Results.className = 'flex-1 py-3 px-4 text-center font-medium text-gray-500 hover:bg-gray-50';
                tabPhase2Results.className = 'flex-1 py-3 px-4 text-center font-medium text-purple-600 border-b-2 border-purple-600 bg-purple-50';
                phase1ResultsContent.classList.add('hidden');
                phase2ResultsContent.classList.remove('hidden');
            }
        }

        // ====================================================================
        // Helpers
        // ====================================================================
        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // Initialize
        init();
    </script>
</body>
</html>
  `)
})

export default app
