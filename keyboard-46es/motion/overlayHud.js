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

export function createOverlayHud(domRefs, metrics) {
  const {
    svgEl,
    phaseCodeEl,
    telemetryEl,
    timeBigEl,
    ctrlTimeEl,
    reportEl,
    repPartsEl,
    repStepsEl,
    repGroupsEl,
    repTimeEl,
    repShortEl,
    repGapEl,
  } = domRefs;

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

  function renderDimsAndLayers(state, camera, groupList) {
    const parts = [];
    const { bbox } = state;

    // 0-2.5s: 3-axis CAD dimensions + bottom tilt angle arc
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

      // Width dimension along front bottom edge
      const wx = (p000.x + p100.x) / 2;
      const wy = (p000.y + p100.y) / 2 + 34;
      // Depth dimension along right bottom edge
      const dx = (p100.x + p110.x) / 2 + 54;
      const dy = (p100.y + p110.y) / 2 + 16;
      // Height dimension along back-right vertical edge
      const hx = p111.x + 48;
      const hy = (p110.y + p111.y) / 2;

      parts.push(`<g opacity="${bbox.opacity.toFixed(3)}" font-family="IBM Plex Mono, monospace">`);
      // Width badge
      parts.push(
        `<line x1="${p000.x.toFixed(1)}" y1="${(p000.y + 12).toFixed(1)}" x2="${p100.x.toFixed(1)}" y2="${(p100.y + 12).toFixed(1)}" stroke="${PALETTE.orangeCss}" stroke-width="2"/>` +
        `<rect x="${(wx - 74).toFixed(1)}" y="${(wy - 18).toFixed(1)}" width="148" height="34" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.orangeCss}" stroke-width="1.5"/>` +
        `<text x="${wx.toFixed(1)}" y="${(wy + 5).toFixed(1)}" text-anchor="middle" font-size="20" font-weight="600" fill="${PALETTE.inkCss}" data-dim="width">W ${wVal} mm</text>`,
      );
      // Depth badge
      parts.push(
        `<line x1="${(p100.x + 14).toFixed(1)}" y1="${p100.y.toFixed(1)}" x2="${(p110.x + 14).toFixed(1)}" y2="${p110.y.toFixed(1)}" stroke="${PALETTE.orangeCss}" stroke-width="2"/>` +
        `<rect x="${(dx - 66).toFixed(1)}" y="${(dy - 18).toFixed(1)}" width="146" height="34" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.orangeCss}" stroke-width="1.5"/>` +
        `<text x="${(dx + 7).toFixed(1)}" y="${(dy + 5).toFixed(1)}" text-anchor="middle" font-size="20" font-weight="600" fill="${PALETTE.inkCss}" data-dim="depth">D ${dVal} mm</text>`,
      );
      // Height badge
      parts.push(
        `<line x1="${(p110.x + 14).toFixed(1)}" y1="${p110.y.toFixed(1)}" x2="${(p111.x + 14).toFixed(1)}" y2="${p111.y.toFixed(1)}" stroke="${PALETTE.inkCss}" stroke-width="2"/>` +
        `<rect x="${(hx - 12).toFixed(1)}" y="${(hy - 18).toFixed(1)}" width="136" height="34" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.inkCss}" stroke-width="1.5"/>` +
        `<text x="${(hx + 56).toFixed(1)}" y="${(hy + 5).toFixed(1)}" text-anchor="middle" font-size="20" font-weight="600" fill="${PALETTE.inkCss}" data-dim="height">H ${hVal} mm</text>`,
      );
      // Tilt badge (front-left corner)
      const tx = clamp(p000.x - 108, 48, 1700);
      const ty = clamp(p000.y - 16, 120, 960);
      parts.push(
        `<path d="M ${(tx + 64).toFixed(1)} ${(ty + 12).toFixed(1)} L ${(tx + 106).toFixed(1)} ${(ty + 12).toFixed(1)} M ${(tx + 64).toFixed(1)} ${(ty + 12).toFixed(1)} L ${(tx + 104).toFixed(1)} ${(ty - 4).toFixed(1)}" stroke="${PALETTE.orangeCss}" stroke-width="2" fill="none"/>` +
        `<rect x="${(tx - 68).toFixed(1)}" y="${(ty - 18).toFixed(1)}" width="128" height="34" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.orangeCss}" stroke-width="1.5"/>` +
        `<text x="${(tx - 4).toFixed(1)}" y="${(ty + 5).toFixed(1)}" text-anchor="middle" font-size="20" font-weight="600" fill="${PALETTE.orangeCss}" data-dim="tilt">∠ ${tVal}°</text>`,
      );
      parts.push('</g>');
    }

    // 2.2-6.6s: 5-group exploded layer tags along right margin
    if (bbox.layerTagsOpacity > 0.02) {
      parts.push(`<g opacity="${bbox.layerTagsOpacity.toFixed(3)}" font-family="IBM Plex Mono, monospace">`);
      const labelX = 1605;
      for (let i = 0; i < metrics.groups.length; i++) {
        const gm = metrics.groups[i];
        const grp = groupList[i];
        grp.updateMatrixWorld(true);
        const gb = new THREE.Box3().setFromObject(grp);
        const anchor3 = new THREE.Vector3(gb.max.x, (gb.min.y + gb.max.y) / 2, (gb.min.z + gb.max.z) / 2);
        const pt = projectToSvg(anchor3, camera);
        const ly = clamp(pt.y, 130 + (4 - i) * 145, 920);
        parts.push(
          `<polyline points="${pt.x.toFixed(1)},${pt.y.toFixed(1)} ${(labelX - 24).toFixed(1)},${ly.toFixed(1)} ${labelX},${ly.toFixed(1)}" fill="none" stroke="${PALETTE.inkCss}" stroke-width="1.5" stroke-dasharray="4 3"/>` +
          `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="4" fill="${PALETTE.orangeCss}"/>` +
          `<rect x="${labelX}" y="${(ly - 17).toFixed(1)}" width="248" height="34" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.inkCss}" stroke-width="1.4"/>` +
          `<text x="${labelX + 12}" y="${(ly + 6).toFixed(1)}" font-size="18" font-weight="600" fill="${PALETTE.inkCss}">${gm.code}</text>` +
          `<text x="${labelX + 236}" y="${(ly + 6).toFixed(1)}" text-anchor="end" font-size="18" font-weight="600" fill="${PALETTE.orangeCss}">${gm.count} pcs</text>`,
        );
      }
      parts.push('</g>');
    }
    return parts.join('');
  }

  function renderCoreLeaders(state, camera) {
    if (state.leaders.opacity <= 0.02) return '';
    const m3Count = metrics.bom.find((b) => b.id === 'bom-fast-m3')?.count ?? 12;
    const m2Count = metrics.bom.find((b) => b.id === 'bom-fast-m2')?.count ?? 20;
    const callouts = [
      {
        id: 'mcu',
        anchor: metrics.anchors.mcu,
        boxX: 112,
        boxY: 220,
        align: 'left',
        title: 'MCU · ATMEGA32U4',
        count: '×1',
      },
      {
        id: 'diode',
        anchor: metrics.anchors.diode,
        boxX: 112,
        boxY: 780,
        align: 'left',
        title: 'DIODE · 1N4148',
        count: `×${metrics.diodes}`,
      },
      {
        id: 'fastener',
        anchor: metrics.anchors.fastener,
        boxX: 1470,
        boxY: 220,
        align: 'right',
        title: 'BOLT · M3 / M2',
        count: `${m3Count}/${m2Count}`,
      },
      {
        id: 'pads',
        anchor: metrics.anchors.pads,
        boxX: 1470,
        boxY: 780,
        align: 'right',
        title: 'PADS · MATRIX 4×12',
        count: `×${metrics.pads}`,
      },
    ];

    const parts = [`<g opacity="${state.leaders.opacity.toFixed(3)}" font-family="IBM Plex Mono, monospace">`];
    callouts.forEach((c, idx) => {
      const slot = Math.max(0, Math.min(1, (state.leaders.progress - idx * 0.16) / 0.45));
      if (slot <= 0.01) return;
      const pt = projectToSvg(c.anchor, camera);
      const boxW = 336;
      const boxH = 48;
      const endX = c.align === 'left' ? c.boxX + boxW : c.boxX;
      const endY = c.boxY + boxH / 2;
      const elbowX = c.align === 'left' ? endX + 46 : endX - 46;

      parts.push(
        `<g opacity="${slot.toFixed(3)}">` +
        `<polyline points="${pt.x.toFixed(1)},${pt.y.toFixed(1)} ${elbowX.toFixed(1)},${endY.toFixed(1)} ${endX.toFixed(1)},${endY.toFixed(1)}" fill="none" stroke="${PALETTE.inkCss}" stroke-width="2"/>` +
        `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="6" fill="${PALETTE.orangeCss}" stroke="${PALETTE.bgCss}" stroke-width="2"/>` +
        `<rect x="${c.boxX}" y="${c.boxY}" width="${boxW}" height="${boxH}" rx="3" fill="${PALETTE.bgCss}" stroke="${PALETTE.inkCss}" stroke-width="1.6"/>` +
        `<text x="${c.boxX + 16}" y="${c.boxY + 30}" font-size="19" font-weight="600" fill="${PALETTE.inkCss}">${c.title}</text>` +
        `<text x="${c.boxX + boxW - 16}" y="${c.boxY + 30}" text-anchor="end" font-size="20" font-weight="700" fill="${PALETTE.orangeCss}">${c.count}</text>` +
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
    const blinkAlpha = isWarn ? 0.42 + 0.58 * state.closeup.blink : 1.0;

    const basePt = projectToSvg(metrics.closeupFlangeWorld, camera);
    const liftedWorld = metrics.closeupFlangeWorld.clone();
    liftedWorld.z += state.closeup.gapMm;
    const topPt = projectToSvg(liftedWorld, camera);

    const badgeX = clamp(topPt.x + 125, 160, 1460);
    const badgeY = clamp(topPt.y - 120, 140, 760);

    const badgeText = isWarn
      ? `⚠  ΔZ +${state.closeup.gapMm.toFixed(1)} mm`
      : '0 ✓';
    const subText = isWarn
      ? `SW #${state.closeup.keyId} · 2.00U`
      : `SW #${state.closeup.keyId} · SEATED`;

    return (
      `<g font-family="IBM Plex Mono, monospace">` +
      `<circle cx="${topPt.x.toFixed(1)}" cy="${topPt.y.toFixed(1)}" r="${isWarn ? 22 : 28}" fill="none" stroke="${color}" stroke-width="3" opacity="${blinkAlpha.toFixed(3)}"/>` +
      `<line x1="${basePt.x.toFixed(1)}" y1="${basePt.y.toFixed(1)}" x2="${topPt.x.toFixed(1)}" y2="${topPt.y.toFixed(1)}" stroke="${color}" stroke-width="3.5"/>` +
      `<polyline points="${topPt.x.toFixed(1)},${topPt.y.toFixed(1)} ${(badgeX - 24).toFixed(1)},${(badgeY + 36).toFixed(1)} ${badgeX.toFixed(1)},${(badgeY + 36).toFixed(1)}" fill="none" stroke="${color}" stroke-width="2.5"/>` +
      `<g opacity="${blinkAlpha.toFixed(3)}">` +
      `<rect x="${badgeX.toFixed(1)}" y="${badgeY.toFixed(1)}" width="300" height="76" rx="4" fill="${PALETTE.bgCss}" stroke="${color}" stroke-width="2.5"/>` +
      `<text x="${(badgeX + 20).toFixed(1)}" y="${(badgeY + 35).toFixed(1)}" font-size="26" font-weight="700" fill="${color}" data-closeup-badge="${state.closeup.status}">${badgeText}</text>` +
      `<text x="${(badgeX + 20).toFixed(1)}" y="${(badgeY + 61).toFixed(1)}" font-size="16" font-weight="600" fill="${PALETTE.inkCss}">${subText}</text>` +
      `</g></g>`
    );
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

    // X-Ray scan telemetry chip
    if (state.scan.active && state.scan.opacity > 0.05 && scanStats) {
      if (telemetryEl.hidden) telemetryEl.hidden = false;
      const done = scanStats.fastenersOk >= metrics.fasteners && scanStats.pinsOk >= metrics.pins;
      const zDisplay = Math.max(0, state.scan.zWorld).toFixed(1);
      const txt = `Z ${zDisplay} mm  ·  FST ${scanStats.fastenersOk}/${metrics.fasteners}  ·  PIN ${scanStats.pinsOk}/${metrics.pins}  ·  PAD ${scanStats.padsOk}/${metrics.pads}${done ? '  ·  OK ✓' : ''}`;
      setText(telemetryEl, 'telemetry', txt);
      telemetryEl.dataset.ok = done ? '1' : '0';
    } else if (!telemetryEl.hidden) {
      telemetryEl.hidden = true;
    }

    // SVG overlay composition
    const svgBody =
      renderDimsAndLayers(state, camera, groupList) +
      renderCoreLeaders(state, camera) +
      renderCloseupOverlay(state, camera);
    setSvg(svgBody);

    // 29-32s Final 6-cell build report
    if (state.report.opacity > 0.01) {
      if (reportEl.hidden) reportEl.hidden = false;
      reportEl.style.opacity = state.report.opacity.toFixed(3);
      const p = state.report.progress;
      setText(repPartsEl, 'repParts', String(Math.round(metrics.totalParts * p)));
      setText(repStepsEl, 'repSteps', String(Math.round(metrics.stepsCount * p)));
      setText(repGroupsEl, 'repGroups', String(Math.round(metrics.groupsCount * p)));
      setText(repTimeEl, 'repTime', (metrics.durationSec * p).toFixed(1));
      setText(repShortEl, 'repShort', '0');
      setText(repGapEl, 'repGap', p > 0.75 ? '0 ✓' : '0');
    } else if (!reportEl.hidden) {
      reportEl.hidden = true;
    }
  }

  return { update };
}
