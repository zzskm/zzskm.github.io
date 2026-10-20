import { normalizeInput } from './migration.js';
import { KR_DEFAULTS } from '../model/defaults.js';
export const WIZARD_DRAFT_PREFIX='retirement-sim-wizard-draft:';
export function readWizardDraft(id, storage) {
 try {
  storage ??= globalThis.localStorage;
  const raw=storage?.getItem(WIZARD_DRAFT_PREFIX+id);if(!raw||raw.length>100000)return null;
  const d=JSON.parse(raw);
  if(d.version!==1||!Number.isInteger(d.step)||d.step<0||d.step>4||!d.input||!Array.isArray(d.changed))return null;
  for(const [k,v] of Object.entries(d.input)) if(typeof KR_DEFAULTS[k]==='number'&&(typeof v!=='number'||!Number.isFinite(v)))return null;
  return d;
 }catch{return null;}
}
export function saveWizardDraft(id, state, storage) {
 try {storage ??= globalThis.localStorage;storage.setItem(WIZARD_DRAFT_PREFIX+id,JSON.stringify({...state,version:1}));return true;}catch{return false;}
}
export function removeWizardDraft(id, storage) {
 try {storage ??= globalThis.localStorage;storage.removeItem(WIZARD_DRAFT_PREFIX+id);}catch{}
}
export function wizardErrors(input, step) {
 const e={};
 if(step===0) {
  if(!Number.isInteger(input.currentAge)||input.currentAge<25||input.currentAge>70)e.currentAge='현재 나이는 25~70세로 입력해주세요.';
  if(!Number.isInteger(input.retireAge)||input.retireAge<=input.currentAge||input.retireAge>75)e.retireAge='퇴직 나이는 현재 나이보다 크고 75세 이하여야 합니다.';
  if(input.retireAge>=input.selfLifeExpectancy)e.retireAge='퇴직 나이는 계획 수명보다 작아야 합니다.';
 }
 if(step===1&&input.spouseEnabled&&input.spouseRetireAge<=input.spouseCurrentAge)e.spouseRetireAge='배우자 퇴직 나이는 현재 나이보다 커야 합니다.';
 if(step===2&&input.selfNpInputMode==='manual'&&input.selfNpManualMonthly<0)e.selfNpManualMonthly='연금 예상액은 0 이상이어야 합니다.';
 if(step===3&&input.housingMode==='jeonse'&&input.deposit<=0)e.deposit='전세 보증금을 입력해주세요.';
 return e;
}
export function applyWizardDraft(initial,draft,fields) {
 const patch=Object.fromEntries(fields.filter(k=>k in KR_DEFAULTS).map(k=>[k,draft[k]]));
 return normalizeInput({...initial,...patch,_sources:{...initial._sources,...Object.fromEntries(Object.keys(patch).map(k=>[k,'user']))}});
}
