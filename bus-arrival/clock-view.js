/* General alarms render independently of bus data and bus HTML. */
window.ClockView = (() => {
  const BA=window.BusAlarm, R=window.AlertRuntime, mounts=new WeakSet();
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const remaining=ms=>{const n=Math.max(0,Math.ceil(ms/1000));return n>=3600?`${Math.floor(n/3600)}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`:`${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;};
  const until=ms=>{const m=Math.ceil(ms/60000);return m<=1?'1분 이내':m<60?`${m}분 후`:`${Math.floor(m/60)}시간 ${m%60?m%60+'분 ':''}후`;};
  function occurrence(c,now=Date.now()){
    if(!c.enabled)return Infinity;
    const today=BA.kstParts(now).date;
    for(let i=0;i<=7;i++){
      const date=new Date(Date.parse(today+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);
      if(c.days.length ? !c.days.includes(new Date(date+'T00:00:00Z').getUTCDay()) : c.date!==date)continue;
      const at=Date.parse(`${date}T${c.time}:00+09:00`);
      if(at>=now && at>=c.since)return at;
    }
    return Infinity;
  }
  function mount(panel,{simple=false}={}){
    if(mounts.has(panel))return;mounts.add(panel);
    panel.classList.add('clock-panel');
    panel.innerHTML=`
      <div class="next-alarm"><span class="metric-label">다음 알람</span><strong id="clock-next">등록된 알람이 없습니다</strong><span id="clock-next-detail" class="muted">필요한 시각에 나만의 알람을 설정하세요.</span></div>
      <div class="timer-section"><div class="section-label"><h3>빠른 타이머</h3><span class="muted">누르면 바로 시작</span></div><div id="timer-presets" class="timer-presets" role="group" aria-label="타이머 빠른 시작">${[5,10,15,30].map(n=>`<button type="button" data-min="${n}">${n}<span>분</span></button>`).join('')}</div><ul id="timer-list" class="clock-list" aria-label="실행 중인 타이머"></ul></div>
      <details id="timer-create" class="alarm-form-details"><summary>타이머 직접 입력</summary><form id="timer-form" class="timer-form"><label>분<input id="timer-custom" type="number" min="1" max="720" step="1" required inputmode="numeric"></label><label>이름 (선택)<input id="timer-label" type="text" maxlength="30" placeholder="예: 잠깐 휴식"></label><button type="submit">타이머 시작</button></form></details>
      <div class="section-label alarm-list-heading"><h3>시각 알람</h3><span class="muted">한국 시각</span></div>
      <ul id="clock-list" class="clock-list"></ul>
      <details id="clock-create" class="alarm-form-details"><summary>시각 알람 추가</summary>
        <form id="clock-form" class="clock-form"><div class="clock-inputs"><label>시각<input id="clock-time" type="time" value="18:00" required></label><label>이름 (선택)<input id="clock-label" type="text" maxlength="30" placeholder="예: 퇴근 준비"></label></div>
        <fieldset><legend>반복</legend><div class="repeat-presets"><button type="button" id="clock-once">한 번만</button><button type="button" id="clock-weekdays">평일</button><button type="button" id="clock-everyday">매일</button><button type="button" id="clock-custom-days">요일 선택</button></div><div id="clock-days" class="days" role="group" aria-label="반복 요일">${[1,2,3,4,5,6,0].map(d=>`<button type="button" data-day="${d}" aria-pressed="false">${['일','월','화','수','목','금','토'][d]}</button>`).join('')}</div></fieldset>
        <p id="clock-preview" class="muted" role="status"></p><label class="check"><input id="clock-bus" type="checkbox" ${simple?'':'checked'}>알람에 버스 정보 함께 표시</label>
        <div class="form-actions"><button type="submit">알람 추가</button><button id="clock-edit-cancel" type="button" hidden>수정 취소</button></div></form>
      </details><p id="clock-notice" class="clock-notice" role="status" hidden></p><div id="clock-undo-row" hidden><button type="button" id="clock-undo">삭제 되돌리기</button></div>
      <p class="alarm-footnote">버스 알림을 꺼도 동작합니다. 이 탭을 열어 두세요.</p>`;
    const $=id=>panel.querySelector('#'+id);
    let editing=null,undo=null,notice='',customDays=false,renderPending=false;
    const set=(id,text)=>{if($(id).textContent!==text)$(id).textContent=text;};
    const days=()=>[...$('clock-days').querySelectorAll('[aria-pressed="true"]')].map(b=>Number(b.dataset.day));
    function pickDays(values){$('clock-days').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(values.includes(Number(b.dataset.day)))));preview();}
    function input(){return {time:$('clock-time').value,label:$('clock-label').value.trim(),days:days(),bus:$('clock-bus').checked};}
    function preview(){
      const value=input(), c=BA.newClock(value,Date.now()),d=value.days;
      ['clock-once','clock-weekdays','clock-everyday','clock-custom-days'].forEach((id,i)=>$(id).setAttribute('aria-pressed',String(i===0?d.length===0&&!customDays:i===1?d.length===5&&[1,2,3,4,5].every(n=>d.includes(n)):i===2?d.length===7:customDays)));
      $('clock-days').hidden=!customDays && d.length===0;
      set('clock-preview',c?`${BA.clockOccurrenceText(c,Date.now())}${c.days.length?' 반복':'에 한 번'}`:'시각을 입력해 주세요.');
    }
    function tell(text,error=false){notice=text;set('clock-notice',text);$('clock-notice').hidden=!text;$('clock-notice').classList.toggle('is-error',error);}
    function reset(){editing=null;$('clock-label').value='';$('clock-bus').checked=!simple;customDays=false;pickDays([]);$('clock-form').querySelector('[type=submit]').textContent='알람 추가';$('clock-edit-cancel').hidden=true;$('clock-create').querySelector('summary').textContent='시각 알람 추가';}
    function focusAfterRemoval(active,box,fallback){if(active && !active.isConnected)(box.querySelector('button')||fallback)?.focus({preventScroll:true});}
    function sync(box,items,kind){
      const active=panel.getRootNode().activeElement || document.activeElement;
      const wanted=new Set(items.map(x=>x.id));[...box.children].forEach(li=>{if(!wanted.has(li.dataset.id)&&!(li.className==='empty'&&!items.length))li.remove();});
      items.forEach((item,i)=>{
        let li=[...box.children].find(x=>x.dataset.id===item.id);
        if(!li){li=document.createElement('li');li.dataset.id=item.id;li.innerHTML='<div class="clock-row-main"><span class="clock-time"></span><div class="clock-meta"><strong></strong><span></span></div></div><div class="clock-row-actions"></div>';box.append(li);}
        if(box.children[i]!==li)box.insertBefore(li,box.children[i]);
        const name=item.label||(kind==='clock'?'알람':'타이머');
        const values=[['.clock-time',kind==='clock'?item.time:remaining(item.endsAtMs-Date.now())],['.clock-meta strong',name],['.clock-meta span',kind==='clock'?BA.clockOccurrenceText(item,Date.now())+(item.bus?' · 버스 정보 포함':''):`${item.minutes}분 · ${new Date(item.endsAtMs).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Seoul'})} 종료`]];
        values.forEach(([selector,text])=>{const e=li.querySelector(selector);if(e.textContent!==text)e.textContent=text;});
        const actions=li.querySelector('.clock-row-actions');
        if(!actions.children.length)actions.innerHTML=kind==='clock'?'<button type="button" data-toggle role="switch"></button><button type="button" data-edit>수정</button><button type="button" data-del>삭제</button>':'<button type="button" data-cancel>취소</button>';
        if(kind==='clock'){const b=actions.querySelector('[data-toggle]');b.setAttribute('aria-checked',String(item.enabled));b.classList.toggle('on',item.enabled);b.textContent=item.enabled?'켜짐':'꺼짐';li.classList.toggle('is-disabled',!item.enabled);}
        actions.querySelectorAll('button').forEach(b=>b.setAttribute('aria-label',`${name} ${kind==='clock'?item.time:''} ${b.hasAttribute('data-toggle')?'알람':b.textContent}`));
      });
      if(!items.length && kind==='clock' && !box.querySelector('.empty')){const li=document.createElement('li');li.className='empty';li.textContent='등록된 알람이 없습니다.';box.append(li);}
      focusAfterRemoval(active,box,kind==='clock'?$('clock-create').querySelector('summary'):$('timer-presets').querySelector('button'));
    }
    function render(){
      if(document.hidden)return;
      const now=Date.now(),list=R.clocks().sort((a,b)=>occurrence(a,now)-occurrence(b,now)||a.time.localeCompare(b.time));
      const next=list.find(c=>Number.isFinite(occurrence(c,now)));
      set('clock-next',next?`${next.time} · ${next.label||'알람'}`:'등록된 알람이 없습니다');
      set('clock-next-detail',next?`${BA.clockOccurrenceText(next,now)} · ${until(occurrence(next,now)-now)}`:list.length?'켜진 알람이 없습니다.':'필요한 시각에 나만의 알람을 설정하세요.');
      sync($('clock-list'),list,'clock');sync($('timer-list'),R.timers(),'timer');
      if(undo && now>undo.until)undo=null;$('clock-undo-row').hidden=!undo;
      if(R.state.storageError)tell('저장 실패 · 현재 탭에서만 적용됩니다. 새로 열면 유지되지 않을 수 있습니다.',true);
    }
    function requestRender(){if(renderPending||document.hidden)return;renderPending=true;requestAnimationFrame(()=>{renderPending=false;render();});}
    // Validate synchronously so the form can clear right away without racing the next entry.
    function start(minutes){
      const timer=BA.newTimer(minutes,$('timer-label').value.trim(),Date.now()),full=`타이머는 최대 ${BA.MAX_TIMERS}개까지 시작할 수 있습니다.`;
      if(!timer){$('timer-create').open=true;$('timer-custom').focus();return false;}
      if(R.timers().length>=BA.MAX_TIMERS){tell(full,true);return false;}
      R.prepare();
      R.mutate(()=>{const list=R.timers();if(list.length>=BA.MAX_TIMERS){tell(full,true);return;}R.write(R.keys.timers,[...list,timer]);tell(`${timer.label||timer.minutes+'분 타이머'}를 시작했습니다.`);}).then(requestRender);
      return true;
    }
    $('timer-presets').addEventListener('click',e=>{const b=e.target.closest('[data-min]');if(b)start(Number(b.dataset.min));});
    $('timer-form').addEventListener('submit',e=>{e.preventDefault();if(start(Number($('timer-custom').value)))$('timer-custom').value='';});
    $('timer-list').addEventListener('click',e=>{const b=e.target.closest('[data-cancel]');if(b)R.mutate(()=>{R.write(R.keys.timers,R.timers().filter(t=>t.id!==b.closest('li').dataset.id));tell('타이머를 취소했습니다.');});});
    $('clock-days').addEventListener('click',e=>{const b=e.target.closest('[data-day]');if(b){customDays=true;b.setAttribute('aria-pressed',String(b.getAttribute('aria-pressed')!=='true'));preview();}});
    [['clock-once',[]],['clock-weekdays',[1,2,3,4,5]],['clock-everyday',[0,1,2,3,4,5,6]]].forEach(([id,d])=>$(id).addEventListener('click',()=>{customDays=false;pickDays(d);}));
    $('clock-custom-days').addEventListener('click',()=>{customDays=true;preview();$('clock-days').hidden=false;$('clock-days').querySelector('button').focus();});
    $('clock-form').addEventListener('input',preview);
    $('clock-form').addEventListener('submit',async e=>{
      e.preventDefault();if(customDays&&!days().length){tell('반복할 요일을 선택하거나 한 번만을 선택해 주세요.',true);return;}
      const value=BA.newClock(input(),Date.now());if(!value)return;
      const id=editing;let saved=false;R.prepare();
      await R.mutate(()=>{
        const list=R.clocks();if(!id&&list.length>=BA.MAX_CLOCKS){tell(`알람은 최대 ${BA.MAX_CLOCKS}개까지 등록할 수 있습니다.`,true);return;}
        if(id&&!list.some(c=>c.id===id)){tell('다른 화면에서 삭제된 알람입니다. 새 알람으로 등록해 주세요.',true);return;}
        if(id){value.id=id;const ledger=R.read(R.keys.ledger)||{};Object.keys(ledger).filter(k=>k.startsWith(id+'|')).forEach(k=>delete ledger[k]);R.write(R.keys.ledger,ledger);}
        R.write(R.keys.clocks,id?list.map(c=>c.id===id?value:c):[...list,value]);saved=true;tell(id?'알람을 수정했습니다.':'알람을 추가했습니다.');
      });
      if(saved){reset();$('clock-create').open=false;$('clock-create').querySelector('summary').focus();}requestRender();
    });
    $('clock-edit-cancel').addEventListener('click',()=>{reset();$('clock-create').open=false;$('clock-create').querySelector('summary').focus();});
    $('clock-list').addEventListener('click',e=>{
      const li=e.target.closest('li[data-id]');if(!li)return;const id=li.dataset.id;
      if(e.target.closest('[data-edit]')){
        const c=R.clocks().find(c=>c.id===id);if(!c)return;editing=id;$('clock-time').value=c.time;$('clock-label').value=c.label;$('clock-bus').checked=c.bus;customDays=c.days.length>0;pickDays(c.days);
        $('clock-form').querySelector('[type=submit]').textContent='변경 저장';$('clock-create').querySelector('summary').textContent='시각 알람 수정';$('clock-edit-cancel').hidden=false;$('clock-create').open=true;$('clock-time').focus();return;
      }
      if(e.target.closest('[data-toggle]')){if(!R.clocks().find(c=>c.id===id)?.enabled)R.prepare();R.mutate(()=>{R.write(R.keys.clocks,R.clocks().map(c=>c.id===id?(c.enabled?{...c,enabled:false}:BA.rearmClock(c,Date.now())):c));});}
      if(e.target.closest('[data-del]'))R.mutate(()=>{const list=R.clocks(),c=list.find(c=>c.id===id);if(!c)return;undo={clock:c,until:Date.now()+10000};R.write(R.keys.clocks,list.filter(c=>c.id!==id));tell('알람을 삭제했습니다. 10초 안에 되돌릴 수 있습니다.');}).then(()=>{render();if(undo)$('clock-undo').focus({preventScroll:true});});
    });
    $('clock-undo').addEventListener('click',()=>R.mutate(()=>{if(!undo||Date.now()>undo.until)return;const list=R.clocks();if(list.length>=BA.MAX_CLOCKS)return;if(!list.some(c=>c.id===undo.clock.id))R.write(R.keys.clocks,[...list,undo.clock]);undo=null;tell('삭제한 알람을 복구했습니다.');$('clock-create').querySelector('summary').focus();}));
    R.subscribe(requestRender);R.onTick(requestRender);reset();render();
  }
  return {mount,occurrence};
})();
