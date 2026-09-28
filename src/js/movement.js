/* ============================================================
   movement.js - 桌面走动（限定在屏幕右侧"活动区"上下跑，不挡工作区）
   挂载到 window.PetApp.movement
   ============================================================ */
window.PetApp = window.PetApp || {};

(function (App) {
  'use strict';

  const state = App.state;
  let pet;
  const PET_W = 160, PET_H = 176;
  const BOTTOM_MARGIN = 8;
  let screenW = 0, screenH = 0;
  let walkTimer = null;

  // 右侧活动区：占屏幕右侧约 26% 宽度，避免挡住主工作区
  function zoneLeft() { return Math.floor(screenW * 0.72); }
  function zoneRight() { return screenW - PET_W - 8; }
  function groundY() { return screenH - PET_H - BOTTOM_MARGIN; }
  function topY() { return Math.floor(screenH * 0.12); } // 可爬到的最高点
  function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  // 在当前位置附近随机选一个小目标点（不再强制回到固定活动区）
  function pickTarget() {
    const r = state.runtime;
    // 以当前位置为中心，小范围随机移动（±120px）
    let x = r.x + rand(-120, 120);
    // 限制在屏幕内
    x = Math.max(8, Math.min(screenW - PET_W - 8, x));
    // 70% 概率回地面，30% 概率爬高一点
    const y = Math.random() < 0.7 ? groundY() : rand(topY(), groundY() - 60);
    return { x, y };
  }

  function scheduleNext() {
    if (walkTimer) clearTimeout(walkTimer);
    walkTimer = setTimeout(randomMove, rand(8000, 18000));
  }

  function randomMove() {
    pet = pet || App.pet;
    // 拖拽中/睡觉中或 UI 打开时不动
    if (state.runtime.isDragging || state.runtime.isSleeping || App.uiOpen) { scheduleNext(); return; }

    // 50% 概率原地休息（减少频繁移动）
    if (Math.random() < 0.5) {
      pet.setMood(state.computeMood());
      scheduleNext();
      return;
    }

    const r = state.runtime;
    const target = pickTarget();
    const dir = target.x > r.x + 6 ? 'right' : (target.x < r.x - 6 ? 'left' : r.facing);
    state.setFacing(dir);
    pet.setFacing(dir);

    // 是否主要垂直移动（上下跑）
    const verticalMove = Math.abs(target.y - r.y) > 50;

    state.setRuntime({ isMoving: true });
    // 垂直爬升/下落用更柔和的曲线，水平平移保持默认
    const c = pet.els.container;
    if (verticalMove) {
      c.style.transition = 'top 0.9s cubic-bezier(.4,.7,.5,1), left 0.7s linear';
      pet.setMood(target.y < r.y ? 'happy' : 'normal'); // 爬上去开心
    } else {
      c.style.transition = '';
    }
    pet.setPosition(target.x, target.y);
    state.setPosition(target.x, target.y);

    const dur = verticalMove ? 950 : 500;
    setTimeout(() => {
      c.style.transition = '';
      if (!state.runtime.isDragging) {
        state.setRuntime({ isMoving: false });
        pet.setMood(state.computeMood());
      }
      scheduleNext();
    }, dur);
  }

  App.movement = {
    init(bounds) {
      screenW = bounds.width;
      screenH = bounds.height;
      pet = App.pet;
    },

    start() { scheduleNext(); },
    stop() { if (walkTimer) clearTimeout(walkTimer); walkTimer = null; },

    getGroundY: () => groundY(),
    getZone: () => ({ left: 8, right: screenW - PET_W - 8, groundY: groundY(), topY: topY() }),

    // 初始化时把宠物放到右侧活动区地面
    placeInZone() {
      pet = pet || App.pet;
      const x = Math.floor(screenW * 0.72 + (screenW * 0.28 - PET_W) / 2);
      const y = groundY();
      pet.setPosition(x, y);
      state.setPosition(x, y);
    },

    // 拖拽松手后自由落体到地面（保持在用户拖到的位置，不拉回活动区）
    applyGravity() {
      pet = pet || App.pet;
      const r = state.runtime;
      // 只限制在屏幕内，不强制拉回右侧活动区
      const gx = Math.max(8, Math.min(screenW - PET_W - 8, r.x));
      const gy = groundY();
      if (r.y >= gy - 1 && r.x === gx) { scheduleNext(); return; }

      const c = pet.els.container;
      c.style.transition = 'top 0.55s cubic-bezier(.55,0,.9,.5), left 0.45s linear';
      pet.setMood('surprised');
      pet.setPosition(gx, gy);
      state.setPosition(gx, gy);

      setTimeout(() => {
        c.style.transition = '';
        pet.bounce();
        pet.setMood(state.computeMood());
        scheduleNext();
      }, 580);
    },
  };
})(window.PetApp);
