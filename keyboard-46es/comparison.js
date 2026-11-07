export async function initComparison(current) {
  const $ = id => document.getElementById(id);
  const status = $('compare-status');
  const response = await fetch('r2-reference.json');
  if (!response.ok) throw new Error(`r2 HTTP ${response.status}`);
  const r2 = await response.json();
  for (const text of [...r2.assumptions, ...r2.repairs]) {
    const li = document.createElement('li');
    li.textContent = text;
    $('r2-assumptions').append(li);
  }
  for (const part of r2.parts) {
    const span = document.createElement('span');
    span.style.setProperty('--layer-color', part.color);
    span.textContent = `${part.id} · ${part.thickness_mm}T`;
    $('r2-layers').append(span);
  }
  let left, right, live = false;
  function setMode(active) {
    live = active;
    for (const id of ['r2', 'v5']) {
      $(`${id}-canvas`).hidden = !active;
      $(`${id}-fallback`).hidden = active;
    }
    $('cmp-3d-tools').hidden = !active;
    $('cmp-3d').textContent = active ? '조립도로 돌아가기' : '3D로 보기';
  }
  function show() {
    const scope = $('cmp-scope').value;
    for (const id of ['r2', 'v5']) $(`${id}-fallback`).src = `img/build/${id}-${scope}.png`;
    if (!live) return;
    const amount = +$('cmp-explode').value;
    const rids = scope === 'plate' ? ['P2', 'P3'] :
      scope === 'cover' ? ['P4', 'P5'] : r2.parts.map(p => p.id);
    const prefixes = {all: /^(PLATE_|COVER_|MOUNT_|CTRL_BRACKET|CTRL_GATE)/,
      plate: /^PLATE_/, cover: /^COVER_/};
    const vids = current.parts.filter(p => prefixes[scope].test(p.id));
    left.show({show: rids, focus: []}, null, amount);
    right.show({show: vids.map(p => p.id), focus: []}, null, amount);
  }
  function fallback() {
    setMode(false);
    left?.dispose(); right?.dispose(); left = right = null;
    status.textContent = '3D를 사용할 수 없습니다. 같은 축척의 비교 조립도를 표시합니다.';
  }
  $('cmp-scope').onchange = show;
  $('cmp-explode').oninput = show;
  document.querySelectorAll('[data-compare-view]').forEach(button => {
    button.onclick = () => left.view(button.dataset.compareView);
  });
  $('cmp-3d').onclick = async () => {
    if (live) { setMode(false); return; }
    const button = $('cmp-3d');
    button.disabled = true;
    try {
      if (!left) {
        const {createViewer} = await import('./viewer.js');
        const options = {bounds: [[-10,-5,0],[296,100,120]], verticalExplode: true, onLost: fallback};
        left = await createViewer($('r2-canvas'), r2, () => {}, options);
        right = await createViewer($('v5-canvas'), current, () => {}, options);
        left.onChange(pose => right.setPose(pose));
        right.onChange(pose => left.setPose(pose));
      }
      setMode(true); show(); left.view('iso');
      status.textContent = '양쪽 3D 모델의 회전과 확대가 함께 움직입니다.';
    } catch (error) {
      console.error(error); fallback();
    } finally {
      button.disabled = false;
    }
  };
  show();
  status.textContent = '같은 시점과 축척으로 비교합니다. 전체 구조는 층 사이를 벌려 표시했습니다.';
}
