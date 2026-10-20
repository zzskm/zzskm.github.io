import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles/main.css';
class ErrorBoundary extends React.Component {
 state = { failed: false };
 static getDerivedStateFromError() { return { failed: true }; }
 render() { return this.state.failed ? <div role="alert" className="p-6">화면을 표시하지 못했습니다. 저장 설정을 지우지 않고 새로고침해주세요.</div> : this.props.children; }
}
window.addEventListener('error', e => { if (e.target?.tagName === 'SCRIPT') document.getElementById('boot-error').style.display = 'flex'; }, true);
createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
