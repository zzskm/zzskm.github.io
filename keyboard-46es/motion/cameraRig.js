import * as THREE from '../vendor/three.module.js';
import { easeOutCubic } from './timeline.js';

export const DEFAULT_CAM = Object.freeze({
  azimuthDeg: -34,
  elevationDeg: 35.264,
  zoom: 1.0,
  targetOffset: [0, 0, 0],
  screenShiftX: 0,
  screenShiftY: 0,
});

export const CAMERA_PRESETS = Object.freeze({
  iso: { label: 'ISO', azimuthDeg: -34, elevationDeg: 35.264, zoom: 1.0 },
  top: { label: 'TOP', azimuthDeg: 0, elevationDeg: 89, zoom: 1.02 },
  front: { label: 'FRT', azimuthDeg: 0, elevationDeg: 6, zoom: 1.05 },
  side: { label: 'SID', azimuthDeg: 90, elevationDeg: 8, zoom: 1.32 },
  bottom: { label: 'BTM', azimuthDeg: -34, elevationDeg: -38, zoom: 1.02 },
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, u) => a + (b - a) * u;

function lerpAngleDeg(a, b, u) {
  let d = ((b - a + 540) % 360) - 180;
  return a + d * u;
}

function clonePose(p) {
  return {
    azimuthDeg: p.azimuthDeg ?? DEFAULT_CAM.azimuthDeg,
    elevationDeg: p.elevationDeg ?? DEFAULT_CAM.elevationDeg,
    zoom: p.zoom ?? DEFAULT_CAM.zoom,
    targetOffset: [
      p.targetOffset?.[0] ?? 0,
      p.targetOffset?.[1] ?? 0,
      p.targetOffset?.[2] ?? 0,
    ],
    screenShiftX: p.screenShiftX ?? 0,
    screenShiftY: p.screenShiftY ?? 0,
  };
}

export function createCameraRig(metrics, container) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
  camera.up.set(0, 0, 1);

  const baseTarget = metrics.center.clone();
  const radius = 900;
  const baseSpanY = Math.max(metrics.widthMm * 0.72, metrics.depthMm * 1.45, 225);

  let aspect = 16 / 9;
  const currentTarget = baseTarget.clone();
  const dir = new THREE.Vector3();
  const rightVec = new THREE.Vector3();
  const upVec = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 0, 1);

  // 2-Mode Camera State: 'Timeline' | 'UserOverride' | 'Blending'
  let mode = 'Timeline';
  let activePreset = null;
  let effectivePose = clonePose(DEFAULT_CAM);
  let userPose = clonePose(DEFAULT_CAM);
  let blendFromPose = clonePose(DEFAULT_CAM);
  let blendToPresetPose = null; // non-null when animating to a preset, null when blending back to Timeline
  let blendStartMs = 0;
  let blendDurationMs = 450;

  function resize(width, height) {
    aspect = Math.max(0.4, width / Math.max(1, height));
    const mobileFactor = aspect < 1.1 ? 1.55 / Math.max(0.55, aspect) : 1.0;
    const halfH = (baseSpanY * mobileFactor) / 2;
    const halfW = halfH * aspect;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }

  function enterUserOverride() {
    if (mode !== 'UserOverride') {
      userPose = clonePose(effectivePose);
      mode = 'UserOverride';
      blendToPresetPose = null;
    }
  }

  function orbitBy(dAzDeg, dElDeg) {
    enterUserOverride();
    activePreset = null;
    userPose.azimuthDeg = ((userPose.azimuthDeg + dAzDeg + 540) % 360) - 180;
    userPose.elevationDeg = clamp(userPose.elevationDeg + dElDeg, -85, 89);
  }

  function zoomBy(factor) {
    enterUserOverride();
    userPose.zoom = clamp(userPose.zoom * factor, 0.55, 4.5);
  }

  function panByPixels(dxPx, dyPx, viewportW, viewportH) {
    enterUserOverride();
    activePreset = null;
    const visibleW = (camera.right - camera.left) / userPose.zoom;
    const visibleH = (camera.top - camera.bottom) / userPose.zoom;
    const az = THREE.MathUtils.degToRad(userPose.azimuthDeg);
    const el = THREE.MathUtils.degToRad(userPose.elevationDeg);
    const cosEl = Math.cos(el);
    dir.set(Math.sin(az) * cosEl, -Math.cos(az) * cosEl, Math.sin(el)).normalize();
    rightVec.crossVectors(worldUp, dir);
    if (rightVec.lengthSq() < 1e-6) rightVec.set(1, 0, 0);
    else rightVec.normalize();
    upVec.crossVectors(dir, rightVec).normalize();

    const moveX = -(dxPx / Math.max(1, viewportW)) * visibleW;
    const moveY = (dyPx / Math.max(1, viewportH)) * visibleH;
    userPose.targetOffset[0] = clamp(userPose.targetOffset[0] + rightVec.x * moveX + upVec.x * moveY, -240, 240);
    userPose.targetOffset[1] = clamp(userPose.targetOffset[1] + rightVec.y * moveX + upVec.y * moveY, -180, 180);
    userPose.targetOffset[2] = clamp(userPose.targetOffset[2] + rightVec.z * moveX + upVec.z * moveY, -140, 160);
  }

  function setPreset(name, animateMs = 320, nowMs = performance.now()) {
    const preset = CAMERA_PRESETS[name];
    if (!preset) return;
    activePreset = name;
    const targetPose = {
      azimuthDeg: preset.azimuthDeg,
      elevationDeg: preset.elevationDeg,
      zoom: preset.zoom,
      targetOffset: [0, 0, 0],
      screenShiftX: 0,
      screenShiftY: 0,
    };
    if (animateMs <= 0) {
      userPose = clonePose(targetPose);
      effectivePose = clonePose(targetPose);
      mode = 'UserOverride';
      blendToPresetPose = null;
      return;
    }
    blendFromPose = clonePose(effectivePose);
    blendToPresetPose = targetPose;
    blendStartMs = nowMs;
    blendDurationMs = animateMs;
    mode = 'Blending';
  }

  function blendToTimeline(durationMs = 450, nowMs = performance.now()) {
    activePreset = null;
    if (mode === 'Timeline') return;
    if (durationMs <= 0) {
      mode = 'Timeline';
      blendToPresetPose = null;
      return;
    }
    blendFromPose = clonePose(effectivePose);
    blendToPresetPose = null;
    blendStartMs = nowMs;
    blendDurationMs = durationMs;
    mode = 'Blending';
  }

  function resolvePose(baseCamState = DEFAULT_CAM, nowMs = performance.now()) {
    if (mode === 'Timeline') {
      effectivePose = clonePose(baseCamState);
      return effectivePose;
    }
    if (mode === 'UserOverride') {
      effectivePose = clonePose(userPose);
      return effectivePose;
    }
    // Blending mode
    const rawU = blendDurationMs > 0 ? clamp((nowMs - blendStartMs) / blendDurationMs, 0, 1) : 1;
    const u = easeOutCubic(rawU);
    const dst = blendToPresetPose || baseCamState;
    effectivePose = {
      azimuthDeg: lerpAngleDeg(blendFromPose.azimuthDeg, dst.azimuthDeg, u),
      elevationDeg: lerp(blendFromPose.elevationDeg, dst.elevationDeg, u),
      zoom: lerp(blendFromPose.zoom, dst.zoom, u),
      targetOffset: [
        lerp(blendFromPose.targetOffset[0], dst.targetOffset?.[0] ?? 0, u),
        lerp(blendFromPose.targetOffset[1], dst.targetOffset?.[1] ?? 0, u),
        lerp(blendFromPose.targetOffset[2], dst.targetOffset?.[2] ?? 0, u),
      ],
      screenShiftX: lerp(blendFromPose.screenShiftX, dst.screenShiftX ?? 0, u),
      screenShiftY: lerp(blendFromPose.screenShiftY, dst.screenShiftY ?? 0, u),
    };
    if (rawU >= 1) {
      if (blendToPresetPose) {
        userPose = clonePose(blendToPresetPose);
        mode = 'UserOverride';
        blendToPresetPose = null;
      } else {
        mode = 'Timeline';
      }
    }
    return effectivePose;
  }

  function applyPose(pose = DEFAULT_CAM) {
    const az = THREE.MathUtils.degToRad(pose.azimuthDeg ?? DEFAULT_CAM.azimuthDeg);
    const el = THREE.MathUtils.degToRad(clamp(pose.elevationDeg ?? DEFAULT_CAM.elevationDeg, -85, 89));
    const zoom = clamp(pose.zoom ?? DEFAULT_CAM.zoom, 0.55, 4.5);
    const off = pose.targetOffset || DEFAULT_CAM.targetOffset;
    const shiftX = pose.screenShiftX || 0;
    const shiftY = pose.screenShiftY || 0;

    const cosEl = Math.cos(el);
    dir.set(Math.sin(az) * cosEl, -Math.cos(az) * cosEl, Math.sin(el)).normalize();

    currentTarget.set(
      baseTarget.x + off[0],
      baseTarget.y + off[1],
      baseTarget.z + off[2],
    );

    if (shiftX !== 0 || shiftY !== 0) {
      rightVec.crossVectors(worldUp, dir);
      if (rightVec.lengthSq() < 1e-6) rightVec.set(1, 0, 0);
      else rightVec.normalize();
      upVec.crossVectors(dir, rightVec).normalize();
      const visibleW = (camera.right - camera.left) / zoom;
      const visibleH = (camera.top - camera.bottom) / zoom;
      currentTarget.addScaledVector(rightVec, -shiftX * visibleW);
      currentTarget.addScaledVector(upVec, -shiftY * visibleH);
    }

    camera.position.copy(currentTarget).addScaledVector(dir, radius);
    camera.zoom = zoom;
    camera.lookAt(currentTarget);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  function applyAdaptiveUnderside(elevationDeg, underLight, groundGroup, groundMaterials) {
    // Full ground shutoff below -2 deg so underside views never flicker or clip through floor plane
    if (groundGroup) {
      if (elevationDeg < -2) {
        groundGroup.visible = false;
      } else {
        groundGroup.visible = true;
        const fade = clamp((elevationDeg + 2) / 12, 0, 1);
        if (groundMaterials) {
          groundMaterials.shadowMat.opacity = 0.08 * fade;
          groundMaterials.tickMat.opacity = 0.24 * fade;
        }
      }
    }
    if (underLight) {
      const underK = clamp((8 - elevationDeg) / 40, 0, 1);
      underLight.intensity = 0.12 + 0.88 * underK;
    }
  }

  const rect = container.getBoundingClientRect();
  resize(rect.width || 1920, rect.height || 1080);
  applyPose(DEFAULT_CAM);

  return {
    camera,
    baseTarget,
    resize,
    resolvePose,
    applyPose,
    applyAdaptiveUnderside,
    orbitBy,
    zoomBy,
    panByPixels,
    setPreset,
    blendToTimeline,
    enterUserOverride,
    isAnimating: () => mode === 'Blending',
    getMode: () => mode,
    getActivePreset: () => activePreset,
    getPose: () => clonePose(effectivePose),
  };
}
