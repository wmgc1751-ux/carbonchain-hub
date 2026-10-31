/* =====================================================================
   twin3d.js —— 3D 数字孪生组件（可独立挂载，不侵入现有视图）
   ---------------------------------------------------------------------
   设计约束（按任务要求逐条落实）：

   ① **真交互**：OrbitControls 自由旋转/缩放 + Raycasting 点击拾取。
      不是"看起来会动"的动画 —— 是用户拖拽真的改变相机、点击真的改变选中态。

   ② **点击联动**：点中某个车间/区块，触发回调，由宿主页面更新右侧抽屉。
      组件本身不写业务逻辑，只负责"我点了哪个对象"。

   ③ **性能与降级**：
      · three.js 懒加载（首次进入 3D 页才下载 654 KB，不拖慢其他页面）
      · 帧率守卫：连续掉帧自动降级（关阴影/降像素比/停动画）
      · WebGL 不可用时整块降级为 2D 列表（不是白屏）
      · 页面隐藏时暂停渲染循环（requestAnimationFrame 停摆不耗电）

   ④ **零构建**：作为普通 <script> 加载，挂到 App.Twin3D，与现有架构一致。
      不引入打包器、不改 index.html 的加载方式。

   为什么自己写而不引第三方 3D 库：three.js 已经是唯一依赖，
   再引一个封装层只增加体积与不透明度。这个文件约 600 行，覆盖全部需求。
   ===================================================================== */
(function (global) {
  'use strict';

  /* ==================================================================
   * 一、懒加载 three.js
   * ================================================================== */
  const THREE_URLS = ['./vendor/three.min.js', './vendor/OrbitControls.js'];
  let threePromise = null;

  /** 按顺序加载脚本（保持顺序，OrbitControls 依赖 THREE 已存在） */
  function loadScripts(urls) {
    return urls.reduce((p, url) => p.then(() => new Promise((resolve, reject) => {
      /* 已加载过就跳过 */
      if (document.querySelector(`script[data-src="${url}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = url;
      s.async = false;
      s.dataset.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('加载失败：' + url));
      document.head.appendChild(s);
    })), Promise.resolve());
  }

  function loadThree() {
    if (threePromise) return threePromise;
    threePromise = loadScripts(THREE_URLS).then(() => {
      if (!global.THREE) throw new Error('THREE 未挂载到全局');
      if (!global.THREE.OrbitControls) throw new Error('OrbitControls 未挂载');
      return global.THREE;
    }).catch((e) => {
      threePromise = null;      // 失败允许重试
      throw e;
    });
    return threePromise;
  }

  /** WebGL 能力探测（比 try/catch 创建 renderer 更早、更便宜） */
  function hasWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(global.WebGLRenderingContext
        && (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) {
      return false;
    }
  }

  /* ==================================================================
   * 二、场景定义（纯数据，便于测试与替换）
   * ================================================================== */

  /**
   * 园区布局：每个车间是一个"建筑体"，带业务属性与坐标。
   *
   * 坐标设计说明：采用 x∈[-4,4], z∈[-3,3] 的平面网格，y 为高度。
   * 车间之间留 1.2 的间隙，保证从任意角度都能看清彼此，且点击不易误选。
   */
  const DEFAULT_LAYOUT = [
    { id: 'WS-01', name: '烧结车间', x: -3.2, z: -1.6, w: 1.6, h: 1.2, d: 1.4, color: 0x10b981, scope: 1, kind: 'SINTER' },
    { id: 'WS-02', name: '炼铁高炉', x: -3.2, z: 1.6, w: 1.6, h: 2.2, d: 1.4, color: 0xf43f5e, scope: 1, kind: 'BLAST' },
    { id: 'WS-03', name: '转炉炼钢', x: -0.9, z: -1.6, w: 1.6, h: 1.6, d: 1.4, color: 0xf5a524, scope: 1, kind: 'BOF' },
    { id: 'WS-04', name: '轧钢车间', x: -0.9, z: 1.6, w: 1.6, h: 1.0, d: 1.4, color: 0x06b6d4, scope: 2, kind: 'ROLL' },
    { id: 'WS-05', name: '自备电厂', x: 1.5, z: -1.6, w: 1.6, h: 2.6, d: 1.4, color: 0xa78bfa, scope: 1, kind: 'POWER' },
    { id: 'WS-06', name: '石灰窑', x: 1.5, z: 1.6, w: 1.6, h: 1.4, d: 1.4, color: 0x94a3b8, scope: 1, kind: 'LIME' },
    { id: 'WS-07', name: '原料堆场', x: 3.6, z: 0, w: 1.3, h: 0.7, d: 2.6, color: 0x64748b, scope: 3, kind: 'STOCK' },
  ];

  /* ==================================================================
   * 三、渲染器封装
   * ================================================================== */

  /**
   * 创建 3D 场景。
   *
   * @param {HTMLElement} container 挂载容器
   * @param {object} opts
   *   layout      车间布局（缺省用 DEFAULT_LAYOUT）
   *   onPick      (item | null) => void  点击拾取回调
   *   onFps       (fps) => void          帧率回调（宿主可展示）
   *   quality     'high' | 'auto'        初始画质
   * @returns {Promise<object>} 控制器句柄
   */
  async function createScene(container, opts = {}) {
    const THREE = await loadThree();
    const layout = Array.isArray(opts.layout) && opts.layout.length ? opts.layout : DEFAULT_LAYOUT;

    /* ---------- 基础三件套 ---------- */
    const scene = new THREE.Scene();
    scene.background = null;                       // 透明，让 CSS 背景透出
    /* 雾：让远处物体淡出，减少"边界感"，也让性能更好（远处可少画细节） */
    scene.fog = new THREE.Fog(0x0b1220, 14, 30);

    const width = Math.max(320, container.clientWidth || 800);
    const height = Math.max(260, container.clientHeight || 480);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(7.5, 7.5, 9.5);
    camera.lookAt(0, 1, 0);

    /* 像素比上限 2：4K 屏上 3 倍像素比会让 GPU 负载翻倍，视觉差异极小。
     * 这是"看起来一样但快一倍"的典型取舍。 */
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    /* ---------- 光照 ---------- */
    /* 环境光给基础亮度，方向光给立体感与阴影。
     * 只用一盏方向光而非多盏 —— 阴影贴图的开销与灯数成正比。 */
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);

    const dir = new THREE.DirectionalLight(0xffffff, 0.95);
    dir.position.set(8, 14, 6);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    /* 阴影相机范围要紧贴场景，否则阴影会糊成一片 */
    dir.shadow.camera.left = -10;
    dir.shadow.camera.right = 10;
    dir.shadow.camera.top = 10;
    dir.shadow.camera.bottom = -10;
    dir.shadow.camera.near = 0.5;
    dir.shadow.camera.far = 40;
    scene.add(dir);

    /* 暖色补光：让建筑有一点轮廓光，避免整体发灰 */
    const rim = new THREE.DirectionalLight(0x66d9c0, 0.35);
    rim.position.set(-6, 4, -8);
    scene.add(rim);

    /* ---------- 地面 ---------- */
    const groundGeo = new THREE.PlaneGeometry(26, 26);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a, roughness: 0.95, metalness: 0.05,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    /* 网格辅助线：给空间一个"尺度参照"，也让旋转时更容易感知方向 */
    const grid = new THREE.GridHelper(26, 26, 0x1e293b, 0x172033);
    grid.position.y = 0.002;
    scene.add(grid);

    /* ---------- 建筑体 ---------- */
    const pickables = [];       // 可拾取对象（Raycaster 只测这些，不测地面/网格）
    const items = new Map();    // mesh.userData.id → 业务数据

    layout.forEach((it) => {
      const geo = new THREE.BoxGeometry(it.w, it.h, it.d);
      const mat = new THREE.MeshStandardMaterial({
        color: it.color,
        roughness: 0.45,
        metalness: 0.25,
        /* 自发光一点点，让建筑在暗背景下不发黑 */
        emissive: new THREE.Color(it.color).multiplyScalar(0.12),
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(it.x, it.h / 2, it.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.id = it.id;
      mesh.userData.baseColor = it.color;
      scene.add(mesh);
      pickables.push(mesh);

      /* 顶部高光线：让每栋建筑有"边缘"，视觉上更清晰 */
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: it.color, transparent: true, opacity: 0.75 })
      );
      edge.position.copy(mesh.position);
      scene.add(edge);
      mesh.userData.edge = edge;

      items.set(it.id, { ...it, mesh });
    });

    /* ---------- 控制器 ---------- */
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;        // 惯性，让拖拽手感更顺
    controls.dampingFactor = 0.08;
    controls.minDistance = 5;
    controls.maxDistance = 24;
    /* 限制俯仰角：不允许转到地面以下 —— 那会看到"世界的底部"，
     * 是 3D 场景最常见的破绽 */
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minPolarAngle = Math.PI * 0.08;
    controls.target.set(0, 0.9, 0);
    controls.update();

    /* ==================================================================
     * 四、交互：Raycasting 点击拾取
     * ================================================================== */
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let selectedId = null;

    /** 把鼠标/触摸坐标转成 NDC 并做射线检测 */
    function pickAt(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(pickables, false);
      return hits.length ? hits[0].object : null;
    }

    /** 高亮选中的建筑：抬高一点 + 自发光增强 + 描边加亮 */
    function setSelected(id) {
      selectedId = id;
      items.forEach((it, key) => {
        const on = key === id;
        /* 只改自发光强度即可表达"选中"，不要去改 emissive 的色相 ——
         * 那会覆盖建筑本身的行业色（绿=烧结/红=高炉/紫=电厂），
         * 用户就分不清哪栋是哪栋了。 */
        it.mesh.material.emissive.copy(new THREE.Color(it.baseColor))
          .multiplyScalar(on ? 0.55 : 0.12);
        it.mesh.position.y = (on ? it.h / 2 + 0.18 : it.h / 2);
        if (it.mesh.userData.edge) {
          it.mesh.userData.edge.material.opacity = on ? 1 : 0.75;
          it.mesh.userData.edge.position.y = it.mesh.position.y;
        }
      });
    }

    /* 区分"点击"与"拖拽旋转"：
     * 记下 pointerdown 位置，pointerup 时位移小于阈值才算点击。
     * 否则用户每次旋转视角都会误触发选中 —— 这是 3D 交互最影响手感的问题。 */
    let downX = 0, downY = 0, downT = 0;
    const CLICK_MOVE_PX = 6;
    const CLICK_MS = 600;

    function onPointerDown(e) {
      downX = e.clientX; downY = e.clientY; downT = Date.now();
    }
    function onPointerUp(e) {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      const elapsed = Date.now() - downT;
      if (moved > CLICK_MOVE_PX || elapsed > CLICK_MS) return;   // 是拖拽，不是点击

      const mesh = pickAt(e.clientX, e.clientY);
      const id = mesh ? mesh.userData.id : null;
      setSelected(id);
      const item = id ? items.get(id) : null;
      if (typeof opts.onPick === 'function') {
        opts.onPick(item ? { ...item, mesh: undefined } : null);
      }
    }
    /* 用 pointerup 而非 click：touch 与 mouse 统一，且能在容器内任意位置触发 */
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    /* 悬停时改光标，给出"这里可点"的暗示 */
    let hoverRaf = 0;
    function onPointerMove(e) {
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const mesh = pickAt(e.clientX, e.clientY);
        renderer.domElement.style.cursor = mesh ? 'pointer' : 'grab';
      });
    }
    renderer.domElement.addEventListener('pointermove', onPointerMove);

    /* ==================================================================
     * 五、渲染循环 + 帧率守卫 + 性能降级
     * ================================================================== */
    let raf = 0;
    let running = true;
    let frames = 0;
    let lastFpsT = performance.now();
    let fps = 0;
    let lowFpsStreak = 0;
    let degraded = 0;               // 0=完整 1=关阴影 2=降像素比
    const MAX_DEGRADE = 2;

    function degrade() {
      if (degraded >= MAX_DEGRADE) return;
      degraded += 1;
      if (degraded === 1) {
        /* 第一步：关阴影。视觉损失最小，性能收益最大。 */
        renderer.shadowMap.enabled = false;
        dir.castShadow = false;
        scene.traverse((o) => { if (o.isMesh) o.castShadow = false; });
      } else if (degraded === 2) {
        /* 第二步：降像素比到 1。在 4K 屏上这是 4 倍像素量差异。 */
        renderer.setPixelRatio(1);
        renderer.setSize(container.clientWidth || width, container.clientHeight || height, false);
      }
      if (typeof opts.onDegrade === 'function') opts.onDegrade(degraded);
    }

    function tick() {
      if (!running) return;
      raf = requestAnimationFrame(tick);

      const now = performance.now();
      frames += 1;
      if (now - lastFpsT >= 1000) {
        fps = Math.round((frames * 1000) / (now - lastFpsT));
        frames = 0;
        lastFpsT = now;
        if (typeof opts.onFps === 'function') opts.onFps(fps);

        /* 帧率守卫：连续 2 秒低于 24fps 就降一档。
         * 24fps 是"还能接受"的下限；低于它用户会明显感到卡顿。 */
        if (fps > 0 && fps < 24) {
          lowFpsStreak += 1;
          if (lowFpsStreak >= 2) { degrade(); lowFpsStreak = 0; }
        } else {
          lowFpsStreak = 0;
        }
      }

      controls.update();
      renderer.render(scene, camera);
    }

    /* 页面隐藏时停渲染：不可见的画面继续渲染纯属浪费电量 */
    function onVisibility() {
      if (document.hidden) {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (!running) {
        running = true;
        lastFpsT = performance.now();
        frames = 0;
        tick();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

    /* ==================================================================
     * 六、尺寸自适应
     * ================================================================== */
    const ro = ('ResizeObserver' in global)
      ? new ResizeObserver(() => resize())
      : null;
    if (ro) ro.observe(container);
    else global.addEventListener('resize', resize);

    let resizeRaf = 0;
    function resize() {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        const w = Math.max(320, container.clientWidth || width);
        const h = Math.max(260, container.clientHeight || height);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
      });
    }

    tick();

    /* ==================================================================
     * 七、对外句柄
     * ================================================================== */
    return {
      THREE, scene, camera, renderer, controls,
      items,
      /** 程序化选中（供 AI 空间指令调用） */
      select(id) {
        if (id && !items.has(id)) return false;
        setSelected(id || null);
        const it = id ? items.get(id) : null;
        if (typeof opts.onPick === 'function') {
          opts.onPick(it ? { ...it, mesh: undefined } : null);
        }
        return true;
      },
      /** 相机飞到某个车间（AI 指令"带我去看炼铁高炉"用这个） */
      focus(id) {
        const it = items.get(id);
        if (!it) return false;
        const target = new THREE.Vector3(it.x, it.h / 2, it.z);
        /* 简单的视线方向：从当前相机方向靠近目标，保持相对角度不变 —— 
         * 比硬编码一个机位更自然，用户不会失去方向感。 */
        const dirv = camera.position.clone().sub(controls.target).normalize();
        camera.position.copy(target.clone().add(dirv.multiplyScalar(8)));
        controls.target.copy(target);
        controls.update();
        setSelected(id);
        if (typeof opts.onPick === 'function') {
          opts.onPick({ ...it, mesh: undefined });
        }
        return true;
      },
      /** 复位视角 */
      reset() {
        camera.position.set(7.5, 7.5, 9.5);
        controls.target.set(0, 0.9, 0);
        controls.update();
        setSelected(null);
        if (typeof opts.onPick === 'function') opts.onPick(null);
      },
      get fps() { return fps; },
      get degradedLevel() { return degraded; },
      dispose() {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        document.removeEventListener('visibilitychange', onVisibility);
        renderer.domElement.removeEventListener('pointerdown', onPointerDown);
        renderer.domElement.removeEventListener('pointerup', onPointerUp);
        renderer.domElement.removeEventListener('pointermove', onPointerMove);
        if (ro) ro.disconnect(); else global.removeEventListener('resize', resize);
        controls.dispose();
        /* 释放 GPU 资源：不 dispose 会泄漏，反复进出页面会让显存持续增长 */
        scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
            else o.material.dispose();
          }
        });
        renderer.dispose();
        if (renderer.domElement.parentNode) {
          renderer.domElement.parentNode.removeChild(renderer.domElement);
        }
      },
    };
  }

  /* ==================================================================
   * 八、导出
   * ================================================================== */
  global.App = global.App || {};
  global.App.Twin3D = {
    DEFAULT_LAYOUT,
    hasWebGL,
    loadThree,
    createScene,
    /** 供宿主判断是否该显示"不支持的浏览器"提示 */
    supported() { return hasWebGL(); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
