import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { basisAnnualToNet, netToBasisAnnual } from '../model/taxation.js';
import { parseNumericDraft } from '../utils/units.js';
import { fmt만원 } from '../utils/formatting.js';
export const FieldContext = createContext({});

export function NumericField({ label, value, min = 0, max = 100000000, step = 1, onChange, format, hint, changed, showAnnual, unit, typedMax, fieldKey, slider = true, integer = false }) {
  const id = useId();
  const context = useContext(FieldContext);
  const [scale, setScale] = useState(1);
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState('');
  const cancelled = useRef(false);
  const hardMax = Math.max(max, typedMax ?? max);
  useEffect(() => { if (!focused) setDraft(String((value ?? 0) / scale)); }, [value, scale, focused]);
  const isInteger = integer || ['세', '년'].includes(unit);
  const parsed = parseNumericDraft(draft, { value, min, max: hardMax, scale, integer: isInteger });
  const commit = () => {
    setFocused(false);
    if (cancelled.current) { cancelled.current = false; setError(''); return; }
    if (!parsed.valid) { setError(parsed.error); return; }
    setError('');
    setDraft(String(parsed.value / scale));
    if (parsed.value !== value) onChange(parsed.value);
  };
  const externalError = fieldKey && context.errors?.[fieldKey];
  const source = context.input?._sources?.[fieldKey];
  const conversion = focused && parsed.valid ? parsed.value : value;
  return <div className="mb-4 numeric-field">
    <div className="flex justify-between gap-2 items-baseline mb-1">
      <label htmlFor={id} className="text-xs text-slate-700">{label}{changed && <span aria-hidden="true" title="기본값에서 변경됨"> ●</span>}</label>
      {fieldKey && context.onReset && <span className="text-[11px] text-slate-500">{source === 'user' ? '직접 입력' : '저장값·기본 추정'} <button type="button" aria-label={`${label} 기본값 복원`} onClick={() => context.onReset?.(fieldKey)}>↺</button></span>}
    </div>
    <div className="flex gap-2 items-center">
      <input id={id} data-field-key={fieldKey} type="text" inputMode={isInteger ? 'numeric' : 'decimal'} value={draft}
        aria-invalid={!!(error || externalError)} aria-describedby={`${id}-help`} autoComplete="off"
        onFocus={() => { setFocused(true); cancelled.current = false; }}
        onChange={e => { setDraft(e.target.value); setError(''); context.onValidityChange?.(fieldKey ?? label, !parseNumericDraft(e.target.value, {value,min,max:hardMax,scale,integer:isInteger}).valid); }} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; context.onValidityChange?.(fieldKey ?? label, false); setDraft(String(value / scale)); e.currentTarget.blur(); } }}
        className="num w-full min-w-0 border border-slate-300 rounded-md px-3 py-2 text-right focus:ring-2 focus:ring-blue-500" />
      {unit === '만원' ? <select data-unit-key={fieldKey} aria-label={`${label} 금액 단위`} value={scale} onChange={e => { setScale(Number(e.target.value)); setFocused(false); setError(''); }} className="border rounded px-1 py-2"><option value="1">만원</option><option value="10000">억원</option></select> : <span className="text-xs whitespace-nowrap">{unit}</span>}
    </div>
    <div id={`${id}-help`} className="text-[11px] mt-1 text-slate-500" aria-live="polite">
      {(error || externalError) && <p role="alert" className="text-red-700">{error || externalError}</p>}
      {format && <p>{format(conversion)}</p>}
      {showAnnual && <p>연 {Math.round(Number(conversion) * 12).toLocaleString()}만원</p>}
      {hint && <p>{hint}</p>}
    </div>
    {slider && <details className="mt-1"><summary className="text-[11px] text-slate-500 py-1">슬라이더로 빠르게 조정</summary><input type="range" min={Math.min(min, value)} max={Math.max(max, value)} step={step} value={value} aria-label={`${label} 빠른 조정`} onChange={e => { setError(''); onChange(Number(e.target.value)); }} className="w-full my-2" /></details>}
  </div>;
}
// Compatibility alias keeps existing input panels and their conditional fields intact.
export const Slider = NumericField;
export function NumberInput({ label, value, onChange, suffix }) {
  return <NumericField label={label} value={value ?? 0} onChange={onChange} unit={suffix} min={0} max={9999} integer slider={false} />;
}
export function SalaryInput({ name, netAnnual, basis, onChangeNet, onChangeBasis }) {
  const annual = netToBasisAnnual(netAnnual, basis);
  return <div className="mb-4">
    <div className="flex justify-between items-center text-xs mb-2"><b>{name}</b><div role="group" aria-label={`${name} 세전/세후 선택`}>{[['gross','세전'],['net','세후']].map(([v,l])=><button type="button" key={v} aria-pressed={basis===v} onClick={()=>onChangeBasis(v)} className={`px-3 py-2 border rounded ${basis===v?'bg-slate-900 text-white':''}`}>{l}</button>)}</div></div>
    <NumericField key={`annual-${basis}`} label={`${name} 연봉`} value={Math.round(annual)} onChange={v=>onChangeNet(basisAnnualToNet(v,basis))} max={1000000} unit="만원" slider={false} />
    <NumericField key={`monthly-${basis}`} label={`${name} 월급`} value={Math.round(annual / 12 * 100) / 100} onChange={v=>onChangeNet(basisAnnualToNet(v*12,basis))} max={100000} unit="만/월" slider={false} />
    <p className="text-[11px] text-slate-500">세후 약 {fmt만원(netAnnual)}/년 · 월 {Math.round(netAnnual/12).toLocaleString()}만원{basis==='gross'?' (4대보험·본인 1인 공제 기준 추정)':''}</p>
  </div>;
}