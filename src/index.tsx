import { Hono } from 'hono'
import { cors } from 'hono/cors'

// PR 데이터 및 단가테이블 (TypeScript 모듈로 포함)
import { prData } from './pr-data.js'
import { priceTable } from './price-table.js'

type Bindings = {
  ANTHROPIC_API_KEY?: string
}

type AnalysisResult = {
  prNo: number
  status: 'pending' | 'analyzing' | 'completed' | 'error'
  result?: {
    단가존재여부: string
    단가존재_근거: string
    현재유형코드: string
    적정유형코드: string
    유형코드적정성: string
    유형코드_근거: string
    물량검토대상: string
    최종분류: string
    종합의견: string
  }
  error?: string
  processingTime?: number
}

// 분석 결과 저장소 (메모리)
const analysisResults = new Map<number, AnalysisResult>()

const app = new Hono<{ Bindings: Bindings }>()

// CORS 설정
app.use('/api/*', cors())



// API: PR 목록 가져오기
app.get('/api/pr-list', (c) => {
  const prList = (prData as any[]).map((pr, index) => {
    const prNo = pr['대표PR']
    const result = analysisResults.get(prNo)
    return {
      index: index + 1,
      prNo,
      자재내역: pr['자재내역'],
      자재속성: pr['자재속성'],
      재질: pr['재질'],
      유형코드: pr['철의장유형코드'],
      status: result?.status || 'pending',
      최종분류: result?.result?.최종분류 || null
    }
  })
  return c.json({ total: prList.length, data: prList })
})

// API: 단건 PR 상세 정보
app.get('/api/pr/:prNo', (c) => {
  const prNo = parseInt(c.req.param('prNo'))
  const pr = (prData as any[]).find(p => p['대표PR'] === prNo)
  
  if (!pr) {
    return c.json({ error: 'PR not found' }, 404)
  }
  
  const result = analysisResults.get(prNo)
  
  return c.json({
    input: {
      prNo: pr['대표PR'],
      자재내역: pr['자재내역'],
      자재속성: pr['자재속성'],
      자재속성_4자리: pr['자재속성_4자리'],
      자재그룹: pr['자재그룹'],
      재질: pr['재질'],
      재질내역: pr['재질내역'],
      상세사양: pr['상세사양'],
      철의장유형코드: pr['철의장유형코드'],
      SYS철의장유형코드: pr['SYS철의장유형코드'],
      PR철의장유형코드: pr['PR철의장유형코드'],
      호선: pr['호선'],
      BLOCK: pr['BLOCK'],
      단가테이블매칭: pr['단가테이블매칭']
    },
    analysis: result || { status: 'pending' }
  })
})

// API: 단가테이블 정보
app.get('/api/price-table', (c) => {
  return c.json(priceTable)
})

// API: 통계 정보
app.get('/api/statistics', (c) => {
  const total = (prData as any[]).length
  let analyzed = 0
  let 물량검토 = 0
  let 견적대상 = 0
  let HITL필요 = 0
  
  for (const [_, result] of analysisResults) {
    if (result.status === 'completed' && result.result) {
      analyzed++
      const 분류 = result.result.최종분류
      if (분류.includes('물량검토')) 물량검토++
      else if (분류.includes('견적')) 견적대상++
      else HITL필요++
    }
  }
  
  const 자동처리 = 물량검토 + 견적대상
  
  return c.json({
    total,
    analyzed,
    물량검토,
    견적대상,
    HITL필요,
    자동처리율: analyzed > 0 ? ((자동처리 / analyzed) * 100).toFixed(1) : '0.0'
  })
})

// System Prompt 생성
function buildSystemPrompt() {
  let priceContext = `
## 계약 단가테이블 정보

### 등록된 자재속성그룹 및 철의장상세구분

`
  for (const [group, info] of Object.entries(priceTable as Record<string, any>)) {
    priceContext += `**${group}** (${info.name})\n`
    for (const code of info.codes) {
      priceContext += `  - ${code.code}: ${code.name}\n`
    }
    priceContext += '\n'
  }

  priceContext += `
### 판단 기준
- 자재속성(앞 4자리)이 위 테이블에 존재하면 → 단가계약 존재 (물량검토 대상)
- 자재속성이 미존재하면 → 견적 대상

### 철의장상세구분 코드 의미
- B: 상선 기본 (SS400, Carbon Steel)
- A: SUS304L (ANGLE, PLATE)
- S: SUS316L (ANGLE, PLATE)
- G: BENDING류 (COVER류, BOX류)
- I: PIPE, SQ.TUBE, BEAM TYPE
- M: SUS316L (PIPE)
- N: CHECK PLATE 소요
- E: COAMING (SUS316L) - PQPC 전용
`

  return `당신은 조선소 철의장재 구매 업무를 지원하는 AI Agent입니다.

## 역할
PR(구매요청) 데이터를 분석하여 다음을 판단합니다:
1. 계약단가 존재 여부
2. 철의장유형코드 적정성 검증
3. 물량검토 대상 여부 결정

${priceContext}

## 응답 형식
반드시 아래 JSON 형식으로만 응답하세요. 다른 설명 없이 JSON만 출력합니다.

\`\`\`json
{
    "분석결과": {
        "단가존재여부": "Y 또는 N",
        "단가존재_근거": "판단 근거 상세 설명",
        "현재유형코드": "현재 PR의 유형코드 (없으면 '미지정')",
        "적정유형코드": "재질과 자재내역 기반 추천 코드",
        "유형코드적정성": "적합 / 부적합 / 검토필요",
        "유형코드_근거": "판단 근거 상세 설명 (자재내역, 재질 등 분석 내용 포함)",
        "물량검토대상": "Y 또는 N",
        "최종분류": "물량검토 / 견적대상 / HITL필요",
        "종합의견": "전체 분석 의견 및 권고사항"
    }
}
\`\`\`

## 판단 시 고려사항
1. 자재내역 텍스트를 주의깊게 분석하세요. BENDING, COVER, BOX, PIPE, TUBE 등 키워드가 유형코드 결정에 중요합니다.
2. 재질 코드를 해석하세요: CS=Carbon Steel, S4=SUS304, S6=SUS316
3. SYS코드와 PR코드가 다르면 어느 것이 맞는지 판단하고 근거를 제시하세요.
4. 확신이 낮은 경우 "검토필요" 또는 "HITL필요"로 분류하세요.
`
}

// User Prompt 생성
function buildUserPrompt(pr: any) {
  const safeStr = (val: any) => val === '' || val === null || val === undefined ? '없음' : String(val)
  
  return `
## 분석 대상 PR

| 항목 | 값 |
|------|-----|
| PR No | ${pr.prNo} |
| 자재내역 | ${safeStr(pr.자재내역)} |
| 자재속성 | ${safeStr(pr.자재속성)} |
| 자재그룹 | ${safeStr(pr.자재그룹)} |
| 재질 | ${safeStr(pr.재질)} |
| 재질내역 | ${safeStr(pr.재질내역)} |
| 상세사양 | ${safeStr(pr.상세사양)} |
| 현재 철의장유형코드 | ${safeStr(pr.철의장유형코드)} |
| SYS 철의장유형코드 | ${safeStr(pr.SYS철의장유형코드)} |
| PR 철의장유형코드 | ${safeStr(pr.PR철의장유형코드)} |

위 PR을 분석하고 JSON 형식으로 응답하세요.
`
}

// API: 단건 분석 실행
app.post('/api/analyze/:prNo', async (c) => {
  const prNo = parseInt(c.req.param('prNo'))
  const pr = (prData as any[]).find(p => p['대표PR'] === prNo)
  
  if (!pr) {
    return c.json({ error: 'PR not found' }, 404)
  }

  // API Key 확인 (Node.js 환경에서는 process.env 사용)
  const apiKey = process.env.ANTHROPIC_API_KEY || c.env?.ANTHROPIC_API_KEY
  if (!apiKey) {
    return c.json({ 
      error: 'ANTHROPIC_API_KEY not configured',
      message: '환경 변수에 ANTHROPIC_API_KEY를 설정해주세요.'
    }, 500)
  }

  // 분석 시작
  const startTime = Date.now()
  analysisResults.set(prNo, { prNo, status: 'analyzing' })

  try {
    const prInput = {
      prNo: pr['대표PR'],
      자재내역: pr['자재내역'],
      자재속성: pr['자재속성'],
      자재그룹: pr['자재그룹'],
      재질: pr['재질'],
      재질내역: pr['재질내역'],
      상세사양: pr['상세사양'],
      철의장유형코드: pr['철의장유형코드'],
      SYS철의장유형코드: pr['SYS철의장유형코드'],
      PR철의장유형코드: pr['PR철의장유형코드']
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: buildSystemPrompt(),
        messages: [
          { role: 'user', content: buildUserPrompt(prInput) }
        ]
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`API Error: ${response.status} - ${errorText}`)
    }

    const data = await response.json() as any
    const responseText = data.content[0].text

    // JSON 추출
    let jsonStr = responseText
    if (responseText.includes('```json')) {
      jsonStr = responseText.split('```json')[1].split('```')[0]
    } else if (responseText.includes('```')) {
      jsonStr = responseText.split('```')[1].split('```')[0]
    }

    const result = JSON.parse(jsonStr.trim())
    const processingTime = Date.now() - startTime

    const analysisResult: AnalysisResult = {
      prNo,
      status: 'completed',
      result: result.분석결과,
      processingTime
    }
    
    analysisResults.set(prNo, analysisResult)

    return c.json({
      success: true,
      prNo,
      result: result.분석결과,
      processingTime
    })

  } catch (error: any) {
    const processingTime = Date.now() - startTime
    analysisResults.set(prNo, { 
      prNo, 
      status: 'error', 
      error: error.message,
      processingTime 
    })
    
    return c.json({ 
      success: false, 
      error: error.message,
      processingTime 
    }, 500)
  }
})

// API: 분석 결과 초기화
app.post('/api/reset', (c) => {
  analysisResults.clear()
  return c.json({ success: true, message: '분석 결과가 초기화되었습니다.' })
})

// API: 시스템/유저 프롬프트 조회 (UI 표시용)
app.get('/api/prompts/:prNo', (c) => {
  const prNo = parseInt(c.req.param('prNo'))
  const pr = (prData as any[]).find(p => p['대표PR'] === prNo)
  
  if (!pr) {
    return c.json({ error: 'PR not found' }, 404)
  }

  const prInput = {
    prNo: pr['대표PR'],
    자재내역: pr['자재내역'],
    자재속성: pr['자재속성'],
    자재그룹: pr['자재그룹'],
    재질: pr['재질'],
    재질내역: pr['재질내역'],
    상세사양: pr['상세사양'],
    철의장유형코드: pr['철의장유형코드'],
    SYS철의장유형코드: pr['SYS철의장유형코드'],
    PR철의장유형코드: pr['PR철의장유형코드']
  }

  return c.json({
    systemPromptSummary: {
      역할: '철의장재 구매 업무 지원 AI Agent',
      context: `단가테이블 (${Object.keys(priceTable).length}개 자재속성그룹)`,
      판단항목: ['단가존재', '유형코드 적정성', '최종분류']
    },
    userPromptSummary: {
      prNo: prInput.prNo,
      자재속성: prInput.자재속성,
      재질: prInput.재질,
      현재유형코드: prInput.철의장유형코드
    },
    fullSystemPrompt: buildSystemPrompt(),
    fullUserPrompt: buildUserPrompt(prInput)
  })
})

// 메인 페이지 - HTML 렌더링
app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>철의장재 PR 분석 AI Agent</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <style>
        .status-pending { color: #9CA3AF; }
        .status-analyzing { color: #F59E0B; }
        .status-completed { color: #10B981; }
        .status-error { color: #EF4444; }
        
        .badge-물량검토 { background-color: #10B981; color: white; }
        .badge-견적대상 { background-color: #3B82F6; color: white; }
        .badge-HITL필요 { background-color: #F59E0B; color: white; }
        .badge-미분석 { background-color: #9CA3AF; color: white; }
        
        .pr-item { transition: all 0.2s; }
        .pr-item:hover { background-color: #F3F4F6; }
        .pr-item.selected { background-color: #EEF2FF; border-left: 3px solid #4F46E5; }
        
        .step-card { transition: all 0.3s; }
        .step-card.active { box-shadow: 0 0 0 2px #4F46E5; }
        
        .animate-pulse-slow { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
        
        .scrollbar-thin::-webkit-scrollbar { width: 6px; }
        .scrollbar-thin::-webkit-scrollbar-track { background: #f1f1f1; }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: #c1c1c1; border-radius: 3px; }
        .scrollbar-thin::-webkit-scrollbar-thumb:hover { background: #a1a1a1; }
    </style>
</head>
<body class="bg-gray-50 h-screen flex flex-col">
    <!-- Header -->
    <header class="bg-indigo-700 text-white px-6 py-4 shadow-lg flex-shrink-0">
        <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
                <i class="fas fa-robot text-2xl"></i>
                <div>
                    <h1 class="text-xl font-bold">철의장재 PR 분석 AI Agent</h1>
                    <p class="text-indigo-200 text-sm">PoC Demo - 세창앰앤이 단가계약</p>
                </div>
            </div>
            <div class="flex items-center space-x-4">
                <button id="btn-analyze-all" class="bg-indigo-500 hover:bg-indigo-400 px-4 py-2 rounded-lg text-sm font-medium transition flex items-center space-x-2">
                    <i class="fas fa-play"></i>
                    <span>전체 분석</span>
                </button>
                <button id="btn-reset" class="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-lg text-sm font-medium transition flex items-center space-x-2">
                    <i class="fas fa-redo"></i>
                    <span>초기화</span>
                </button>
            </div>
        </div>
    </header>
    
    <!-- Main Content -->
    <div class="flex flex-1 overflow-hidden">
        <!-- Left Sidebar - PR List -->
        <aside class="w-80 bg-white border-r flex flex-col flex-shrink-0">
            <div class="p-4 border-b bg-gray-50">
                <h2 class="font-semibold text-gray-700 flex items-center">
                    <i class="fas fa-list-ul mr-2"></i>
                    PR 목록
                </h2>
                <div id="progress-bar" class="mt-2 text-sm text-gray-500">
                    분석완료: <span id="analyzed-count">0</span>/<span id="total-count">0</span>건
                </div>
            </div>
            <div id="pr-list" class="flex-1 overflow-y-auto scrollbar-thin">
                <!-- PR items will be rendered here -->
            </div>
        </aside>
        
        <!-- Main Panel -->
        <main class="flex-1 flex flex-col overflow-hidden">
            <!-- Statistics Dashboard -->
            <div id="statistics" class="bg-white border-b p-4 flex-shrink-0">
                <div class="grid grid-cols-5 gap-4">
                    <div class="text-center p-3 bg-gray-50 rounded-lg">
                        <div class="text-2xl font-bold text-gray-700" id="stat-total">0</div>
                        <div class="text-xs text-gray-500">총 분석</div>
                    </div>
                    <div class="text-center p-3 bg-green-50 rounded-lg">
                        <div class="text-2xl font-bold text-green-600" id="stat-물량검토">0</div>
                        <div class="text-xs text-gray-500">물량검토</div>
                    </div>
                    <div class="text-center p-3 bg-blue-50 rounded-lg">
                        <div class="text-2xl font-bold text-blue-600" id="stat-견적대상">0</div>
                        <div class="text-xs text-gray-500">견적대상</div>
                    </div>
                    <div class="text-center p-3 bg-yellow-50 rounded-lg">
                        <div class="text-2xl font-bold text-yellow-600" id="stat-HITL">0</div>
                        <div class="text-xs text-gray-500">HITL필요</div>
                    </div>
                    <div class="text-center p-3 bg-indigo-50 rounded-lg">
                        <div class="text-2xl font-bold text-indigo-600" id="stat-자동처리율">0%</div>
                        <div class="text-xs text-gray-500">자동처리율</div>
                    </div>
                </div>
            </div>
            
            <!-- Steps Content -->
            <div id="steps-content" class="flex-1 overflow-y-auto p-6 space-y-4">
                <!-- STEP 1: Input -->
                <div id="step1" class="step-card bg-white rounded-lg shadow p-5">
                    <h3 class="font-semibold text-gray-700 mb-4 flex items-center">
                        <span class="bg-indigo-100 text-indigo-700 px-2 py-1 rounded text-sm mr-2">STEP 1</span>
                        Input - PR 정보
                    </h3>
                    <div id="step1-content" class="text-gray-500 text-center py-8">
                        <i class="fas fa-hand-pointer text-4xl mb-2"></i>
                        <p>좌측에서 PR을 선택해주세요</p>
                    </div>
                </div>
                
                <!-- STEP 2: AI Agent Process -->
                <div id="step2" class="step-card bg-white rounded-lg shadow p-5">
                    <h3 class="font-semibold text-gray-700 mb-4 flex items-center">
                        <span class="bg-indigo-100 text-indigo-700 px-2 py-1 rounded text-sm mr-2">STEP 2</span>
                        AI Agent 추론 과정
                    </h3>
                    <div id="step2-content" class="text-gray-500 text-center py-8">
                        <i class="fas fa-robot text-4xl mb-2"></i>
                        <p>PR 선택 후 분석을 실행해주세요</p>
                    </div>
                </div>
                
                <!-- STEP 3: Output -->
                <div id="step3" class="step-card bg-white rounded-lg shadow p-5">
                    <h3 class="font-semibold text-gray-700 mb-4 flex items-center">
                        <span class="bg-indigo-100 text-indigo-700 px-2 py-1 rounded text-sm mr-2">STEP 3</span>
                        Output - 판단 결과
                    </h3>
                    <div id="step3-content" class="text-gray-500 text-center py-8">
                        <i class="fas fa-chart-pie text-4xl mb-2"></i>
                        <p>분석 완료 후 결과가 표시됩니다</p>
                    </div>
                </div>
            </div>
            
            <!-- Action Bar -->
            <div id="action-bar" class="bg-white border-t p-4 flex justify-center space-x-4 flex-shrink-0">
                <button id="btn-analyze-single" class="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-medium transition flex items-center space-x-2 disabled:opacity-50 disabled:cursor-not-allowed" disabled>
                    <i class="fas fa-search"></i>
                    <span>단건 분석 실행</span>
                </button>
            </div>
        </main>
    </div>

    <script>
        // State
        let prList = [];
        let selectedPrNo = null;
        let isAnalyzing = false;

        // DOM Elements
        const prListEl = document.getElementById('pr-list');
        const step1Content = document.getElementById('step1-content');
        const step2Content = document.getElementById('step2-content');
        const step3Content = document.getElementById('step3-content');
        const btnAnalyzeSingle = document.getElementById('btn-analyze-single');
        const btnAnalyzeAll = document.getElementById('btn-analyze-all');
        const btnReset = document.getElementById('btn-reset');

        // Initialize
        async function init() {
            await loadPrList();
            await updateStatistics();
        }

        // Load PR List
        async function loadPrList() {
            const response = await fetch('/api/pr-list');
            const data = await response.json();
            prList = data.data;
            
            document.getElementById('total-count').textContent = data.total;
            renderPrList();
        }

        // Render PR List
        function renderPrList() {
            let analyzed = 0;
            prListEl.innerHTML = prList.map(pr => {
                if (pr.status === 'completed') analyzed++;
                const badge = getBadgeClass(pr.최종분류 || '미분석');
                const isSelected = pr.prNo === selectedPrNo;
                return \`
                    <div class="pr-item p-3 border-b cursor-pointer \${isSelected ? 'selected' : ''}" 
                         onclick="selectPr(\${pr.prNo})">
                        <div class="flex justify-between items-center">
                            <div>
                                <span class="font-medium text-gray-800">\${pr.prNo}</span>
                                <span class="status-\${pr.status} ml-2 text-xs">
                                    \${pr.status === 'analyzing' ? '<i class="fas fa-spinner fa-spin"></i>' : ''}
                                </span>
                            </div>
                            <span class="text-xs px-2 py-1 rounded \${badge}">\${pr.최종분류 || '미분석'}</span>
                        </div>
                        <div class="text-xs text-gray-500 mt-1 truncate">\${pr.자재내역}</div>
                    </div>
                \`;
            }).join('');
            
            document.getElementById('analyzed-count').textContent = analyzed;
        }

        // Get Badge Class
        function getBadgeClass(status) {
            const classes = {
                '물량검토': 'badge-물량검토',
                '견적대상': 'badge-견적대상',
                'HITL필요': 'badge-HITL필요',
                '미분석': 'badge-미분석'
            };
            return classes[status] || 'badge-미분석';
        }

        // Select PR
        async function selectPr(prNo) {
            selectedPrNo = prNo;
            btnAnalyzeSingle.disabled = false;
            renderPrList();
            
            // Load PR details
            const response = await fetch(\`/api/pr/\${prNo}\`);
            const data = await response.json();
            
            renderStep1(data.input);
            
            // Load prompts
            const promptsResponse = await fetch(\`/api/prompts/\${prNo}\`);
            const prompts = await promptsResponse.json();
            renderStep2(prompts, data.analysis);
            
            renderStep3(data.analysis);
        }

        // Render STEP 1 - Input
        function renderStep1(input) {
            step1Content.innerHTML = \`
                <div class="grid grid-cols-2 gap-4">
                    <div class="space-y-3">
                        <div class="flex">
                            <span class="w-32 text-gray-500 text-sm">PR No</span>
                            <span class="font-medium">\${input.prNo}</span>
                        </div>
                        <div class="flex">
                            <span class="w-32 text-gray-500 text-sm">자재내역</span>
                            <span class="font-medium text-indigo-600">\${input.자재내역}</span>
                        </div>
                        <div class="flex">
                            <span class="w-32 text-gray-500 text-sm">자재속성</span>
                            <span class="font-medium">\${input.자재속성}</span>
                        </div>
                        <div class="flex">
                            <span class="w-32 text-gray-500 text-sm">재질</span>
                            <span class="font-medium">\${input.재질} (\${input.재질내역 || '-'})</span>
                        </div>
                    </div>
                    <div class="space-y-3 border-l pl-4">
                        <div class="flex">
                            <span class="w-36 text-gray-500 text-sm">현재 유형코드</span>
                            <span class="font-bold text-lg text-indigo-700">\${input.철의장유형코드 || '미지정'}</span>
                        </div>
                        <div class="flex">
                            <span class="w-36 text-gray-500 text-sm">SYS 유형코드</span>
                            <span class="font-medium">\${input.SYS철의장유형코드 || '미지정'}</span>
                        </div>
                        <div class="flex">
                            <span class="w-36 text-gray-500 text-sm">PR 유형코드</span>
                            <span class="font-medium">\${input.PR철의장유형코드 || '미지정'}</span>
                        </div>
                        <div class="flex">
                            <span class="w-36 text-gray-500 text-sm">단가테이블 매칭</span>
                            <span class="font-medium \${input.단가테이블매칭 ? 'text-green-600' : 'text-red-600'}">\${input.단가테이블매칭 ? '매칭됨' : '미매칭'}</span>
                        </div>
                    </div>
                </div>
            \`;
        }

        // Render STEP 2 - AI Agent Process
        function renderStep2(prompts, analysis) {
            const statusIcon = analysis.status === 'analyzing' 
                ? '<i class="fas fa-spinner fa-spin text-yellow-500"></i> 호출 중...'
                : analysis.status === 'completed'
                ? \`<i class="fas fa-check-circle text-green-500"></i> 완료 (\${(analysis.processingTime/1000).toFixed(1)}초)\`
                : analysis.status === 'error'
                ? '<i class="fas fa-exclamation-circle text-red-500"></i> 오류'
                : '<i class="fas fa-clock text-gray-400"></i> 대기 중';

            step2Content.innerHTML = \`
                <div class="space-y-4">
                    <div class="bg-gray-50 rounded-lg p-4">
                        <h4 class="text-sm font-semibold text-gray-600 mb-2">
                            <i class="fas fa-cog mr-1"></i> System Prompt
                        </h4>
                        <div class="text-sm space-y-1">
                            <div><span class="text-gray-500">역할:</span> \${prompts.systemPromptSummary.역할}</div>
                            <div><span class="text-gray-500">Context:</span> \${prompts.systemPromptSummary.context}</div>
                            <div><span class="text-gray-500">판단항목:</span> \${prompts.systemPromptSummary.판단항목.join(', ')}</div>
                        </div>
                    </div>
                    
                    <div class="bg-blue-50 rounded-lg p-4">
                        <h4 class="text-sm font-semibold text-gray-600 mb-2">
                            <i class="fas fa-user mr-1"></i> User Prompt
                        </h4>
                        <div class="text-sm space-y-1">
                            <div><span class="text-gray-500">PR No:</span> \${prompts.userPromptSummary.prNo}</div>
                            <div><span class="text-gray-500">자재속성:</span> \${prompts.userPromptSummary.자재속성}</div>
                            <div><span class="text-gray-500">재질:</span> \${prompts.userPromptSummary.재질}</div>
                            <div><span class="text-gray-500">현재 유형코드:</span> \${prompts.userPromptSummary.현재유형코드}</div>
                        </div>
                    </div>
                    
                    <div class="text-center py-2 text-sm">
                        \${statusIcon}
                    </div>
                </div>
            \`;
        }

        // Render STEP 3 - Output
        function renderStep3(analysis) {
            if (analysis.status !== 'completed' || !analysis.result) {
                step3Content.innerHTML = \`
                    <div class="text-center py-8 text-gray-500">
                        <i class="fas fa-chart-pie text-4xl mb-2"></i>
                        <p>\${analysis.status === 'analyzing' ? '분석 중...' : analysis.status === 'error' ? '분석 오류: ' + (analysis.error || '') : '분석 결과 대기 중'}</p>
                    </div>
                \`;
                return;
            }

            const r = analysis.result;
            const 최종분류Badge = getBadgeClass(r.최종분류);

            step3Content.innerHTML = \`
                <div class="space-y-4">
                    <!-- 단가존재여부 -->
                    <div class="border-b pb-4">
                        <div class="flex items-center justify-between mb-2">
                            <span class="font-semibold text-gray-700">단가존재여부</span>
                            <span class="font-bold text-lg \${r.단가존재여부 === 'Y' ? 'text-green-600' : 'text-red-600'}">\${r.단가존재여부}</span>
                        </div>
                        <p class="text-sm text-gray-600 bg-gray-50 p-2 rounded">\${r.단가존재_근거}</p>
                    </div>
                    
                    <!-- 유형코드 검증 -->
                    <div class="border-b pb-4">
                        <div class="font-semibold text-gray-700 mb-2">유형코드 검증</div>
                        <div class="flex space-x-6 mb-2">
                            <div>
                                <span class="text-gray-500 text-sm">현재코드:</span>
                                <span class="font-bold text-lg ml-1">\${r.현재유형코드}</span>
                            </div>
                            <div>
                                <span class="text-gray-500 text-sm">적정코드:</span>
                                <span class="font-bold text-lg text-indigo-600 ml-1">\${r.적정유형코드}</span>
                            </div>
                            <div>
                                <span class="text-gray-500 text-sm">적정성:</span>
                                <span class="font-bold ml-1 \${
                                    r.유형코드적정성.includes('적합') && !r.유형코드적정성.includes('부적합') 
                                    ? 'text-green-600' 
                                    : r.유형코드적정성.includes('부적합') 
                                    ? 'text-red-600' 
                                    : 'text-yellow-600'
                                }">\${r.유형코드적정성}</span>
                            </div>
                        </div>
                        <p class="text-sm text-gray-600 bg-gray-50 p-2 rounded">\${r.유형코드_근거}</p>
                    </div>
                    
                    <!-- 최종 판단 -->
                    <div class="bg-indigo-50 rounded-lg p-4">
                        <div class="flex items-center justify-between mb-3">
                            <span class="font-semibold text-gray-700">최종 판단</span>
                            <span class="px-3 py-1 rounded-full text-sm font-bold \${최종분류Badge}">\${r.최종분류}</span>
                        </div>
                        <div class="flex items-center mb-2">
                            <span class="text-gray-500 text-sm mr-2">물량검토대상:</span>
                            <span class="font-bold \${r.물량검토대상 === 'Y' ? 'text-green-600' : 'text-gray-600'}">\${r.물량검토대상}</span>
                        </div>
                        <div class="mt-2 p-3 bg-white rounded border-l-4 border-indigo-500">
                            <p class="text-sm text-gray-700">\${r.종합의견}</p>
                        </div>
                    </div>
                </div>
            \`;
        }

        // Update Statistics
        async function updateStatistics() {
            const response = await fetch('/api/statistics');
            const stats = await response.json();
            
            document.getElementById('stat-total').textContent = stats.analyzed;
            document.getElementById('stat-물량검토').textContent = stats.물량검토;
            document.getElementById('stat-견적대상').textContent = stats.견적대상;
            document.getElementById('stat-HITL').textContent = stats.HITL필요;
            document.getElementById('stat-자동처리율').textContent = stats.자동처리율 + '%';
        }

        // Analyze Single PR
        async function analyzeSingle() {
            if (!selectedPrNo || isAnalyzing) return;
            
            isAnalyzing = true;
            btnAnalyzeSingle.disabled = true;
            btnAnalyzeSingle.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>분석 중...</span>';
            
            // Update status in list
            const prIndex = prList.findIndex(p => p.prNo === selectedPrNo);
            if (prIndex >= 0) {
                prList[prIndex].status = 'analyzing';
                renderPrList();
            }
            
            // Update Step 2
            const promptsResponse = await fetch(\`/api/prompts/\${selectedPrNo}\`);
            const prompts = await promptsResponse.json();
            renderStep2(prompts, { status: 'analyzing' });
            
            try {
                const response = await fetch(\`/api/analyze/\${selectedPrNo}\`, { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    prList[prIndex].status = 'completed';
                    prList[prIndex].최종분류 = result.result.최종분류;
                    
                    renderStep2(prompts, { status: 'completed', result: result.result, processingTime: result.processingTime });
                    renderStep3({ status: 'completed', result: result.result });
                } else {
                    prList[prIndex].status = 'error';
                    renderStep2(prompts, { status: 'error', error: result.error });
                    renderStep3({ status: 'error', error: result.error });
                }
            } catch (error) {
                if (prIndex >= 0) prList[prIndex].status = 'error';
                renderStep3({ status: 'error', error: error.message });
            }
            
            renderPrList();
            await updateStatistics();
            
            isAnalyzing = false;
            btnAnalyzeSingle.disabled = false;
            btnAnalyzeSingle.innerHTML = '<i class="fas fa-search"></i> <span>단건 분석 실행</span>';
        }

        // Analyze All
        async function analyzeAll() {
            if (isAnalyzing) return;
            
            isAnalyzing = true;
            btnAnalyzeAll.disabled = true;
            btnAnalyzeAll.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>분석 중...</span>';
            
            for (const pr of prList) {
                if (pr.status === 'completed') continue;
                
                selectedPrNo = pr.prNo;
                renderPrList();
                
                // Load and display current PR
                const detailResponse = await fetch(\`/api/pr/\${pr.prNo}\`);
                const detail = await detailResponse.json();
                renderStep1(detail.input);
                
                const promptsResponse = await fetch(\`/api/prompts/\${pr.prNo}\`);
                const prompts = await promptsResponse.json();
                
                pr.status = 'analyzing';
                renderPrList();
                renderStep2(prompts, { status: 'analyzing' });
                
                try {
                    const response = await fetch(\`/api/analyze/\${pr.prNo}\`, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        pr.status = 'completed';
                        pr.최종분류 = result.result.최종분류;
                        renderStep2(prompts, { status: 'completed', result: result.result, processingTime: result.processingTime });
                        renderStep3({ status: 'completed', result: result.result });
                    } else {
                        pr.status = 'error';
                        renderStep2(prompts, { status: 'error', error: result.error });
                    }
                } catch (error) {
                    pr.status = 'error';
                }
                
                renderPrList();
                await updateStatistics();
                
                // Small delay between requests
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            isAnalyzing = false;
            btnAnalyzeAll.disabled = false;
            btnAnalyzeAll.innerHTML = '<i class="fas fa-play"></i> <span>전체 분석</span>';
        }

        // Reset
        async function reset() {
            if (isAnalyzing) return;
            
            await fetch('/api/reset', { method: 'POST' });
            selectedPrNo = null;
            await loadPrList();
            await updateStatistics();
            
            step1Content.innerHTML = \`
                <div class="text-gray-500 text-center py-8">
                    <i class="fas fa-hand-pointer text-4xl mb-2"></i>
                    <p>좌측에서 PR을 선택해주세요</p>
                </div>
            \`;
            step2Content.innerHTML = \`
                <div class="text-gray-500 text-center py-8">
                    <i class="fas fa-robot text-4xl mb-2"></i>
                    <p>PR 선택 후 분석을 실행해주세요</p>
                </div>
            \`;
            step3Content.innerHTML = \`
                <div class="text-gray-500 text-center py-8">
                    <i class="fas fa-chart-pie text-4xl mb-2"></i>
                    <p>분석 완료 후 결과가 표시됩니다</p>
                </div>
            \`;
            
            btnAnalyzeSingle.disabled = true;
        }

        // Event Listeners
        btnAnalyzeSingle.addEventListener('click', analyzeSingle);
        btnAnalyzeAll.addEventListener('click', analyzeAll);
        btnReset.addEventListener('click', reset);

        // Initialize
        init();
    </script>
</body>
</html>
  `)
})

export default app
