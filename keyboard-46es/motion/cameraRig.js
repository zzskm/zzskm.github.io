import * as THREE from '../vendor/three.module.js';

export const DEFAULT_CAM = Object.freeze({
  azimuthDeg: -34,
  elevationDeg: 35.264,
  zoom: 1.0,
  targetOffset: [0, 0, 0],
  screenShiftX: 0,
  screenShiftY: 0,
});

export function createCameraRig(metrics, container) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
  camera.up.set(0, 0, 1);

  const baseTarget = metrics.center.clone();
  const radius = 900;
  // Base frustum sized dynamically from the actual 3D bounding box so it fits 1920x1080 cleanly
  const baseSpanY = Math.max(metrics.widthMm * 0.72, metrics.depthMm * 1.45, 225);

  let aspect = 16 / 9;
  const currentTarget = baseTarget.clone();
  const dir = new THREE.Vector3();
  const rightVec = new THREE.Vector3();
  const upVec = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 0, 1);

  function resize(width, height) {
    aspect = Math.max(0.4, width / Math.max(1, height));
    // Mobile portrait needs slightly wider view so horizontal keyboard never clips
    const mobileFactor = aspect < 1.1 ? 1.55 / Math.max(0.55, aspect) : 1.0;
    const halfH = (baseSpanY * mobileFactor) / 2;
    const halfW = halfH * aspect;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }

  function applyState(state = DEFAULT_CAM) {
    const az = THREE.MathUtils.degToRad(state.azimuthDeg ?? DEFAULT_CAM.azimuthDeg);
    const el = THREE.MathUtils.degToRad(state.elevationDeg ?? DEFAULT_CAM.elevationDeg);
    const zoom = state.zoom ?? DEFAULT_CAM.zoom;
    const off = state.targetOffset || DEFAULT_CAM.targetOffset;
    const shiftX = state.screenShiftX || 0;
    const shiftY = state.screenShiftY || 0;

    // Z-up spherical direction from target toward camera
    const cosEl = Math.cos(el);
    dir.set(
      Math.sin(az) * cosEl,
      -Math.cos(az) * cosEl,
      Math.sin(el),
    ).normalize();

    currentTarget.set(
      baseTarget.x + off[0],
      baseTarget.y + off[1],
      baseTarget.z + off[2],
    );

    // Screen-plane shift (negative shiftX moves camera target left -> keyboard shifts right on screen!)
    if (shiftX !== 0 || shiftY !== 0) {
      rightVec.crossVectors(worldUp, dir).normalize();
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

  const rect = container.getBoundingClientRect();
  resize(rect.width || 1920, rect.height || 1080);
  applyState(DEFAULT_CAM);

  return {
    camera,
    baseTarget,
    resize,
    applyState,
  };
}
