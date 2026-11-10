const $ = id => document.getElementById(id);
const status = $('assembly-status');
try {
  const response = await fetch('assembly.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const key = `${document.documentElement.dataset.store}-interactive`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
  if (typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  let index = Math.max(0, data.steps.findIndex(s => s.id === saved.step));
  let selected = null, viewer = null, focusOnly = false, keepView = !!saved.keepView;
  const remember = () => { try { localStorage.setItem(key, JSON.stringify(saved)); } catch {} };
  const parts = new Map(data.parts.map(p => [p.id, p]));
  const picker = $('asm-step');
  data.steps.forEach((s, i) => picker.add(new Option(`${String(i + 1).padStart(2, '0')} · ${s.title}`, i)));
  $('asm-tools').innerHTML = data.tools;
  function show() { viewer?.show({...data.steps[index], focusOnly}, selected, +$('asm-explode').value); }
  function syncDone() {
    $('asm-done').checked = !!document.getElementById(`as-${data.steps[index].id}`)?.checked;
    const n = data.steps.filter(s => document.getElementById(`as-${s.id}`)?.checked).length;
    $('asm-progress').textContent = `${n} / ${data.steps.length} 완료`;
    $('asm-complete-next').textContent = index === data.steps.length-1 ? '조립 확인 완료 ✓' : '완료하고 다음 →';
    document.querySelectorAll('#asm-phases button').forEach(b => {
      const current = data.steps[index].phase === b.dataset.phase;
      b.setAttribute('aria-current', current ? 'step' : 'false');
    });
  }
  // fromView: picked by clicking the model, so the camera stays where the user put it.
  function selectPart(id, fromView = false) {
    selected = selected === id ? null : id;
    show();
    if (selected && !fromView && viewer && !$('asm-canvas').hidden) viewer.frame(selected);
    const p = parts.get(selected);
    $('asm-picked').textContent = p ? `${p.label} · ${p.mesh ? (viewer && !$('asm-canvas').hidden ? '선택한 부품' : '3D 보기에서 위치를 확인할 수 있습니다') : '전체 부품 목록에서 규격 확인'}` : '';
    list(); tray();
  }
  function thumb(p) {
    const span = document.createElement('span'); span.className = 'part-thumb';
    if (p.illustration) {
      const img = document.createElement('img');
      img.src = p.illustration;
      img.alt = '';
      span.append(img);
    } else {
      span.textContent = p.mesh ? '부품' : '준비물';
    }
    return span;
  }
  function tray() {
    const host = $('asm-tray'); host.replaceChildren();
    for (const [id, qty] of Object.entries(data.steps[index].needs)) {
      const p = parts.get(id), b = document.createElement('button');
      b.className = 'tray-part'; b.type = 'button'; b.setAttribute('aria-pressed', String(selected === id));
      const label = document.createElement('span'); label.innerHTML = p.label;
      const count = document.createElement('strong'); count.textContent = `× ${qty}`;
      b.append(thumb(p), label, count); b.onclick = () => selectPart(id); host.append(b);
    }
  }
  function list() {
    const step = data.steps[index], all = $('asm-scope').value === 'all';
    const query = $('asm-search').value.trim().toLowerCase();
    const container = $('asm-parts'); container.replaceChildren();
    const entries = data.parts.filter(p => (all || p.id in step.needs) && `${p.label} ${p.detail}`.toLowerCase().includes(query));
    $('asm-parts-note').textContent = all ? '완성품 전체 수량. 준비 체크는 이 브라우저에 저장됩니다.' : '이번 작업의 사용량. 앞 단계 부품의 재확인도 포함합니다.';
    for (const p of entries) {
      const card = document.createElement('div'); card.className = 'assembly-part';
      card.classList.toggle('selected', selected === p.id);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'part-select';
      b.setAttribute('aria-pressed', String(selected === p.id));
      const info = document.createElement('span');
      info.innerHTML = `<small>${p.category}</small><strong>${p.label}</strong>`;
      const qty = document.createElement('span'); qty.textContent = `× ${all ? p.qty : step.needs[p.id]}`;
      info.append(qty); b.append(thumb(p), info); b.onclick = () => selectPart(p.id);
      const details = document.createElement('details');
      const title = document.createElement('summary'); title.textContent = '규격 · 용도';
      const desc = document.createElement('p'); desc.innerHTML = p.detail;
      if (p.size) { const dims = document.createElement('p'); dims.textContent = p.size; details.append(dims); }
      details.append(title,desc);
      const label = document.createElement('label'); label.className = 'tick';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !!saved[`part:${p.id}`];
      check.onchange = () => { saved[`part:${p.id}`] = check.checked; remember(); };
      label.append(check, ' 준비함'); card.append(b, details, label); container.append(card);
    }
    if (!entries.length) container.textContent = '해당하는 부품이 없습니다.';
  }
  const diagrams = $('asm-diagrams');
  function showDiagrams(step) {
    diagrams.replaceChildren();
    for (const d of step.diagrams || []) {
      const figure = document.createElement('figure'); if (d.wide) figure.className = 'wide';
      const link = document.createElement('a'); link.href = d.path; link.target = '_blank'; link.rel = 'noopener';
      const image = document.createElement('img');
      Object.assign(image, {src: d.path, alt: d.caption, width: d.width, height: d.height});
      const caption = document.createElement('figcaption'); caption.textContent = d.caption;
      link.append(image); figure.append(link, caption); diagrams.append(figure);
    }
    diagrams.hidden = !(step.diagrams || []).length;
  }
  function update() {
    const step = data.steps[index]; selected = null; focusOnly = false;
    $('asm-focus').setAttribute('aria-pressed','false');
    picker.value = index; $('asm-prev').disabled = index === 0; $('asm-next').disabled = index === data.steps.length - 1;
    $('asm-number').textContent = String(index+1).padStart(2,'0');
    $('asm-phase').textContent = step.phase.split(' · ')[0];
    $('asm-title').innerHTML = step.title; $('asm-x-title').textContent = `${String(index+1).padStart(2,'0')} · ${step.title.replace(/<[^>]+>/g,'')}`; $('asm-x-prev').disabled = index === 0; $('asm-x-next').disabled = index === data.steps.length - 1;
    $('asm-actions').replaceChildren();
    for (const action of step.quick || step.items || []) {
      const li = document.createElement('li'); li.innerHTML = action; $('asm-actions').append(li);
    }
    $('asm-body').innerHTML = (step.body ? `<p>${step.body}</p>` : '') + (step.items.length ? `<ol>${step.items.map(s=>`<li>${s}</li>`).join('')}</ol>` : '') + (step.note ? `<p class="note">${step.note}</p>` : '');
    $('asm-check').innerHTML = step.check ? `<b>✓ 확인</b><span>${step.check}</span>` : '';
    $('asm-fix').innerHTML = step.fix ? `<b>안 맞으면</b><p>${step.fix}</p>` : '';
    showDiagrams(step);
    $('asm-image').src = step.image;
    $('asm-drawing').src = step.illustration || step.image;
    $('asm-drawing').alt = `${step.title} 조립도`;
    $('asm-installed').textContent = '장착 후 보기';
    $('asm-installed').hidden = !step.installedIllustration || !$('asm-canvas').hidden; $('asm-detail').href = `#as-${step.id}`;
    $('asm-picked').textContent = ''; $('asm-explode').value = 0; $('asm-details').open = false;
    show(); if (!keepView) viewer?.view(step.view); saved.step = step.id; remember(); syncDone(); tray(); list();
  }
  const phases = [...new Set(data.steps.map(s=>s.phase))];
  phases.forEach((phase,i)=>{
    const b=document.createElement('button'); b.type='button'; b.dataset.phase=phase;
    b.textContent=`${i+1}. ${phase.split(' · ')[0]}`;
    b.onclick=()=>{index=data.steps.findIndex(s=>s.phase===phase);update();}; $('asm-phases').append(b);
  });
  $('asm-prev').onclick = () => { if(index>0){index--;update();} };
  $('asm-next').onclick = () => { if(index<data.steps.length-1){index++;update();} };
  picker.onchange=()=>{index=+picker.value;update();};
  $('asm-scope').onchange=list; $('asm-search').oninput=list;
  function complete(checked){const box=$(`as-${data.steps[index].id}`);if(box){box.checked=checked;box.dispatchEvent(new Event('change',{bubbles:true}));}syncDone();}
  $('asm-done').onchange=()=>complete($('asm-done').checked);
  $('asm-complete-next').onclick=()=>{complete(true);if(index<data.steps.length-1){index++;update();}};
  document.addEventListener('change',syncDone);
  $('reset')?.addEventListener('click',syncDone);
  $('asm-focus').onclick=()=>{focusOnly=!focusOnly;$('asm-focus').setAttribute('aria-pressed',String(focusOnly));show();};
  $('asm-explode').oninput=show;
  $('asm-keep').setAttribute('aria-pressed',String(keepView));
  $('asm-keep').onclick=()=>{keepView=!keepView;saved.keepView=keepView;remember();$('asm-keep').setAttribute('aria-pressed',String(keepView));};
  const go = d => { const next = index + d; if (next >= 0 && next < data.steps.length) { index = next; update(); } };
  $('asm-x-prev').onclick = () => go(-1); $('asm-x-next').onclick = () => go(1);
  function expand(on) {
    $('asm-visual').classList.toggle('expanded', on); document.documentElement.classList.toggle('asm-locked', on);
    $('asm-expand').setAttribute('aria-pressed', String(on)); $('asm-expand').textContent = on ? '작게 보기' : '크게 보기';
    if (on) $('asm-canvas').focus({preventScroll: true});
    // The canvas changes shape, so re-frame the step once the new size has been laid out.
    if (viewer && !$('asm-canvas').hidden) requestAnimationFrame(() => viewer?.view(data.steps[index].view, false));
  }
  $('asm-expand').onclick = () => expand(!$('asm-visual').classList.contains('expanded'));
  $('asm-x-close').onclick = () => expand(false);
  // ←/→ step through while the build sheet is on screen; Esc leaves the enlarged 3D view.
  document.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    if (e.key === 'Escape' && $('asm-visual').classList.contains('expanded')) { expand(false); return; }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const r = $('build-panel').getBoundingClientRect();
    if ($('build-panel').hidden || r.bottom < 0 || r.top > innerHeight) return;
    e.preventDefault(); go(e.key === 'ArrowLeft' ? -1 : 1);
  });
  document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>viewer?.view(b.dataset.view==='reset'?data.steps[index].view:b.dataset.view));
  let comparisonPromise;
  async function mode(compare) {
    $('build-panel').hidden=compare;$('compare-panel').hidden=!compare;
    $('mode-build').setAttribute('aria-pressed',String(!compare));$('mode-compare').setAttribute('aria-pressed',String(compare));
    if(compare && !comparisonPromise){comparisonPromise=import('./comparison.js').then(m=>m.initComparison(data)).catch(e=>{$('compare-status').textContent='비교 화면을 불러오지 못했습니다. 복원 근거와 STEP 파일을 이용하세요.';console.error(e);});}
  }
  $('mode-build').onclick=()=>mode(false);$('mode-compare').onclick=()=>mode(true);
  document.querySelectorAll('a[href^="#as-"], a[href="#reference-docs"], .bar a').forEach(a=>a.addEventListener('click',()=>{if($('reference-docs'))$('reference-docs').open=true;}));
  if(location.hash && location.hash!=='#interactive' && $('reference-docs')) $('reference-docs').open=true;
  $('assembly-ui').hidden=false;update();
  status.textContent = '그림과 수량을 확인한 뒤 한 단계씩 진행하세요.';
  $('asm-installed').onclick = () => {
    const step = data.steps[index];
    const button = $('asm-installed');
    const installed = button.textContent === '장착 후 보기';
    $('asm-drawing').src = installed ? step.installedIllustration : step.illustration;
    button.textContent = installed ? '장착 방향 보기' : '장착 후 보기';
  };
  let opening3D = false;
  $('asm-3d').onclick = async () => {
    if (opening3D) return;
    const canvas = $('asm-canvas');
    const drawing = $('asm-drawing');
    const button = $('asm-3d');
    if (!canvas.hidden) {
      expand(false); canvas.hidden = true; drawing.hidden = false;
      $('asm-installed').hidden = !data.steps[index].installedIllustration;
      $('asm-3d-tools').hidden = true; $('asm-visual').classList.remove('live'); button.textContent = '3D로 보기';
      return;
    }
    opening3D = true;
    button.disabled = true;
    try {
      if (!viewer) {
        const {createViewer} = await import('./viewer.js');
        viewer = await createViewer(canvas, data, id => selectPart(id, true), {
          ghost: true,
          onLost: () => {
            expand(false); canvas.hidden = true; drawing.hidden = false;
      $('asm-installed').hidden = !data.steps[index].installedIllustration; $('asm-3d-tools').hidden = true; $('asm-visual').classList.remove('live');
            button.textContent = '3D로 보기';
            status.textContent = '3D 연결이 끊겼습니다. 단계별 조립도를 표시합니다.';
            viewer?.dispose(); viewer = null;
          }
        });
      }
      drawing.hidden = true; canvas.hidden = false; $('asm-installed').hidden = true;
      $('asm-3d-tools').hidden = false; $('asm-visual').classList.add('live'); button.textContent = '조립도로 돌아가기';
      show(); viewer.view(data.steps[index].view);
      status.textContent = matchMedia('(pointer: coarse)').matches ? '3D 준비 완료 · 가로로 밀어 회전 · 두 손가락으로 확대·이동 · 두 번 눌러 그 지점 확대 · 크게 보기에서 자유 회전' : '3D 준비 완료 · 드래그 회전 · 휠 확대 · 오른쪽 드래그 이동 · 더블클릭한 곳으로 확대 · ←/→ 단계 이동';
    } catch (error) {
      console.error(error);
      status.textContent = '3D를 사용할 수 없습니다. 단계별 조립도를 표시합니다.';
    } finally {
      opening3D = false; button.disabled = false;
    }
  };
} catch(error){console.error(error);status.textContent='조립 데이터를 불러오지 못했습니다. HTTP 서버에서 열거나 아래 전체 조립 설명을 이용하세요.';if($('reference-docs'))$('reference-docs').open=true;}
