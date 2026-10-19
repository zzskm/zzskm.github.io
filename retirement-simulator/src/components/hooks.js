import React, { useState, useEffect, useRef } from "react";

function useDebugMode() {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get("debug") === "1";
}

// 뷰포트가 width(px) 미만인지. 640 = 모바일(차트 높이 등), 1024 = 입력/결과가 세로로 쌓이는 구간(탭 전환)
function useIsMobile(width = 640) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < width);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < width);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [width]);
  return isMobile;
}

// ============================================================
// UI: 편집 가능 슬라이더
// ============================================================

// ±버튼 장누름 연속 증감 헬퍼
function useHoldRepeat(action, { initialDelay = 500, intervalMs = 80 } = {}) {
  const timeoutRef = useRef(null);
  const intervalRef = useRef(null);
  const actionRef = useRef(action);
  useEffect(() => { actionRef.current = action; }, [action]);
  const stop = () => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };
  const start = () => {
    stop();
    actionRef.current();
    timeoutRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => actionRef.current(), intervalMs);
    }, initialDelay);
  };
  useEffect(() => stop, []);
  return { start, stop };
}


export { useDebugMode, useIsMobile, useHoldRepeat };
