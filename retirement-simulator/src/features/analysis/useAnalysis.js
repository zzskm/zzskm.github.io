import {useEffect,useRef,useState} from 'react';
import {createLRU,simulationKey} from '../../model/cache.js';
import {runMonteCarlo} from '../../model/monteCarlo.js';
const cache=createLRU(12);
export function useAnalysis(input) {
 const key=simulationKey(input);
 const [state,setState]=useState(null),[error,setError]=useState(null),[retry,setRetry]=useState(0);
 const sequence=useRef(0);
 useEffect(()=>{
  const requestId=++sequence.current;
  let worker,cancelled=false;
  setError(null);
  const cached=cache.get(key);
  if(cached){setState(cached);return;}
  const timer=setTimeout(()=>{
   // Older browsers retain deterministic results and a smaller MC run.
   if(typeof Worker==='undefined'){
    const mc=runMonteCarlo(input,undefined,{runs:200});
    if(!cancelled){setState({key,mc,insights:null,targets:null});setError('이 브라우저는 백그라운드 계산을 지원하지 않아 성공 비율만 간략 계산했습니다. 최신 브라우저에서 조정 범위를 확인해주세요.');}return;
   }
   try {
    worker=new Worker(new URL('./analysisWorker.js',import.meta.url),{type:'module'});
    worker.onmessage=({data})=>{
     if(cancelled||data.requestId!==sequence.current||data.key!==key)return;
     if(data.error){setError(`분석 계산 실패: ${data.error}`);worker.terminate();return;}
     cache.set(key,data);setState(data);worker.terminate();
    };
    worker.onerror=()=>{if(!cancelled)setError('분석을 불러오지 못했습니다. 다시 계산해주세요.');worker.terminate();};
    worker.postMessage({requestId,key,input});
   }catch{if(!cancelled)setError('분석 Worker를 시작하지 못했습니다. 다시 계산해주세요.');}
  },300);
  return ()=>{cancelled=true;clearTimeout(timer);worker?.terminate();};
 },[key,retry]);
 return {state,error,stale:!!state&&state.key!==key,retry:()=>setRetry(n=>n+1)};
}
