import React,{useCallback,useEffect,useMemo,useState} from 'react';
import {KR_DEFAULTS} from '../../retirement-simulator/src/model/defaults.js';
import {parseBackup,MAX_BACKUP_BYTES} from '../../retirement-simulator/src/state/backup.js';
import {computeStory,choiceInput,nextEventAge} from './story.js';

const fmt=n=>Number(n??0).toLocaleString('ko-KR');
const fmtMoney=(n,hidden=false)=>hidden?'••••':`${fmt(Math.round(n))}만 원`;
const phaseName={work:'일하는 시기',bridge:'연금 전 공백',pension:'연금 생활'};
const choiceList=[
 {id:'base',label:'원래 계획',detail:'입력한 금융 계획을 그대로 유지',tag:'기준'},
 {id:'delay',label:'은퇴를 2년 늦춘다',detail:'근로기간을 연장한 경로 비교',tag:'+2년'},
 {id:'spend',label:'월 생활비를 30만 줄인다',detail:'은퇴 후 생활비 가정만 조정',tag:'지출'},
 {id:'debt',label:'대출 적극 상환',detail:'2년치 예비자금 초과 예금으로 상환',tag:'대출'},
];
function Symbol({name,size=18}) {
 const common={width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round',role:'presentation','aria-hidden':true};
 const paths={
  play:<path d="m8 5 11 7-11 7V5Z"/>,pause:<><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></>,
  prev:<><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></>,
  next:<><path d="m12 5 7 7-7 7"/><path d="M5 12h14"/></>,
  refresh:<><path d="M3 12a9 9 0 1 0 2-5"/><path d="M3 3v5h5"/></>,
  lock:<><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  unlock:<><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0"/></>,
  arrow:<><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
  upload:<><path d="M12 16V3m-5 5 5-5 5 5"/><path d="M4 17v4h16v-4"/></>,
 };
 return <svg {...common}>{paths[name]??paths.arrow}</svg>;
}
function Scene({frame,input}) {
 const chapter=frame.chapter;
 return <div className={`scene-artwork scene-${chapter} scene-tone-${frame.tone}`}>
  <div className="scene-grain"/>
  <svg className="scene-landscape" viewBox="0 0 700 470" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
   <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#253d49"/><stop offset="1" stopColor="#789188"/></linearGradient>
    <linearGradient id="hill" x1="0" y1="0" x2=".75" y2="1"><stop stopColor="#54716c"/><stop offset="1" stopColor="#1a3940"/></linearGradient>
    <radialGradient id="sunGlow"><stop stopColor="#f7d6a0" stopOpacity=".35"/><stop offset="1" stopColor="#f7d6a0" stopOpacity="0"/></radialGradient>
   </defs>
   <rect width="700" height="470" fill="url(#sky)"/>
   <circle cx="476" cy="117" r="124" fill="url(#sunGlow)"/>
   <circle cx="476" cy="117" r="53" fill="#f4d9a8" opacity=".9"/>
   <path d="M0 272Q130 196 282 273T700 243V470H0Z" fill="#7d9384" opacity=".76"/>
   <path d="M0 329Q172 265 316 330T700 290V470H0Z" fill="url(#hill)"/>
   <path d="M0 395Q250 348 430 397T700 360V470H0Z" fill="#17313b" opacity=".84"/>
   <g transform="translate(130 215)" fill="#e9dfc8">
     <rect x="35" y="60" width="88" height="115" rx="3" opacity=".88"/>
     <path d="M22 65L79 18l57 47Z" fill="#d5b89a"/>
     <rect x="64" y="119" width="23" height="56" rx="2" fill="#435d62"/>
     <rect x="48" y="78" width="20" height="23" rx="2" fill="#eabf80"/>
     <rect x="93" y="78" width="19" height="23" rx="2" fill="#eabf80"/>
   </g>
   <g fill="#16363a" opacity=".8"><path d="M560 338v-115h8v115Z"/><circle cx="565" cy="216" r="46"/><circle cx="535" cy="235" r="30"/><circle cx="590" cy="241" r="32"/></g>
   <g fill="none" stroke="#e9e7d7" strokeWidth="2" opacity=".22"><path d="M0 419Q300 397 700 431"/><path d="M0 438Q300 416 700 451"/></g>
  </svg>
  <div className="scene-gradient"/>
  <div className="scene-copy">
   <span className="scene-overline">CHAPTER {frame.chapter==='준비기'?'I':frame.chapter==='브릿지'?'II':'III'} · {frame.chapter}</span>
   <span className="scene-age"><span>{frame.age}</span>세</span>
   <span className="scene-year">{frame.year}년 · {frame.age-input.currentAge+1}번째 해</span>
  </div>
  <div className="scene-caption">이 풍경은 연출 이미지이며 미래 사건을 예측하지 않습니다.</div>
 </div>;
}
function AssetTrend({frames,index,hidden}) {
 const w=680,h=140,pad=13,values=frames.map(f=>f.financialAssets);
 const min=Math.min(0,...values),max=Math.max(1,...values),range=Math.max(1,max-min);
 const x=i=>pad+(w-pad*2)*(i/Math.max(1,frames.length-1));
 const y=v=>h-pad-((v-min)/range)*(h-pad*2);
 const path=frames.map((f,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(f.financialAssets).toFixed(1)}`).join(' ');
 const current=frames[index]??frames[0],xCur=x(index);
 const y0=y(0);
 return <div className="trend-chart">
   <div className="trend-heading"><span>금융자산 경로 · 현재가치</span><b>{hidden?'금액 숨김':`${fmt(current.financialAssets)}만 원`}</b></div>
   <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`현재 ${current.age}세 금융자산 변화 그래프. 0원 기준선 포함`} preserveAspectRatio="none">
    <line x1={0} x2={w} y1={y0} y2={y0} stroke="#d4a57e" strokeDasharray="4 7" strokeWidth="1" opacity=".6"/>
    <path d={path} fill="none" stroke="#88bfaf" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/>
    <line x1={xCur} x2={xCur} y1={0} y2={h} stroke="#d4dfdb" strokeWidth="1" opacity=".4"/>
    <circle cx={xCur} cy={y(current.financialAssets)} r="5" fill="#dce9d9" stroke="#476b63" strokeWidth="2"/>
   </svg>
   <div className="trend-ticks"><span>{frames[0].age}세</span><span>{current.age}세 · 선택</span><span>{frames.at(-1).age}세</span></div>
 </div>;
}
function Summary({story,hidden}) {
 const {input,result,investmentTarget}=story;
 const achieved=result.readinessRatio>=100&&result.depletionAge===null;
 return <section className="readiness" aria-label="노후 준비 진단">
  <div className="readiness-head"><div><p className="eyebrow">은퇴 준비 진단</p><h2>이대로 은퇴해도 될까?</h2></div><span className={`pill ${achieved?'ok':'warning'}`}>{achieved?'기준 충족':'추가 점검 필요'}</span></div>
  <div className="readiness-value"><strong>{result.readinessRatio}<small>%</small></strong><span>고정 수익률 가정의<br/>노후 준비율</span></div>
  <div className="readiness-track"><span style={{width:`${Math.min(100,result.readinessRatio)}%`}}/></div>
  <p className="readiness-copy">{result.depletionAge===null
   ?`${result.simEndAge}세까지 금융자산이 유지되는 시나리오입니다.`
   :`${result.depletionAge}세에 금융자산 고갈 위험이 나타납니다. 주택 순자산은 별도입니다.`}</p>
  <div className="readiness-info">
    <span>은퇴 {input.retireAge}세 예상 금융자산</span><b>{fmtMoney(result.totalAssetsAtRetirement,hidden)}</b>
  </div>
  <div className="readiness-info">
    <span>준비율 100% 목표 추가 투자자산</span>
    <b>{investmentTarget.additionalAtRetirement===null?'탐색 상한 초과':investmentTarget.additionalAtRetirement===0?'충족':fmtMoney(investmentTarget.additionalAtRetirement,hidden)}</b>
  </div>
  <p className="disclaimer">목표 추가금액은 <b>은퇴 시점에 더 보유해야 할 현재가치 기준 자산</b>이다. 오늘 투자할 금액이 아니며 준비율 100%는 성공확률 100%를 의미하지 않는다.</p>
 </section>;
}
function StoryCard({frame,hidden}) {
 const f=frame.flow,negative=f.balance<0;
 return <section className="narrative-card" aria-label="해당 연도의 이야기">
  <p className="eyebrow">YEAR {frame.year} <span>·</span> {phaseName[frame.phase]??'은퇴 이후'}</p>
  <h2>{frame.heading}</h2>
  <p className="story-description">{frame.description}</p>
  {!!frame.events.length&&<div className="event-tags">{frame.events.map(e=><span className={`tag tone-${e.tone}`} key={e.id}>{e.title}</span>)}</div>}
  <div className="story-flow">
   <div><span>월수입</span><b>{fmtMoney(f.income,hidden)}</b></div>
   <div><span>월 기본지출</span><b>{fmtMoney(f.spending,hidden)}</b></div>
   <div><span>월 수지 차이</span><b className={negative?'negative':'positive'}>{hidden?'••••':`${f.balance>0?'+':''}${fmt(f.balance)}만 원`}</b></div>
  </div>
  <p className="story-footnote">모델의 연도별 수입·지출 항목을 합산했다. 추가 투자 적립과 일부 자산 간 이동은 별도이며 연 단위 추정이다.</p>
 </section>;
}
export function App() {
 const [imports,setImports]=useState([{id:'demo',name:'예시 · 기본 계획',input:KR_DEFAULTS}]);
 const [activeId,setActiveId]=useState('demo');
 const [choice,setChoice]=useState('base');
 const [age,setAge]=useState(KR_DEFAULTS.currentAge);
 const [playing,setPlaying]=useState(false);
 const [speed,setSpeed]=useState(1);
 const [hidden,setHidden]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('예시 계획으로 시작한다. 기존 은퇴 시뮬레이터의 실제 JSON을 가져올 수 있다.');
 const active=imports.find(x=>x.id===activeId)??imports[0];
 const original=useMemo(()=>computeStory(active.input),[active.input]);
 const story=useMemo(()=>choice==='base'?original:computeStory(choiceInput(active.input,choice)),[active.input,choice,original]);
 const frames=story.frames,first=frames[0].age,last=frames.at(-1).age;
 const clampedAge=Math.max(first,Math.min(last,age));
 const index=clampedAge-first,frame=frames[index];
 const changeAge=useCallback(next=>{setAge(Math.max(first,Math.min(last,typeof next==='function'?next(clampedAge):next)));setPlaying(false);},[first,last,clampedAge]);
 useEffect(()=>{
  if(!playing)return;
  const id=window.setInterval(()=>setAge(prev=>{
   const next=Math.max(first,prev);
   if(next>=last){setPlaying(false);return last;}
   return next+1;
  }),speed===1?1150:260);
  return ()=>window.clearInterval(id);
 },[playing,speed,first,last]);
 useEffect(()=>{setAge(x=>Math.max(first,Math.min(last,x)));},[first,last]);
 const selectStory=id=>{const item=imports.find(x=>x.id===id);if(!item)return;setActiveId(id);setChoice('base');setAge(item.input.currentAge);setPlaying(false);setError('');};
 const loadParsed=parsed=>{
  const items=parsed.scenarios.map((s,i)=>({...s,id:`import-${i}-${s.id}`}));
  const firstMatch=items.find(s=>s.id===`import-0-${parsed.activeId}`)??items.find(s=>s.id.endsWith(`-${parsed.activeId}`))??items[0];
  setImports(items);setActiveId(firstMatch.id);setChoice('base');setAge(firstMatch.input.currentAge);setPlaying(false);setError('');
  setNotice(`${items.length}개 시나리오를 이 브라우저에만 불러왔다. 서버 전송이나 자동 저장은 하지 않는다.`);
 };
 const loadLocal=()=>{
  try{
   const raw=window.localStorage.getItem('retirement-sim-v5');
   if(!raw)throw new Error('이 브라우저에서 저장된 은퇴 시뮬레이터 계획을 찾지 못했습니다. JSON 파일을 이용하세요.');
   loadParsed(parseBackup(raw));
  }catch(e){setError(e.message??'저장된 계획을 읽지 못했습니다.');}
 };
 const loadFile=async e=>{
  const file=e.target.files?.[0];if(!file)return;
  try{
   if(file.size>MAX_BACKUP_BYTES)throw new Error('파일은 2MB 이하만 지원합니다.');
   loadParsed(parseBackup(await file.text()));
  }catch(err){setError(err.message??'백업 파일을 읽지 못했습니다.');}
  finally{e.target.value='';}
 };
 const jumpEvent=forward=>{
  const next=nextEventAge(story.events,clampedAge,forward);
  if(next!==null)changeAge(next);
 };
 const onChoice=id=>{setChoice(id);setPlaying(false);};
 const hasDebt=story.input.housingMode==='own'&&story.input.hasMortgage&&story.input.mortgageBalance>0;
 const choices=choiceList.filter(c=>(c.id!=='debt'||hasDebt)&&(c.id!=='delay'||story.input.retireAge+2<story.input.selfLifeExpectancy));
 const eventsAround=story.events.filter(e=>e.age>=clampedAge).slice(0,6);
 return <div className="site">
  <header className="topbar">
   <div className="topbar-inner">
    <a href="./" className="brand" aria-label="은퇴 연대기 시작 화면"><span className="brand-mark">R<span>·</span>S</span><span>RETIREMENT <b>STORY</b></span></a>
    <nav className="mainnav"><span className="nav-active">스토리</span><a href="../retirement-simulator/">정밀 시뮬레이터 <Symbol name="arrow" size={15}/></a></nav>
    <button type="button" className="privacy" onClick={()=>setHidden(v=>!v)} aria-pressed={hidden}>
     <Symbol name={hidden?'lock':'unlock'} size={16}/>{hidden?'금액 보기':'금액 숨기기'}
    </button>
   </div>
  </header>
  <main className="layout">
   <div className="hero-top">
    <div><p className="eyebrow accent">MY LIFE, AFTER WORK</p><h1>나의 은퇴 연대기<span>.</span></h1><p>숫자로만 보이던 미래를, 한 해씩 읽는다.</p></div>
    <div className="hero-stamp"><span>01</span><small>PLAN → STORY</small></div>
   </div>
   <section className="import-bar" aria-label="시나리오 연결">
    <div className="import-select">
     <label htmlFor="plan-select">현재 이야기</label>
     <select id="plan-select" value={activeId} onChange={e=>selectStory(e.target.value)}>
       {imports.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
     </select>
    </div>
    <div className="import-actions">
     <button type="button" className="light-btn" onClick={loadLocal}>저장된 계획 불러오기</button>
     <label className="light-btn import-file" htmlFor="json-file"><Symbol name="upload" size={15}/> JSON 가져오기</label>
     <input id="json-file" type="file" accept=".json,application/json" onChange={loadFile} className="visually-hidden"/>
    </div>
   </section>
   {error?<p className="feedback error" role="alert">{error}</p>:<p className="feedback" role="status">{notice}</p>}

   <div className="story-grid">
    <div className="story-left">
     <Scene frame={frame} input={story.input}/>
     <div className="playback-panel">
      <div className="timeline-meta"><span>시간 여행</span><span>{clampedAge}세 / {last}세</span></div>
      <input type="range" min={first} max={last} value={clampedAge} onChange={e=>changeAge(Number(e.target.value))} aria-label="이야기 연령 이동" className="age-slider"/>
      <div className="timeline-ends"><span>{first}세 · 시작</span><span>{last}세 · 계획 종료</span></div>
      <div className="playback-buttons">
       <button type="button" className="icon-btn" onClick={()=>jumpEvent(false)} disabled={nextEventAge(story.events,clampedAge,false)===null} title="이전 중요 이벤트" aria-label="이전 중요 이벤트"><Symbol name="prev"/></button>
       <button type="button" className="icon-btn" onClick={()=>changeAge(clampedAge-1)} disabled={clampedAge<=first} title="이전 해" aria-label="이전 해">−1</button>
       <button type="button" className="play-btn" onClick={()=>clampedAge===last?(setAge(first),setPlaying(true)):setPlaying(p=>!p)} aria-label={playing?'일시정지':'재생'}>
         <Symbol name={playing?'pause':'play'} size={19}/> {playing?'일시정지':clampedAge===last?'다시 재생':'재생'}
       </button>
       <button type="button" className="icon-btn" onClick={()=>changeAge(clampedAge+1)} disabled={clampedAge>=last} title="다음 해" aria-label="다음 해">+1</button>
       <button type="button" className="icon-btn" onClick={()=>jumpEvent(true)} disabled={nextEventAge(story.events,clampedAge,true)===null} title="다음 중요 이벤트" aria-label="다음 중요 이벤트"><Symbol name="next"/></button>
       <button type="button" className="speed" onClick={()=>setSpeed(v=>v===1?4:1)} aria-label="재생 속도">{speed}×</button>
      </div>
     </div>
     <AssetTrend frames={frames} index={index} hidden={hidden}/>
    </div>
    <div className="story-right">
     <StoryCard frame={frame} hidden={hidden}/>
     <Summary story={story} hidden={hidden}/>
    </div>
   </div>
   <section className="milestones">
    <div className="section-head"><div><p className="eyebrow">LIFE EVENTS</p><h2>앞으로 등장할 장면</h2></div><span>이벤트를 누르면 해당 나이로 이동</span></div>
    <div className="event-list">
     {eventsAround.length?eventsAround.map(e=><button type="button" key={e.id} className={`event-row ${e.age===clampedAge?'selected':''}`} onClick={()=>changeAge(e.age)}>
      <span className="event-bullet"/><span className="event-age">{e.age}세 <small>{e.year}년</small></span>
      <span className="event-body"><b>{e.title}</b><small>{e.detail}</small></span><Symbol name="arrow" size={17}/>
     </button>):<p className="empty-event">계획 종료까지 남은 중요 이벤트가 없다.</p>}
    </div>
   </section>
   <section className="choices" aria-label="은퇴 후 선택지 비교">
    <div className="section-head"><div><p className="eyebrow">WHAT IF</p><h2>다른 선택을 했다면?</h2></div><span>계산 경로만 비교하며 저장된 계획은 바꾸지 않는다</span></div>
    <div className="choice-grid">
     {choices.map(c=><button type="button" key={c.id} className={`choice ${choice===c.id?'active':''}`} onClick={()=>onChoice(c.id)} aria-pressed={choice===c.id}>
      <span className="choice-tag">{c.tag}</span><strong>{c.label}</strong><small>{c.detail}</small>
     </button>)}
    </div>
    {choice!=='base'&&<div className="comparison" role="status">
     <b>기준 계획 대비 변화</b>
     <div><span>준비율</span><strong>{original.result.readinessRatio}% → {story.result.readinessRatio}%</strong></div>
     <div><span>자산 소진 나이</span><strong>{original.result.depletionAge??'없음'} → {story.result.depletionAge??'없음'}</strong></div>
     <button type="button" onClick={()=>onChoice('base')}><Symbol name="refresh" size={16}/> 기준 계획 복원</button>
    </div>}
   </section>
   <footer>
     <div><b>RETIREMENT STORY</b><p>계산 결과를 이야기로 읽는 개인 은퇴 계획 도구.</p></div>
     <p>모든 수치는 기존 은퇴 시뮬레이터의 연 단위 현금흐름 모형에서 나온 현재가치 기준 추정이다. 미래나 개인의 수명을 예측하지 않는다. 자녀 대학·독립은 설정 기반 시뮬레이션 이벤트다. 투자·대출·연금 관련 결정에는 별도 검증이 필요하다.</p>
   </footer>
  </main>
 </div>;
}
