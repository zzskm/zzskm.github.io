import { useContext, useState } from "react";
import { FieldContext } from "./NumericField.jsx";
import React from "react";

function Toggle({ label, value, onChange, hint }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-700">{label}</div>
        {hint && <div className="text-[11px] text-slate-500 leading-snug">{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={!!value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={`relative w-10 h-6 shrink-0 rounded-full transition ${value ? 'bg-slate-900' : 'bg-slate-300'}`}
      >
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-5' : 'left-1'}`} />
      </button>
    </div>
  );
}

function Section({ title, summary, defaultOpen, children }) {
  const context = useContext(FieldContext);
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <details className="mb-2 border-b border-slate-100 last:border-b-0" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="flex items-center justify-between py-2 select-none">
        <div className="flex items-center gap-1.5">
          <span className="chev text-slate-400 text-xs">▶</span>
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</span>
        </div>
        {summary && <span className="text-[11px] text-slate-500 num">{summary}</span>}
      </summary>
      <div className="pt-1 pb-3">{context.onResetSection && <div className="text-right mb-2"><button type="button" className="text-xs text-slate-500 underline" onClick={() => context.onResetSection(title)}>{title} 기본값 복원</button></div>}{children}</div>
    </details>
  );
}

function SummaryCard({ label, value, color, sub, title, large }) {
  const colorMap = {
    red:   "bg-red-50 border-red-200 text-red-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    green: "bg-emerald-50 border-emerald-200 text-emerald-900",
    blue:  "bg-blue-50 border-blue-200 text-blue-900",
    slate: "bg-slate-50 border-slate-200 text-slate-900",
  };
  return (
    <div className={`rounded-lg border p-3 ${colorMap[color] || colorMap.slate}`} title={title || undefined}>
      <div className="text-xs opacity-80 mb-1 flex items-center gap-1">
        <span>{label}</span>
        {title && <span className="opacity-70 cursor-help" role="img" aria-label={`설명: ${title}`}>ⓘ</span>}
      </div>
      <div className={`font-semibold num ${large ? "text-3xl" : "text-xl"}`}>{value}</div>
      {sub && <div className="text-xs opacity-80 mt-1">{sub}</div>}
    </div>
  );
}

function readinessColor(ratio) {
  if (ratio < 80) return "red";
  if (ratio < 110) return "amber";
  if (ratio < 150) return "green";
  return "blue";
}
function readinessLabel(ratio) {
  if (ratio < 80) return "위험";
  if (ratio < 110) return "경계";
  if (ratio < 150) return "안정";
  return "매우 안정";
}

// ============================================================
// Verdict 시스템 — 결론·진단의 공통 기반
// ============================================================


export { Toggle, Section, SummaryCard, readinessColor, readinessLabel };
