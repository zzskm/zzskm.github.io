import React, { useState, useRef } from "react";

function ScenarioNameEditor({ name, color, onRename }) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  if (!editing) {
    return (
      <button type="button" onClick={() => { cancelled.current = false; setEditing(true); }}
        title="이름 바꾸기" aria-label={`시나리오 이름 바꾸기: ${name}`}
        className="text-sm font-semibold truncate max-w-full text-left hover:underline decoration-dotted" style={{ color }}>
        {name} <span className="text-slate-400 text-xs" aria-hidden="true">✎</span>
      </button>
    );
  }
  return (
    <input autoFocus defaultValue={name} maxLength={20} aria-label="시나리오 이름"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => { if (!cancelled.current) onRename(e.target.value); setEditing(false); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") { cancelled.current = true; e.currentTarget.blur(); }
      }}
      className="text-sm font-semibold border-b border-slate-400 focus:outline-none w-full bg-transparent" style={{ color }} />
  );
}


export { ScenarioNameEditor };
