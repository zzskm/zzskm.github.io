const $ = id => document.getElementById(id);
const status = $('assembly-status');
try {
  const response = await fetch('assembly.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const key = `${document.documentElement.dataset.store}-interactive`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch {}
  let index = Math.max(0, data.steps.findIndex(s => s.id === saved.step));
  let selected = null, viewer = null;
  const remember = () => { try { localStorage.setItem(key, JSON.stringify(saved)); } catch {} };
  const parts = new Map(data.parts.map(p => [p.id, p]));
  const picker = $('asm-step');
  data.steps.forEach((s, i) => picker.add(new Option(`${String(i + 1).padStart(2, '0')} / ${data.steps.length} · ${s.title}`, i)));
  $('asm-tools').innerHTML = data.tools;
  function syncDone() {
    const box = document.getElementById(`as-${data.steps[index].id}`);
    $('asm-done').checked = box?.checked || false;
    $('asm-progress').textContent = `완료 ${data.steps.filter(s => document.getElementById(`as-${s.id}`)?.checked).length} / ${data.steps.length}`;
  }
  function list() {
    const step = data.steps[index], all = $('asm-scope').value === 'all';
    const query = $('asm-search').value.trim().toLowerCase();
    const container = $('asm-parts'); container.replaceChildren();
    const entries = data.parts.filter(p => (all || p.id in step.needs) && `${p.label} ${p.detail}`.toLowerCase().includes(query));
    $('asm-parts-note').textContent = all ? '수량은 완성품 전체 기준입니다. 준비 체크는 이 브라우저에 저장됩니다.' : '수량은 이번 작업에서 사용할 양입니다. 앞 단계에서 사용한 부품의 재확인도 포함합니다.';
    for (const part of entries) {
      const card = document.createElement('div'); card.className = 'assembly-part';
      card.classList.toggle('selected', selected === part.id);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'part-select';
      button.setAttribute('aria-pressed', String(selected === part.id));
      const thumb = document.createElement('span'); thumb.className = 'part-thumb'; thumb.dataset.part = part.id;
      thumb.textContent = part.mesh ? '3D' : '규격';
      viewer?.thumbnail(part.id, thumb);
      const info = document.createElement('span');
      const category = document.createElement('small'); category.textContent = part.category;
      const title = document.createElement('strong'); title.innerHTML = part.label;
      const qty = document.createElement('span'); qty.className = 'part-qty';
      qty.textContent = `${all ? '전체' : '이번 단계'} ${all ? part.qty : step.needs[part.id]}`;
      info.append(category, title, qty); button.append(thumb, info);
      button.onclick = () => {
        selected = selected === part.id ? null : part.id;
        viewer?.show(step, selected, +$('asm-explode').value);
        $('asm-picked').textContent = selected ? `${title.textContent}${!part.mesh ? ' · 3D 형상 없음, 규격과 설명을 확인하세요' : !step.show.includes(part.id) ? ' · 부품 단독 보기' : ' · 선택한 부품'}` : '';
        list();
      };
      const details = document.createElement('p'); details.innerHTML = part.detail;
      if (part.size) { const dims = document.createElement('small'); dims.textContent = part.size; details.append(document.createElement('br'), dims); }
      const label = document.createElement('label'); label.className = 'tick';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !!saved[`part:${part.id}`];
      check.onchange = () => { saved[`part:${part.id}`] = check.checked; remember(); };
      label.append(check, ' 준비함'); card.append(button, details, label); container.append(card);
    }
    if (!entries.length) container.textContent = '해당하는 부품이 없습니다.';
  }
  function update() {
    const step = data.steps[index]; selected = null;
    picker.value = index; $('asm-prev').disabled = index === 0; $('asm-next').disabled = index === data.steps.length - 1;
    $('asm-phase').textContent = `${String(index + 1).padStart(2, '0')} / ${data.steps.length} · ${step.phase}`;
    $('asm-title').innerHTML = step.title;
    $('asm-body').innerHTML = (step.body ? `<p>${step.body}</p>` : '') + (step.items.length ? `<ol>${step.items.map(s => `<li>${s}</li>`).join('')}</ol>` : '') + (step.note ? `<p class="note">${step.note}</p>` : '');
    $('asm-check').innerHTML = step.check ? `<b>확인</b> ${step.check}` : '';
    $('asm-fix').innerHTML = step.fix ? `<b>안 맞으면</b> ${step.fix}` : '';
    $('asm-image').src = step.image;
    $('asm-detail').href = `#as-${step.id}`;
    $('asm-picked').textContent = '';
    $('asm-explode').value = 0;
    viewer?.show(step, null, 0); viewer?.view(step.view);
    saved.step = step.id; remember(); syncDone(); list();
  }
  $('asm-prev').onclick = () => { if (index > 0) { index--; update(); } };
  $('asm-next').onclick = () => { if (index < data.steps.length - 1) { index++; update(); } };
  picker.onchange = () => { index = +picker.value; update(); };
  $('asm-scope').onchange = list; $('asm-search').oninput = list;
  $('asm-done').onchange = () => {
    const original = document.getElementById(`as-${data.steps[index].id}`);
    if (original) { original.checked = $('asm-done').checked; original.dispatchEvent(new Event('change')); }
  };
  document.addEventListener('change', syncDone);
  document.getElementById('reset')?.addEventListener('click', syncDone);
  $('asm-explode').oninput = () => viewer?.show(data.steps[index], selected, +$('asm-explode').value);
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => viewer?.view(b.dataset.view === 'iso' ? data.steps[index].view : b.dataset.view));
  $('assembly-ui').hidden = false; update();
  try {
    status.textContent = '3D 모델을 불러오는 중입니다. 단계 설명과 부품 목록은 먼저 이용할 수 있습니다.';
    const { createViewer } = await import('./viewer.js');
    viewer = await createViewer($('asm-canvas'), data, id => {
      selected = id;
      viewer.show(data.steps[index], selected, +$('asm-explode').value);
      $('asm-picked').textContent = parts.get(id)?.label || ''; list();
    });
    update();
    status.textContent = '3D 준비 완료 · 주황: 이번 작업 · 청록: 선택한 부품 · 나머지: 조립 상태';
  } catch (error) {
    console.error(error);
    status.textContent = '3D 화면을 사용할 수 없습니다. 단계별 참고 이미지와 부품 목록으로 진행하세요.';
    $('asm-fallback').open = true;
    $('asm-canvas').hidden = true;
    document.querySelector('.assembly-toolbar').hidden = true;
  }
} catch (error) {
  console.error(error);
  status.textContent = '단계 데이터를 불러오지 못했습니다. HTTP 서버에서 열어 주세요. 아래 전체 조립 설명은 그대로 사용할 수 있습니다.';
}
