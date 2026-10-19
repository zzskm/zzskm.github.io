import { computeAnalysis } from './computeAnalysis.js';
self.onmessage=({data})=>{
 try { self.postMessage({requestId:data.requestId,key:data.key,...computeAnalysis(data.input)}); }
 catch(error) { self.postMessage({requestId:data.requestId,key:data.key,error:error.message||'계산에 실패했습니다.'}); }
};
