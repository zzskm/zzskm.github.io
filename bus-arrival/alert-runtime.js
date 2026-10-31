/* Bus notification/audio/scheduling lifetime per document. */
window.AlertRuntime = (() => {
  'use strict';
  const BA = window.BusAlarm;
  const listeners = new Set(), ticks = new Set(), evaluators = new Map();
  const audio = {ctx:null, master:null};
  const state = {audioError:false, permissionError:false, storageError:false};
  let root, worker, interval, pending = false, notification = null, lastTag = '';
  const queue = [];
  const $ = id => root?.querySelector('#'+id);
  function busAlarmEnabled() {
    try { return JSON.parse(localStorage.getItem('busAlarm.v1.cfg'))?.enabled === true; }
    catch { return false; }
  }
  function emit() { listeners.forEach(fn => fn()); }
  function ensureAudio() {
    const AC=window.AudioContext || window.webkitAudioContext;
    if (!AC) { emit(); return null; }
    try {
      if (!audio.ctx || audio.ctx.state==='closed') {
        audio.ctx=new AC();
        audio.ctx.addEventListener('statechange',()=>{ if(audio.ctx.state==='running')state.audioError=false; emit(); });
      }
      state.audioError=false;
      if(audio.ctx.state!=='running') Promise.resolve(audio.ctx.resume()).then(()=>{state.audioError=false;emit();}).catch(()=>{state.audioError=true;emit();});
    } catch {state.audioError=true;emit();return null;}
    emit();return audio.ctx;
  }
  function requestPermission() {
    if(!('Notification' in window) || Notification.permission!=='default')return;
    try {Promise.resolve(Notification.requestPermission()).then(()=>{state.permissionError=false;emit();}).catch(()=>{state.permissionError=true;emit();});}
    catch {state.permissionError=true;emit();}
  }
  // Call from an explicit click that creates or re-enables an alarm, never from saves or refreshes.
  function prepare(){ensureAudio();requestPermission();}
  function readiness(){
    const AC=window.AudioContext || window.webkitAudioContext;
    return {permission:'Notification' in window ? Notification.permission : 'unsupported',
      sound:!AC ? 'unsupported' : audio.ctx?.state==='running' ? 'ready' : 'locked'};
  }
  function stopBeeps() {
    if(audio.master){try{audio.master.gain.value=0;audio.master.disconnect();}catch{}audio.master=null;}
  }
  function playBeeps(seconds=45) {
    const ctx=ensureAudio(); if(!ctx || ctx.state!=='running')return;
    stopBeeps(); const master=ctx.createGain(); master.gain.value=.35;master.connect(ctx.destination);audio.master=master;
    const t0=ctx.currentTime+.05;
    BA.beepSchedule(seconds).forEach(b=>{
      const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='sine';osc.frequency.value=b.freq;
      gain.gain.setValueAtTime(0,t0+b.t);gain.gain.linearRampToValueAtTime(1,t0+b.t+.02);gain.gain.linearRampToValueAtTime(0,t0+b.t+b.dur);
      osc.connect(gain);gain.connect(master);osc.start(t0+b.t);osc.stop(t0+b.t+b.dur+.05);
    });
  }
  function closeNotification(){const n=notification;notification=null;if(n){try{n.close();}catch{}}}
  function present() {
    const item=queue[0], banner=$('alarm-banner');
    if(!banner)return;
    banner.hidden=!item;
    if($('alarm-queue-count'))$('alarm-queue-count').textContent=queue.length>1 ? `미확인 ${queue.length}개` : '';
    if($('alarm-ack-all'))$('alarm-ack-all').hidden=queue.length<2;
    if(!item){lastTag='';stopBeeps();closeNotification();emit();return;}
    if($('alarm-banner-text'))$('alarm-banner-text').textContent=`${item.source} · ${item.msg.title} — ${item.msg.body}`;
    if(item.tag!==lastTag){
      lastTag=item.tag;stopBeeps();closeNotification();
      if($('sr-live'))$('sr-live').textContent=`${item.source}. ${item.msg.title}. ${item.msg.body}`;
      if(!item.silent)playBeeps();
      if('Notification' in window && Notification.permission==='granted'){
        try{
          const n=new Notification(item.msg.title,{body:item.msg.body,tag:item.tag,renotify:true,requireInteraction:true});notification=n;
          n.onclick=()=>{window.focus();if(notification===n)ack();};
          n.onclose=()=>{if(notification===n)ack();};
        }catch{state.permissionError=true;}
      }
    }
    emit();
  }
  function showRing(msg,tag,silent=false,source='버스') {
    if(queue.some(x=>x.tag===tag))return;
    queue.push({msg,tag,silent,source});present();
  }
  function ack(all=false){if(all)queue.length=0;else queue.shift();present();}
  function clearBus(){for(let i=queue.length-1;i>=0;i--)if(queue[i].source==='버스')queue.splice(i,1);present();}
  function locked(fn,available=false){
    if(navigator.locks?.request)return navigator.locks.request('busAlarm:eval',available?{ifAvailable:true}:{},lock=>{if(lock)return fn();});
    return Promise.resolve(fn());
  }
  function evaluateInside() {
    const now=Date.now();
    // Evaluate only registered bus alerts. Legacy clock/timer data is never executed.
    evaluators.forEach((fn,name)=>{try{fn(now);}catch(error){console.error('AlertRuntime evaluator failed:',name,error);}});
    emit();
  }
  function evaluate(){
    if(pending)return;pending=true;
    return locked(evaluateInside,true).finally(()=>{pending=false;});
  }
  function tick(){evaluate();ticks.forEach(fn=>fn());}
  function init(target=document){
    if(root)return;root=target;
    $('alarm-ack')?.addEventListener('click',()=>ack());
    $('alarm-ack-all')?.addEventListener('click',()=>ack(true));
    window.addEventListener('keydown',e=>{if(e.key==='Escape'&&queue.length)ack();});
    const unlock=()=>{if(audio.ctx?.state==='running')return;if(busAlarmEnabled())ensureAudio();};
    window.addEventListener('pointerdown',unlock);window.addEventListener('keydown',unlock);
    window.addEventListener('storage',()=>{tick();});
    window.addEventListener('focus',emit);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick();});
    window.addEventListener('pageshow',e=>{if(e.persisted)tick();});
    if(navigator.permissions?.query)navigator.permissions.query({name:'notifications'}).then(s=>s.addEventListener('change',emit)).catch(()=>{});
    interval=setInterval(tick,1000);
    try{
      const url=URL.createObjectURL(new Blob(['setInterval(function(){postMessage(0)},1000)'],{type:'text/javascript'}));
      worker=new Worker(url);URL.revokeObjectURL(url);worker.onmessage=()=>{if(document.hidden)tick();};
    }catch{}
    window.addEventListener('pagehide',e=>{if(!e.persisted){clearInterval(interval);worker?.terminate();stopBeeps();}});
    tick();
  }
  return {init,audio,state,ensureAudio,requestPermission,prepare,readiness,showRing,ack,clearBus,evaluate,
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    onTick(fn){ticks.add(fn);return()=>ticks.delete(fn);},
    addEvaluator(name,fn){evaluators.set(name,fn);},
    get ringing(){return queue.length>0;},get queue(){return [...queue];}};
})();
