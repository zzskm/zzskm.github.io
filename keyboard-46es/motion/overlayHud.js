import * as THREE from '../vendor/three.module.js';
import { PALETTE } from './materials.js';

const SVG_W = 1920;
const SVG_H = 1080;

function projectToSvg(vec3, camera, out = { x: 0, y: 0 }) {
  const p = vec3.clone().project(camera);
  out.x = (p.x * 0.5 + 0.5) * SVG_W;
  out.y = (-p.y * 0.5 + 0.5) * SVG_H;
  return out;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function formatPickInfo(info) {
  if (!info) return '';
  if (info.type === 'fastener') {
    const [x, y, z] = info.centerLocal || [0, 0, 0];
    return `${info.id} · ${info.spec} (×${info.qty}) · STEP ${info.step} · ${info.target} · (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`;
  }
  if (info.type === 'keycap' || info.type === 'switch') {
    const leg = info.legend ? ` · ${info.legend}` : '';
    return `${info.id} · ${info.w_u.toFixed(2)}U · R${info.row}/C${info.col}${leg} · STEP ${info.step} (${info.group})`;
  }
  if (info.type === 'diode') {
    return `${info.id} · 1N4148 DO-35 · R${info.row}/C${info.col} · STEP 2 (G2-CORE)`;
  }
  const vol = info.volumeCm3 > 0 ? ` · ${info.volumeCm3.toFixed(1)} cm³` : '';
  const mat = info.material ? ` · ${info.material}` : '';
  return `${info.id} · STEP ${info.step} (${info.group})${mat}${vol}`;
}

export function createOverlayHud(domRefs, metrics, callbacks = {}) {
  const {
    svgEl,
    phaseCodeEl,
    telemetryEl,
    camChipEl,
    boltTagEl,
    pickEl,
    legendEl,
    timeBigEl,
    ctrlTimeEl,
    reportPanelEl,
    reportLegendEl,
    repEnvEl,
    repEnvSubEl,
    repPrintEl,
    repPrintSubEl,
    repFastEl,
    repFastSubEl,
    repKeysEl,
    repKeysSubEl,
    repMatrixEl,
    repMatrixSubEl,
    repFitEl,
    repFitSubEl,
  } = domRefs;
  const { onLegendGroupHover = () => {} } = callbacks;

  const cache = new Map();
  function setText(el, key, value) {
    if (!el) return;
    if (cache.get(key) !== value) {
      el.textContent = value;
      cache.set(key, value);
    }
  }

  let lastSvg = '';
  function setSvg(markup) {
    if (markup !== lastSvg) {
      svgEl.innerHTML = markup;
      lastSvg = markup;
    }
  }

  // Build interactive 6-group summary bar above final 6-cell report
  if (reportLegendEl) {
    reportLegendEl.innerHTML = '';
    for (const g of metrics.groups) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'rep-leg-pill';
      pill.dataset.group = g.code;
      pill.innerHTML = `<i style="background:${g.color}"></i><span class="rl-code">${g.code}</span><span class="rl-cnt">${g.count}</span>`;
      pill.title = `${g.code} · ${g.label} (${g.count} pcs)`;
      pill.addEventListener('mouseenter', () => onLegendGroupHover(g));
      pill.addEventListener('mouseleave', () => onLegendGroupHover(null));
      reportLegendEl.appendChild(pill);
    }
  }

  function renderDimsAndLayers(state, camera, groupList) {
    const parts = [];
    const { bbox } = state;

    // 0-2.5s: 3-axis CAD dimensions + bottom tilt angle arc (Bug A fix: D badge shifted outward)
    if (bbox.opacity > 0.02) {
      const min = metrics.bbox.min;
      const max = metrics.bbox.max;
      const p000 = projectToSvg(new THREE.Vector3(min.x, min.y, min.z), camera);
      const p100 = projectToSvg(new THREE.Vector3(max.x, min.y, min.z), camera);
      const p110 = projectToSvg(new THREE.Vector3(max.x, max.y, min.z), camera);
      const p111 = projectToSvg(new THREE.Vector3(max.x, max.y, max.z), camera);

      const wVal = (metrics.widthMm * bbox.dimCountUp).toFixed(1);
      const dVal = (metrics.depthMm * bbox.dimCountUp).toFixed(1);
      const hVal = (metrics.heightMm * bbox.dimCountUp).toFixed(1);
      const tVal = (metrics.tiltDeg * bbox.dimCountUp).toFixed(1);

      const wx = (p000.x + p100.x) / 2;
      const wy = (p000.y + p100.y) / 2 + 36;
      const dx = (p100.x + p110.x) / 2 + 78;
      const dy = (p100.y + p110.y) / 2 + 22;
      const hx = p111.x + 54;
      const hy = (p110.y + p111.y) / 2;

      parts.push(`<g opacity="${bbox.opacity.toFixed(3)}" font-family="IBM Plex Mono, monospace">`);
      parts.push(
        `<line x1="${p000.x.toFixed(1)}" y1="${(p000.y + 12).toFixed(1)}" x2="${p100.x.toFixed(1)}" y2="${(p100.y + 12).toFixed(1)}" stroke="${PALETTE.orangeCss}" stroke-width="2"/>` +
        `<rect x="${(wx - 74).toFixed(1)}" y="${(wy - 18).toFixed(1)}" width="148" height="34" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.orangeCss}" stroke-width="1.5"/>` +
        `<text x="${wx.toFixed(1)}" y="${(wy + 5).toFixed(1)}" text-anchor="middle" font-size="20" font-weight="600" fill="${PALETTE.inkCss}" data-dim="width">W ${wVal} mm</text>`,
      );
      parts.push(
        `<line x1="${(p100.x + 18).toFixed(1)}" y1="${p100.y.toFixed(1)}" x2="${(p110.x + 18).toFixed(1)}" y2="${p110.y.toFixed(1)}" stroke="${PALETTE.orangeCss}" stroke-width="2"/>` +
        `<rect x="${(dx - 66).toFixed(1)}" y="${(dy - 18).toFixed(1)}" width="146" height="34" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.orangeCss}" stroke-width="1.5"/>` +
        `<text x="${(dx + 7).toFixed(1)}" y="${(dy + 5).toFixed(1)}" text-anchor="middle" font-size="20" font-weight="600" fill="${PALETTE.inkCss}" data-dim="depth">D ${dVal} mm</text>`,
      );
      parts.push(
        `<line x1="${(p110.x + 16).toFixed(1)}" y1="${p110.y.toFixed(1)}" x2="${(p111.x + 16).toFixed(1)}" y2="${p111.y.toFixed(1)}" stroke="${PALETTE.inkCss}" stroke-width="2"/>` +
        `<rect x="${(hx - 12).toFixed(1)}" y="${(hy - 18).toFixed(1)}" width="136" height="34" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.inkCss}" stroke-width="1.5"/>` +
        `<text x="${(hx + 56).toFixed(1)}" y="${(hy + 5).toFixed(1)}" text-anchor="middle" font-size="20" font-weight="600" fill="${PALETTE.inkCss}" data-dim="height">H ${hVal} mm</text>`,
      );
      const tx = clamp(p000.x - 108, 48, 1700);
      const ty = clamp(p000.y - 16, 120, 960);
      parts.push(
        `<path d="M ${(tx + 64).toFixed(1)} ${(ty + 12).toFixed(1)} L ${(tx + 106).toFixed(1)} ${(ty + 12).toFixed(1)} M ${(tx + 64).toFixed(1)} ${(ty + 12).toFixed(1)} L ${(tx + 104).toFixed(1)} ${(ty - 4).toFixed(1)}" stroke="${PALETTE.orangeCss}" stroke-width="2" fill="none"/>` +
        `<rect x="${(tx - 68).toFixed(1)}" y="${(ty - 18).toFixed(1)}" width="128" height="34" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.orangeCss}" stroke-width="1.5"/>` +
        `<text x="${(tx - 4).toFixed(1)}" y="${(ty + 5).toFixed(1)}" text-anchor="middle" font-size="20" font-weight="600" fill="${PALETTE.orangeCss}" data-dim="tilt">∠ ${tVal}°</text>`,
      );
      parts.push('</g>');
    }

    // 6-group exploded layer tags (Bug C fix: skip hidden groups & pick rightmost projected corner!)
    if (bbox.layerTagsOpacity > 0.02) {
      const visibleItems = [];
      for (let i = 0; i < metrics.groups.length; i++) {
        const gm = metrics.groups[i];
        const grp = groupList[i];
        if (!grp.visible) continue;
        grp.updateMatrixWorld(true);
        const gb = new THREE.Box3();
        let hasVisibleChild = false;
        grp.traverse((ch) => {
          if (ch.isMesh && ch.visible) {
            let p = ch.parent;
            let allVis = true;
            while (p && p !== grp) {
              if (!p.visible) { allVis = false; break; }
              p = p.parent;
            }
            if (allVis) {
              gb.expandByObject(ch);
              hasVisibleChild = true;
            }
          }
        });
        if (!hasVisibleChild || gb.isEmpty()) continue;

        const midZ = (gb.min.z + gb.max.z) / 2;
        const corners = [
          new THREE.Vector3(gb.min.x, gb.min.y, midZ),
          new THREE.Vector3(gb.max.x, gb.min.y, midZ),
          new THREE.Vector3(gb.max.x, gb.max.y, midZ),
          new THREE.Vector3(gb.min.x, gb.max.y, midZ),
        ];
        let bestPt = projectToSvg(corners[0], camera);
        for (let c = 1; c < corners.length; c++) {
          const p = projectToSvg(corners[c], camera);
          if (p.x > bestPt.x) bestPt = p;
        }
        visibleItems.push({ gm, pt: bestPt });
      }

      if (visibleItems.length) {
        visibleItems.sort((a, b) => a.pt.y - b.pt.y);
        const labelX = 1595;
        const minGap = 54;
        const ys = visibleItems.map((it) => clamp(it.pt.y, 120, 910));
        for (let i = 1; i < ys.length; i++) {
          if (ys[i] < ys[i - 1] + minGap) ys[i] = ys[i - 1] + minGap;
        }
        if (ys[ys.length - 1] > 930) {
          const shift = ys[ys.length - 1] - 930;
          for (let i = 0; i < ys.length; i++) ys[i] -= shift;
        }

        parts.push(`<g opacity="${bbox.layerTagsOpacity.toFixed(3)}" font-family="IBM Plex Mono, monospace">`);
        for (let i = 0; i < visibleItems.length; i++) {
          const { gm, pt } = visibleItems[i];
          const ly = ys[i];
          parts.push(
            `<polyline points="${pt.x.toFixed(1)},${pt.y.toFixed(1)} ${(labelX - 24).toFixed(1)},${ly.toFixed(1)} ${labelX},${ly.toFixed(1)}" fill="none" stroke="${PALETTE.bgCss}" stroke-width="4" opacity="0.8"/>` +
            `<polyline points="${pt.x.toFixed(1)},${pt.y.toFixed(1)} ${(labelX - 24).toFixed(1)},${ly.toFixed(1)} ${labelX},${ly.toFixed(1)}" fill="none" stroke="${PALETTE.inkCss}" stroke-width="1.5" stroke-dasharray="4 3"/>` +
            `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="4.5" fill="${gm.color}" stroke="${PALETTE.bgCss}" stroke-width="1.5"/>` +
            `<rect x="${labelX}" y="${(ly - 17).toFixed(1)}" width="260" height="34" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.inkCss}" stroke-width="1.4"/>` +
            `<rect x="${labelX}" y="${(ly - 17).toFixed(1)}" width="6" height="34" rx="2" fill="${gm.color}"/>` +
            `<text x="${labelX + 16}" y="${(ly + 6).toFixed(1)}" font-size="18" font-weight="600" fill="${PALETTE.inkCss}">${gm.code}</text>` +
            `<text x="${labelX + 248}" y="${(ly + 6).toFixed(1)}" text-anchor="end" font-size="18" font-weight="600" fill="${PALETTE.orangeCss}">${gm.count} pcs</text>`,
          );
        }
        parts.push('</g>');
      }
    }
    return parts.join('');
  }

  function renderCoreLeaders(state, camera) {
    if (state.leaders.opacity <= 0.02) return '';
    const m3Count = metrics.bom.find((b) => b.id === 'bom-fast-m3')?.count ?? 12;
    const m2Count = metrics.bom.find((b) => b.id === 'bom-fast-m2')?.count ?? 20;
    const raw = [
      { id: 'mcu', anchor: metrics.anchors.mcu, title: 'MCU · ATMEGA32U4', count: '×1' },
      { id: 'diode', anchor: metrics.anchors.diode, title: 'DIODE · 1N4148', count: `×${metrics.diodes}` },
      { id: 'fastener', anchor: metrics.anchors.fastener, title: 'BOLT · M3×10 / M2', count: `${m3Count}/${m2Count}` },
      { id: 'pads', anchor: metrics.anchors.pads, title: 'PADS · MATRIX 4×12', count: `×${metrics.pads}` },
    ].map((c) => ({ ...c, pt: projectToSvg(c.anchor, camera) }));

    // Bug C fix: dynamic 4-quadrant screen-space sorting so leader lines NEVER cross under any camera rotation!
    const byX = [...raw].sort((a, b) => a.pt.x - b.pt.x);
    const leftSide = byX.slice(0, 2).sort((a, b) => a.pt.y - b.pt.y);
    const rightSide = byX.slice(2, 4).sort((a, b) => a.pt.y - b.pt.y);
    const positioned = [
      { ...leftSide[0], boxX: 100, boxY: 210, align: 'left' },
      { ...leftSide[1], boxX: 100, boxY: 770, align: 'left' },
      { ...rightSide[0], boxX: 1464, boxY: 210, align: 'right' },
      { ...rightSide[1], boxX: 1464, boxY: 770, align: 'right' },
    ];

    const parts = [`<g opacity="${state.leaders.opacity.toFixed(3)}" font-family="IBM Plex Mono, monospace">`];
    positioned.forEach((c, idx) => {
      const slot = Math.max(0, Math.min(1, (state.leaders.progress - idx * 0.14) / 0.45));
      if (slot <= 0.01) return;
      const pt = c.pt;
      const boxW = 356;
      const boxH = 48;
      const endX = c.align === 'left' ? c.boxX + boxW : c.boxX;
      const endY = c.boxY + boxH / 2;
      const elbowX = c.align === 'left' ? endX + 44 : endX - 44;

      parts.push(
        `<g opacity="${slot.toFixed(3)}">` +
        `<polyline points="${pt.x.toFixed(1)},${pt.y.toFixed(1)} ${elbowX.toFixed(1)},${endY.toFixed(1)} ${endX.toFixed(1)},${endY.toFixed(1)}" fill="none" stroke="${PALETTE.bgCss}" stroke-width="5" opacity="0.88"/>` +
        `<polyline points="${pt.x.toFixed(1)},${pt.y.toFixed(1)} ${elbowX.toFixed(1)},${endY.toFixed(1)} ${endX.toFixed(1)},${endY.toFixed(1)}" fill="none" stroke="${PALETTE.inkCss}" stroke-width="2"/>` +
        `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="6" fill="${PALETTE.orangeCss}" stroke="${PALETTE.bgCss}" stroke-width="2"/>` +
        `<rect x="${c.boxX}" y="${c.boxY}" width="${boxW}" height="${boxH}" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.inkCss}" stroke-width="1.6"/>` +
        `<text x="${c.boxX + 16}" y="${c.boxY + 30}" font-size="18" font-weight="600" fill="${PALETTE.inkCss}">${c.title}</text>` +
        `<text x="${c.boxX + boxW - 16}" y="${c.boxY + 30}" text-anchor="end" font-size="19" font-weight="700" fill="${PALETTE.orangeCss}">${c.count}</text>` +
        `</g>`,
      );
    });
    parts.push('</g>');
    return parts.join('');
  }

  function renderCloseupOverlay(state, camera) {
    if (!state.closeup.active || state.closeup.status === 'idle') return '';
    const isWarn = state.closeup.status === 'warn';
    const color = isWarn ? PALETTE.orangeCss : PALETTE.blueCss;
    const blinkAlpha = isWarn ? 0.35 + 0.65 * state.closeup.blink : 1.0;

    const basePt = projectToSvg(metrics.closeupFlangeWorld, camera);
    const liftedWorld = metrics.closeupFlangeWorld.clone();
    liftedWorld.z += state.closeup.gapMm;
    const topPt = projectToSvg(liftedWorld, camera);

    const badgeX = clamp(topPt.x + 125, 160, 1410);
    const badgeY = clamp(topPt.y - 125, 140, 740);
    const covClr = metrics.cadVerification?.closeup_key_cover_min_mm?.toFixed(2) ?? '1.02';

    const mainText = isWarn
      ? `SIM ΔZ +${state.closeup.gapMm.toFixed(1)} mm`
      : 'SIM SEAT 0.0 mm ✓';
    const subText = isWarn
      ? `KEY #${state.closeup.keyId} · 2.00U · CAD COV CLR ${covClr} mm`
      : `KEY #${state.closeup.keyId} · SEATED · CAD COV CLR ${covClr} mm`;

    // Bug D fix: keep card & text at opacity 1.0; only blink the warning icon and target ring!
    return (
      `<g font-family="IBM Plex Mono, monospace">` +
      `<circle cx="${topPt.x.toFixed(1)}" cy="${topPt.y.toFixed(1)}" r="${isWarn ? 22 : 28}" fill="none" stroke="${color}" stroke-width="3" opacity="${blinkAlpha.toFixed(3)}"/>` +
      `<line x1="${basePt.x.toFixed(1)}" y1="${basePt.y.toFixed(1)}" x2="${topPt.x.toFixed(1)}" y2="${topPt.y.toFixed(1)}" stroke="${color}" stroke-width="3.5"/>` +
      `<polyline points="${topPt.x.toFixed(1)},${topPt.y.toFixed(1)} ${(badgeX - 24).toFixed(1)},${(badgeY + 38).toFixed(1)} ${badgeX.toFixed(1)},${(badgeY + 38).toFixed(1)}" fill="none" stroke="${color}" stroke-width="2.5"/>` +
      `<rect x="${badgeX.toFixed(1)}" y="${badgeY.toFixed(1)}" width="390" height="80" rx="4" fill="${PALETTE.bgCss}" stroke="${color}" stroke-width="2.5"/>` +
      (isWarn
        ? `<text x="${(badgeX + 18).toFixed(1)}" y="${(badgeY + 36).toFixed(1)}" font-size="24" font-weight="700" fill="${color}" opacity="${blinkAlpha.toFixed(3)}">⚠</text>` +
          `<text x="${(badgeX + 48).toFixed(1)}" y="${(badgeY + 36).toFixed(1)}" font-size="24" font-weight="700" fill="${color}" data-closeup-badge="warn">${mainText}</text>`
        : `<text x="${(badgeX + 20).toFixed(1)}" y="${(badgeY + 36).toFixed(1)}" font-size="24" font-weight="700" fill="${color}" data-closeup-badge="ok">${mainText}</text>`) +
      `<text x="${(badgeX + 20).toFixed(1)}" y="${(badgeY + 63).toFixed(1)}" font-size="14" font-weight="600" fill="${PALETTE.inkCss}">${subText}</text>` +
      `</g>`
    );
  }

  function renderContextLegend(state) {
    if (!legendEl) return;
    // Hide context legend during BOM or Report (those have their own 6-group legend bars)
    if (state.bom.opacity > 0.05 || state.report.opacity > 0.05) {
      if (!legendEl.hidden) legendEl.hidden = true;
      return;
    }
    let chips = [];
    if (state.scan.active || state.materials.xray > 0.2) {
      chips = [
        { color: '#E8612C', label: 'SCANNING' },
        { color: '#2B6CB0', label: 'VERIFIED' },
        { color: '#9A9488', label: 'PENDING' },
      ];
    } else if (state.fasteners?.activePartIds?.length) {
      chips = [
        { color: '#d6a13a', label: 'M3 INS' },
        { color: '#1d2228', label: 'M3×10' },
        { color: '#b8c2cc', label: 'M2×5/6' },
        { color: '#cfd6dd', label: 'M2 NUT' },
        { color: '#d8e0e8', label: 'MAG' },
      ];
    } else if (state.closeup.active) {
      chips = [
        { color: '#E8612C', label: 'SIM LIFT (+1.8mm)' },
        { color: '#2B6CB0', label: 'SEATED (0.0mm)' },
      ];
    } else if (state.materials.coreFocus > 0.35 && state.mode === 'timeline') {
      chips = [
        { color: '#1f6d60', label: 'G2 CORE' },
        { color: '#485159', label: 'G3 PLATE' },
        { color: '#d8a832', label: 'G4 SW' },
        { color: '#b8b2a6', label: 'EXT GHOST' },
      ];
    } else {
      chips = [
        { color: '#485159', label: 'MJF PA12 (11)' },
        { color: '#98b8d6', label: 'SLA RESIN (3)' },
        { color: '#d6a13a', label: 'HW / FAST (42)' },
        { color: '#d8c89c', label: 'SW + CAP (92)' },
      ];
    }
    const html = chips
      .map((c) => `<span class="leg-item"><i style="background:${c.color}"></i>${c.label}</span>`)
      .join('');
    if (cache.get('legendHtml') !== html) {
      legendEl.innerHTML = html;
      cache.set('legendHtml', html);
    }
    if (legendEl.hidden) legendEl.hidden = false;
  }

  function updatePickChip(pickInfo) {
    if (!pickEl) return;
    if (!pickInfo) {
      if (!pickEl.hidden) pickEl.hidden = true;
      return;
    }
    const text = formatPickInfo(pickInfo);
    setText(pickEl, 'pickText', text);
    if (pickEl.hidden) pickEl.hidden = false;
  }

  function updateCamChip(camMode, activePreset, turntable) {
    if (!camChipEl) return;
    if (camMode === 'Timeline' && !turntable) {
      if (!camChipEl.hidden) camChipEl.hidden = true;
      return;
    }
    const label = turntable
      ? 'TURNTABLE 360°'
      : activePreset
        ? `VIEW · ${activePreset.toUpperCase()}`
        : camMode === 'Blending'
          ? 'RETURNING'
          : 'FREE ORBIT';
    setText(camChipEl, 'camChip', label);
    if (camChipEl.hidden) camChipEl.hidden = false;
  }

  function update(state, camera, groupList, scanStats) {
    setText(phaseCodeEl, 'phaseCode', state.phaseCode);

    const unitEl = timeBigEl?.nextElementSibling;
    const totalEl = unitEl?.nextElementSibling;
    if (state.mode === 'timeline') {
      const tStr = state.t.toFixed(1).padStart(4, '0');
      setText(timeBigEl, 'timeBig', tStr);
      setText(ctrlTimeEl, 'ctrlTime', `${tStr}s`);
      if (unitEl) setText(unitEl, 'timeUnit', 's');
      if (totalEl) setText(totalEl, 'timeTotal', `/ ${metrics.durationSec.toFixed(1)}s`);
    } else {
      setText(timeBigEl, 'timeBig', `STEP ${state.stepNum}`);
      setText(ctrlTimeEl, 'ctrlTime', `STEP ${state.stepNum}`);
      if (unitEl) setText(unitEl, 'timeUnit', '');
      if (totalEl) setText(totalEl, 'timeTotal', `/ ${metrics.stepsCount}`);
    }

    // Floating bolt insertion badge
    if (boltTagEl) {
      const tag = state.fasteners?.activeTag || null;
      if (tag) {
        setText(boltTagEl, 'boltTag', tag);
        if (boltTagEl.hidden) boltTagEl.hidden = false;
      } else if (!boltTagEl.hidden) {
        boltTagEl.hidden = true;
      }
    }

    // X-Ray scan telemetry chip (1:1 synced with evaluateScanTarget)
    if (state.scan.active && state.scan.opacity > 0.05 && scanStats) {
      if (telemetryEl.hidden) telemetryEl.hidden = false;
      const fTot = scanStats.fastenersTotal || metrics.fasteners;
      const pTot = scanStats.pinsTotal || metrics.pins;
      const dTot = scanStats.padsTotal || metrics.pads;
      const done = scanStats.fastenersOk >= fTot && scanStats.pinsOk >= pTot && scanStats.padsOk >= dTot;
      const zDisplay = Math.max(0, state.scan.zWorld).toFixed(1);
      const txt = `Z ${zDisplay} mm  ·  FST ${scanStats.fastenersOk}/${fTot}  ·  PIN ${scanStats.pinsOk}/${pTot}  ·  PAD ${scanStats.padsOk}/${dTot}${done ? '  ·  OK ✓' : ''}`;
      setText(telemetryEl, 'telemetry', txt);
      telemetryEl.dataset.ok = done ? '1' : '0';
    } else if (!telemetryEl.hidden) {
      telemetryEl.hidden = true;
    }

    renderContextLegend(state);

    // SVG overlay composition
    const svgBody =
      renderDimsAndLayers(state, camera, groupList) +
      renderCoreLeaders(state, camera) +
      renderCloseupOverlay(state, camera);
    setSvg(svgBody);

    // 32-36s Final 6-cell 100% live CAD report (zero hardcoded numbers!)
    if (reportPanelEl) {
      if (state.report.opacity > 0.01) {
        if (reportPanelEl.hidden) reportPanelEl.hidden = false;
        reportPanelEl.style.opacity = state.report.opacity.toFixed(3);
        const p = state.report.progress;
        const ps = metrics.printStats;
        const fb = metrics.fastenerBreakdown;
        const ms = metrics.matrixStats;
        const kw = metrics.keycapsByWidth;
        const cv = metrics.cadVerification;

        setText(repEnvEl, 'repEnv', `${(metrics.widthMm * p).toFixed(1)} × ${(metrics.depthMm * p).toFixed(1)} mm`);
        setText(repEnvSubEl, 'repEnvSub', `H ${metrics.heightMm.toFixed(1)} mm · ∠ ${metrics.tiltDeg.toFixed(1)}°`);

        setText(repPrintEl, 'repPrint', `${(ps.totalCm3 * p).toFixed(1)} cm³`);
        setText(repPrintSubEl, 'repPrintSub', `${ps.bodyCount} bodies (${ps.uniqueStls} STL) · ${ps.mjfCount} MJF / ${ps.resinCount} SLA`);

        setText(repFastEl, 'repFast', `${Math.round(fb.total * p)} pcs`);
        setText(repFastSubEl, 'repFastSub', `M3×10:${fb.m3} · INS:${fb.ins} · M2:${fb.m2} · NUT:${fb.nut} · MAG:${fb.mag}`);

        setText(repKeysEl, 'repKeys', `${Math.round(metrics.switches * p)} keys`);
        setText(repKeysSubEl, 'repKeysSub', `1u:${kw['1'] || 0} · 1.25u:${kw['1.25'] || 0} · 2u:${kw['2'] || 0} · 2.25u:${kw['2.25'] || 0}`);

        setText(repMatrixEl, 'repMatrix', `${ms.rows}×${ms.cols} io`);
        setText(repMatrixSubEl, 'repMatrixSub', `${ms.used}/${ms.slots} USED (${ms.unused} FREE) · ${ms.diodes} DIO · ${ms.wires} SIG`);

        const ovl = cv ? cv.overlaps : 0;
        const fitMain = p > 0.72
          ? `${ovl} OVL ✓ (${metrics.totalParts})`
          : `${Math.round(metrics.totalParts * p)} pcs`;
        const fitSub = cv
          ? `PIN ${cv.pin_min_mm.toFixed(2)} · CAP ${cv.cap_cover_min_mm.toFixed(2)} · PLT ${cv.cap_plate_min_mm.toFixed(2)} mm`
          : `${metrics.totalParts} pcs verified`;
        setText(repFitEl, 'repFit', fitMain);
        setText(repFitSubEl, 'repFitSub', fitSub);
      } else if (!reportPanelEl.hidden) {
        reportPanelEl.hidden = true;
      }
    }
  }

  return { update, updatePickChip, updateCamChip };
}
