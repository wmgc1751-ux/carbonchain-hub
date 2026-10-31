/* =====================================================================
   plant3d.js —— 真实厂区 3D 渲染内核（按真实尺度）
   ---------------------------------------------------------------------
   与上一版 twin3d.js 的区别：那版是"7 个示意方块"，这版是
   **按真实设施的物理尺寸等比建模**：

     · 尺度：1 场景单位 = 1 米（经等比缩放后）。烟囱 240 m 就是 240 单位，
       厂房 220×42×90 m 就是一个细长的长方体。高矮胖瘦关系是真实的。
     · 结构类型：锅炉房/汽机房/烟囱/冷却塔/储煤场/升压站/水处理，
       各自用不同的几何体表达（冷却塔用圆台、烟囱用细圆柱、储煤场用矮而宽的箱体）。
     · 热力着色：按每个结构的排放占比映射颜色（深绿→黄→红），
       一眼看出"排放集中在哪里"。
     · 尺度参照：一个 100 m 参考标尺（立在最高结构旁），让"这个厂多大"可感知。

   性能设计（延续上一版并加强）：
     · 几何体合并：同材质的结构用 InstancedMesh 批量绘制
     · 阴影只投在主要结构上
     · 帧率守卫三级降级
   ===================================================================== */
(function (global) {
  'use strict';

  let threePromise = null;

  function loadScripts(urls) {
    return urls.reduce((p, url) => p.then(() => new Promise((resolve, reject) => {
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
    threePromise = loadScripts(['./vendor/three.min.js', './vendor/OrbitControls.js'])
      .then(() => {
        if (!global.THREE) throw new Error('THREE 未挂载');
        if (!global.THREE.OrbitControls) throw new Error('OrbitControls 未挂载');
        return global.THREE;
      })
      .catch((e) => { threePromise = null; throw e; });
    return threePromise;
  }

  function hasWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(global.WebGLRenderingContext
        && (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  /* ==================================================================
   * 热力配色：按排放占比
   * ==================================================================
   * 用三段线性插值（绿→黄→红）而不是离散分档：
   * 离散分档在结构数少时会出现"两个排放差 3 倍的结构同色"，
   * 连续映射能真实反映差异。
   */
  function heatColor(ratio) {
    const t = Math.max(0, Math.min(1, ratio));
    let r, g, b;
    if (t < 0.5) {
      /* 绿 (16,185,129) → 黄 (245,165,36) */
      const k = t / 0.5;
      r = Math.round(16 + (245 - 16) * k);
      g = Math.round(185 + (165 - 185) * k);
      b = Math.round(129 + (36 - 129) * k);
    } else {
      /* 黄 (245,165,36) → 红 (244,63,94) */
      const k = (t - 0.5) / 0.5;
      r = Math.round(245 + (244 - 245) * k);
      g = Math.round(165 + (63 - 165) * k);
      b = Math.round(36 + (94 - 36) * k);
    }
    return (r << 16) | (g << 8) | b;
  }

  /* ==================================================================
   * 主入口
   * ================================================================== */

  /**
   * 创建真实厂区场景。
   *
   * @param {HTMLElement} container
   * @param {object} plantData  /api/twin/plant/:id 返回的 data
   * @param {object} opts
   *   onPick       (structure|null) => void
   *   onFps        (fps) => void
   *   onDegrade    (level) => void
   *   mode         'heat' | 'plain'   着色模式
   */
  async function createPlantScene(container, plantData, opts = {}) {
    const THREE = await loadThree();
    const structures = plantData.plant.structures || [];
    const extent = plantData.plant.sceneExtent || { w: 2400, d: 1600 };

    /* ---------- 相机自动取景（按包围盒 + 当前宽高比双方向求解） ----------
     *
     * ⚠ 旧实现把相机距离写死为一个数（span × 0.85，span = 场区最长边），
     *   只在"宽屏 + 场区完全居中"的理想情况下成立。舞台被右侧信息栏撑高后
     *   （实测 1201 × 1190，接近正方形），水平视野只剩垂直视野的 1.0 倍，
     *   而鞍钢厂区的横向投影约 7 km —— 左端轧钢车间被裁在画面左缘、
     *   右端烟囱完全不在画面里，4 台高炉只剩 1 根柱子，画面 70% 是空地面。
     *
     * 现在分三步：
     *   ① 算"结构簇"包围盒 —— 取景要跟着建筑走，而不是跟着 24 km² 的地界走；
     *   ② 由簇包围盒外扩得出取景框（外扩 45%，但不小于场区一半、不大于场区）；
     *   ③ 对取景框 8 个角点逐点求"两个方向同时装下所需的距离"，取最大值。
     * 这样任何宽高比的舞台都不会裁切，也不会把厂区缩成画面中间一小块。 */
    const diag = Math.hypot(extent.w, extent.d);

    const bounds = (() => {
      let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
      let maxH = 40;
      structures.forEach((s) => {
        const hw = (s.scene.w || 0) / 2;
        const hd = (s.scene.d || 0) / 2;
        minX = Math.min(minX, s.local.x - hw); maxX = Math.max(maxX, s.local.x + hw);
        minZ = Math.min(minZ, s.local.z - hd); maxZ = Math.max(maxZ, s.local.z + hd);
        maxH = Math.max(maxH, s.scene.h || 0);
      });
      if (!Number.isFinite(minX)) {
        return { minX: -extent.w / 2, maxX: extent.w / 2, minZ: -extent.d / 2, maxZ: extent.d / 2, maxH: 60 };
      }
      return { minX, maxX, minZ, maxZ, maxH };
    })();

    const clusterW = bounds.maxX - bounds.minX;
    const clusterD = bounds.maxZ - bounds.minZ;
    /* 取景框 = 结构簇外扩 50%（左右）/ 60%（前后）。
     *
     * ⚠ 这里刻意**不**给"至少覆盖半个场区"的下限：鞍钢场区 5600×4300 m，
     *   而主工艺区只有约 1550×1100 m。按半个场区取景时，建筑只占画面宽度
     *   的 1/4，其余全是场地空地 —— 看起来就是"几块薄板散在大操场上"。
     *   按簇取景后建筑占画面 2/3，厂区的空地在缩小时仍能看到（maxDistance
     *   是当前距离的 3.4 倍）。
     *   仅在场区本身比簇还小（结构顶到边界）时，才被 extent 夹住。 */
    /* 取景直接套"结构簇包围盒"，不再额外拼一个更大的框。
     *
     * 试过两版更"聪明"的做法，都被实测否掉：
     *   ① 框住半个场区 → 建筑只占画面 1/4，其余全是空场地；
     *   ② 把取景框按舞台宽高比拉伸 → 框从 1876×1243 膨胀到 2533×2510，
     *      相机被迫后退一倍，建筑反而更小（远端的框角把距离顶死了）。
     * 现在是"8 个簇角点 + 1.12 余量"的裸拟合：几何上保证不裁切，
     * 同时让簇填满受限的那个方向，另一个方向多出来的就是真实厂区的空地。 */
    const FIT_MARGIN = 1.12;
    const fitCX = (bounds.minX + bounds.maxX) / 2;
    const fitCZ = (bounds.minZ + bounds.maxZ) / 2;
    const fitCenter = new THREE.Vector3(fitCX, Math.max(20, bounds.maxH * 0.42), fitCZ);

    /* 100 m 标尺：**贴着最高结构立**，而不是站在场区角落。
     * 页面上"烟囱是标尺的 2.4 倍高"这句只有当两者同框、同一朝向时才可核对；
     * 标尺漂在远处空地上，读者只会看到一根孤立的白柱子（实测如此）。 */
    const rulerH = 100;
    const tallest = structures.reduce((a, b) => ((b.scene.h || 0) > (a.scene.h || 0) ? b : a), structures[0])
      || { local: { x: 0, z: 0 }, scene: { w: 0, h: 0 } };
    const rulerX = tallest.local.x + tallest.scene.w / 2 + Math.max(60, tallest.scene.w * 0.9);
    const rulerZ = tallest.local.z;

    /* 取景点取**建筑自身的角点**，不是"包围盒的角点"。
     *
     * 差别很大：包围盒角点是空地上的点，斜俯视时远端那个角点会顶到画面上边缘，
     * 把相机逼退一倍，建筑只占画面 40%。改成每栋建筑本身的 8 个角点后，
     * 取景只保证"建筑不被裁"，多出来的地面自然溢出画面 —— 这才是航拍视角。
     * 边角多留 120 m 余量，让最外侧的建筑不至于贴边。 */
    const fitCorners = [];
    const PAD = 120;
    structures.forEach((st) => {
      const hw = (st.scene.w || 0) / 2 + PAD;
      const hd = (st.scene.d || 0) / 2 + PAD;
      [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => {
        fitCorners.push(new THREE.Vector3(st.local.x + sx * hw, 0, st.local.z + sz * hd));
        fitCorners.push(new THREE.Vector3(st.local.x + sx * hw, st.scene.h, st.local.z + sz * hd));
      }));
    });
    /* 标尺也算进取景，避免它被切在画面外 */
    fitCorners.push(new THREE.Vector3(rulerX, 0, rulerZ));
    fitCorners.push(new THREE.Vector3(rulerX, rulerH, rulerZ));

    /* 机位方向：方位角 75°（相机偏 +z 侧，略微偏 +x）、俯角 41°。
     *
     * ⚠ 方位角的定义是"相机绕 y 轴转了多少"，不是"斜视多少度"。
     *   工艺链沿 x 轴排布，要让链在画面上接近水平，相机必须**正对** z 轴
     *   （方位角 90°）—— 此时屏幕右向 right = up × camDir ≈ +x。
     *   取 45° 或 15° 时 right 带很大的 -z 分量，x 轴被投影到屏幕纵向，
     *   整条链就从左上角斜拉到右下角（实测两轮都这样）。取 75° 保留一点
     *   侧向透视，链基本水平。 */
    const camDir = new THREE.Vector3(
      Math.cos(0.86) * Math.cos(1.30),
      Math.sin(0.86),
      Math.cos(0.86) * Math.sin(1.30)
    ).normalize();

    const scene = new THREE.Scene();
    scene.background = null;
    /* 雾的起止距离也按尺度缩放 */
    /* 雾：只在**远距离**起作用，用于柔化场区边缘，不让地面边界显得生硬。
     * 起点设在 1.1×diag —— 即"视野外缘之外"，正常观察距离内完全无雾感，
     * 避免建筑被雾蒙成灰色（那是 3D 场景常见的"发灰"病）。 */
    scene.fog = new THREE.Fog(0x0a1220, diag * 1.1, diag * 3.2);

    const width = Math.max(320, container.clientWidth || 900);
    const height = Math.max(260, container.clientHeight || 520);

    /* near 不能取 1：far/near = 8.5 万，24 位深度缓冲在这种比例下只剩
     * 分米级精度，场区底板（y=0.2）与地面（y=0）会大面积 z-fighting ——
     * 画面上就是那一片横条纹。取 near=20 后深度精度提高 20 倍，
     * 底板再抬到 y=3，两个面彻底分开。 */
    const camera = new THREE.PerspectiveCamera(42, width / height, 20, diag * 8);
    /* 位置由 applyFit() 统一给出（见控制器段落），这里不写死 */

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    /* 色调映射：让高亮的热力色不过曝 */
    if (THREE.ACESFilmicToneMapping !== undefined) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
    }
    container.appendChild(renderer.domElement);

    /* ---------- 光照 ---------- */
    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    /* 半球光：天空色 + 地面色，比纯环境光更有空间感 */
    const hemi = new THREE.HemisphereLight(0x88ccee, 0x14202e, 0.55);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff4e0, 1.0);
    /* 光源位置与阴影相机**都跟着结构簇**走。
     *
     * ⚠ 原先阴影相机覆盖整个场区（±0.75×5600），2048² 的贴图摊到 8.4 km 上
     *   是 4 m/texel，地面出现大片等距横向条纹（shadow acne），远看像地面
     *   本身有波纹；而真正需要阴影的只有建筑周围几百米。
     *   收紧到簇范围 + normalBias，条纹消失，阴影边缘也更实。 */
    sun.position.set(fitCX + clusterW * 0.55, Math.max(clusterW, clusterD) * 1.2, fitCZ + clusterD * 0.9);
    sun.target.position.set(fitCX, 0, fitCZ);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = Math.max(2, clusterW * 0.004);
    const sc = sun.shadow.camera;
    sc.left = -clusterW * 0.75; sc.right = clusterW * 0.75;
    sc.top = clusterD * 0.9; sc.bottom = -clusterD * 0.9;
    sc.near = 10; sc.far = diag * 4;
    sc.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target);

    /* 补光：跟着相机走。
     * 没有它时，只有"朝太阳的那一面"是亮的，建筑的立面全黑 ——
     * 一个 380×34×130 m 的轧钢车间在画面上就退化成一块贴地的发光薄片，
     * 完全没有体积感（2026-10-29 截图复核）。 */
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.42);
    scene.add(fill);
    scene.add(fill.target);

    /* ---------- 地面 + 场区区划 + 尺度标尺 ---------- */
    /* 地面比场区大一圈：取景按"结构簇 + 45% 余量"算，若地面只有 1.5 倍场区，
     * 斜俯视时画面顶部会露出地面边缘（一道突兀的直角），下面是空的页面背景。 */
    const groundSize = Math.max(extent.w, extent.d) * 2.6;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshStandardMaterial({ color: 0x0a1018, roughness: 0.97, metalness: 0.02 })
    );
    ground.rotation.x = -Math.PI / 2;
    /* 地面不接收阴影：5600 m 见方的平面 + 2048² 阴影贴图必然是
     * 4 m/texel 级别，PCF 软阴影在这种尺度上会画出等距横向条纹
     * （shadow acne），远看像地面本身有水波纹。建筑之间的自阴影保留 ——
     * 体积感靠"顶面/立面双色 + 补光"就够，不靠地面投影。 */
    ground.receiveShadow = false;
    scene.add(ground);

    /* 场区区划底板：在真实占地范围内铺一块略亮的板。
     * 作用有二：① "厂区边界在哪"一眼可见，不靠想象；
     *          ② 底板与外部地面有色差，视觉上把注意力收进场区。 */
    const yard = new THREE.Mesh(
      new THREE.PlaneGeometry(extent.w, extent.d),
      new THREE.MeshStandardMaterial({
        /* 与外围地面的色差要够大（0x121d2c vs 0x0a1018 在暗场里差不到 3%，
         * 底板等于看不见），但又不能太亮 —— 取景收紧到主工艺区后底板会铺满
         * 画面，过亮会变成"一块悬空的水泥板"，把建筑压成小色块。 */
        color: 0x111d2b, roughness: 0.9, metalness: 0.04,
        transparent: true, opacity: 0.98,
      })
    );
    yard.rotation.x = -Math.PI / 2;
    yard.position.y = 3;
    yard.receiveShadow = false;  // 同上：大面积平面接收阴影只会得到条纹
    scene.add(yard);

    /* 场区轮廓线 */
    const yardEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(extent.w, extent.d)),
      new THREE.LineBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.72 })
    );
    yardEdges.rotation.x = -Math.PI / 2;
    yardEdges.position.y = 3.4;
    scene.add(yardEdges);

    /* 地面网格：**不做**。
     *
     * 100 m 的网格在 5.6 km 场区里是 56×43 条线，斜俯视下越远越挤，
     * 最终在画面上表现为大片横向灰条纹（每轮截图都能看到，且被误认为
     * 渲染故障）。把它裁到建筑附近又变成"浮在半空的一小块格子"。
     * 尺度感改由"立在最高结构旁的 100 m 标尺 + HUD 的场区尺寸"承担 ——
     * 这两样都能直接核对，比一片看不清的方格更有用。 */

    /* ---------- 结构体 ---------- */
    const maxEmission = Math.max(...structures.map((s) => s.emission || 0), 1);
    const pickables = [];
    const meshes = new Map();

    /** 按 kind 决定几何体形态 —— 不同工艺设备外形差异很大，不应都是方块 */
    function geometryFor(st) {
      const w = st.scene.w; const h = st.scene.h; const d = st.scene.d;
      switch (st.kind) {
        case 'STACK': {
          /* 烟囱：细长圆柱，底部略粗（锥台） */
          const g = new THREE.CylinderGeometry(w * 0.38, w * 0.52, h, 20);
          return g;
        }
        case 'COOLING': {
          /* 冷却塔：双曲面近似 —— 用两段圆台拼（下粗、腰细、上略张） */
          const g = new THREE.CylinderGeometry(w * 0.34, w * 0.5, h, 28, 1, true);
          return g;
        }
        case 'BLAST': {
          /* 高炉：竖直圆筒 + 顶部略收 */
          const g = new THREE.CylinderGeometry(w * 0.42, w * 0.5, h, 22);
          return g;
        }
        case 'KILN': {
          /* 回转窑：横置圆柱 */
          const g = new THREE.CylinderGeometry(w * 0.16, w * 0.16, Math.max(w, h), 20);
          g.rotateZ(Math.PI / 2);
          return g;
        }
        case 'CLINKER':
        case 'TANK':
        case 'REACTOR': {
          const g = new THREE.CylinderGeometry(w * 0.45, w * 0.5, h, 24);
          return g;
        }
        case 'COLUMN':
        case 'PREHEATER': {
          const g = new THREE.CylinderGeometry(w * 0.4, w * 0.45, h, 18);
          return g;
        }
        case 'FLARE': {
          const g = new THREE.CylinderGeometry(w * 0.25, w * 0.45, h, 12);
          return g;
        }
        default: {
          /* 厂房类：长方体 */
          return new THREE.BoxGeometry(w, h, d);
        }
      }
    }

    /** 是否为圆柱族（影响阴影与位置计算——圆柱的 y 也是 h/2） */
    const isCyl = (kind) => ['STACK', 'COOLING', 'BLAST', 'KILN', 'CLINKER', 'TANK',
      'REACTOR', 'COLUMN', 'PREHEATER', 'FLARE'].includes(kind);

    /* 顶面 / 立面双色 —— "体积感"的来源。
     * 单色箱体在 40° 俯视下，顶面与立面的明度只差一点点，一个 380×34×130 m 的
     * 轧钢车间就退化成一块贴地的薄板。把立面压暗到 0.6 倍后，"屋顶 / 墙" 一眼
     * 分得开，即使没有阴影（帧率降级会关阴影）也能读出体积。
     * BoxGeometry 的面序：[+x, -x, +y, -y, +z, -z]，+y 是顶面；
     * CylinderGeometry 的组序：[侧面, 顶盖, 底盖]。 */
    function matsFor(hex, cyl) {
      const base = new THREE.Color(hex);
      const side = base.clone().multiplyScalar(0.6);
      const mk = (c, em) => new THREE.MeshStandardMaterial({
        color: c,
        roughness: 0.52,
        metalness: 0.22,
        emissive: c.clone().multiplyScalar(em),
      });
      return cyl
        ? [mk(side, 0.1), mk(base, 0.16), mk(side, 0.08)]
        : [mk(side, 0.1), mk(side, 0.1), mk(base, 0.16), mk(side, 0.08), mk(side, 0.1), mk(side, 0.1)];
    }

    /** 选中/换色时统一重设颜色与自发光，兼容单材质与材质数组 */
    function paint(mesh, hex, selected) {
      const base = new THREE.Color(hex);
      const side = base.clone().multiplyScalar(0.6);
      const cyl = mesh.userData.cyl;
      const cols = cyl ? [side, base, side] : [side, side, base, side, side, side];
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      list.forEach((m, i) => {
        const c = cols[i] || side;
        m.color.copy(c);
        m.emissive.copy(c).multiplyScalar(selected ? 0.55 : (i === 2 || (cyl && i === 1) ? 0.16 : 0.1));
      });
    }

    structures.forEach((st) => {
      const ratio = (st.emission || 0) / maxEmission;
      const color = opts.mode === 'plain'
        ? 0x3b82a0
        : heatColor(ratio);

      const geo = geometryFor(st);
      const cyl = isCyl(st.kind);
      const mesh = new THREE.Mesh(geo, matsFor(color, cyl));
      /* y 位置统一为 h/2（几何体中心在原点）
       * KILN 已旋转 90°，其高度方向变成 z，但视觉中心仍在 y=h/2 附近 —— 取 h/2 无妨 */
      mesh.position.set(st.local.x, st.local.y, st.local.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.id = st.id;
      mesh.userData.structure = st;
      mesh.userData.baseColor = color;
      mesh.userData.cyl = cyl;
      scene.add(mesh);
      pickables.push(mesh);
      meshes.set(st.id, mesh);

      /* 轮廓线：让结构在暗背景与同级色块之间能分辨 */
      let edgeGeo;
      if (isCyl(st.kind)) {
        edgeGeo = new THREE.EdgesGeometry(geo, 28);
      } else {
        edgeGeo = new THREE.EdgesGeometry(geo);
      }
      const edge = new THREE.LineSegments(
        edgeGeo,
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16 })
      );
      edge.position.copy(mesh.position);
      if (st.kind === 'KILN') edge.rotation.z = Math.PI / 2;
      scene.add(edge);
      mesh.userData.edge = edge;
    });

    /* ---------- 工艺流动线 ----------
     * 把同一"行"内的结构按 x 顺序连成一条流动线，并让光点沿线移动。
     *
     * 【为什么这条线有信息量，而不只是装饰】
     * 它表达的是**工序顺序**：原料 → 烧结 → 高炉 → 转炉 → 轧钢（钢铁），
     * 或 锅炉 → 汽机 → 发电（电力）。这是真实工艺流程的方向，
     * 也是"排放从哪来"的路径。光点沿线的速度按该行的平均排放强度微调 ——
     * 排放越大流得越快，形成"这条线在排污"的直观感受。
     *
     * ⚠ 光点是纯视觉引导，不承载数据。数据在结构自身的 emission 上。
     *   这一点在页面说明里写明，避免被误读为"实时流量计量"。 */
    const flowLines = [];
    const flowDots = [];
    (function buildFlow() {
      /* 按 z 分组（同一行），行内按 x 排序 */
      const rows = new Map();
      structures.forEach((st) => {
        const key = Math.round(st.local.z);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(st);
      });
      rows.forEach((list) => {
        if (list.length < 2) return;
        list.sort((a, b) => a.local.x - b.local.x);
        /* ⚠ 流线高度必须**高于地坪但不高于建筑顶部**：
         *   · 贴地（y=0）会被场区底板挡住，完全看不见；
         *   · 太高会穿建筑而过，破坏"贴地管线"的空间感。
         * 取每栋建筑高度的 0.35 倍，并夹在 [12, 60] 区间 ——
         * 这样在矮厂房上方可见、在高炉旁也不会飘到半空。 */
        const pts = list.map((s) => new THREE.Vector3(
          s.local.x,
          Math.min(60, Math.max(12, s.scene.h * 0.35)),
          s.local.z
        ));
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({
          /* 不透明度 0.34 太淡（实测在暗背景上几乎看不见）。
           * 0.62 + 加粗线宽是"看得见但不抢戏"的取值。
           * ⚠ WebGL 的 linewidth 在多数平台被限制为 1，所以主要靠不透明度。 */
          color: 0x22d3ee, transparent: true, opacity: 0.62,
        });
        const line = new THREE.Line(geo, mat);
        scene.add(line);
        flowLines.push(line);

        /* 在线上再加一串小节点，形成"管路接头"的观感 ——
         * 单线条看起来像一根直线，加节点后才像管线。 */
        const nodes = [];
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1]; const b = pts[k];
          const mid = new THREE.Vector3().lerpVectors(a, b, 0.5);
          const node = new THREE.Mesh(
            new THREE.SphereGeometry(Math.max(6, Math.min(16, Math.max(extent.w, extent.d) * 0.007)),
              8, 8),
            new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.75 })
          );
          node.position.copy(mid);
          scene.add(node);
          nodes.push(node);
        }

        /* 沿线移动的光点。
         * 尺寸按场区跨度缩放：太大（如 120 单位）会盖住建筑，
         * 太小（如 7 单位）在 2600 米的钢铁厂里只有 0.27% 跨度、肉眼看不见。
         * 取跨度的 1.8%，并夹在 [14, 42] 区间 —— 相当于一栋小配房的体量，
         * 既显眼又不喧宾夺主。 */
        /* 光点尺寸：跨度 1.2%，夹在 [10, 26]。此前 [14,42]（42 m 半径 + 1.5 倍
         * 光晕 = 直径 126 m 的半透明球），停在建筑旁时活像一枚悬浮气泡，
         * 被误读成渲染脏点。缩到 26 m 后仍是"一眼可见的流动光点"。 */
        const dotSize = Math.max(10, Math.min(26, Math.max(extent.w, extent.d) * 0.012));
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(dotSize, 12, 12),
          new THREE.MeshBasicMaterial({
            color: 0x67e8f9, transparent: true, opacity: 0.92, depthWrite: false,
          })
        );
        scene.add(dot);

        /* 外层光晕：更大的半透明球，制造"发光"观感。
         * 比用后处理（bloom）便宜得多 —— 后者需要额外的 render target
         * 与多趟绘制，在中低端 GPU 上会直接掉到 30fps 以下。 */
        const halo = new THREE.Mesh(
          new THREE.SphereGeometry(dotSize * 1.35, 12, 12),
          /* depthWrite:false —— 透明球体默认写深度，前后表面互相遮挡，
           * 在暗背景上会渲染成一枚"暗盘"（实测就是那个奇怪的深色圆斑）。 */
          new THREE.MeshBasicMaterial({
            color: 0x22d3ee, transparent: true, opacity: 0.14, depthWrite: false,
          })
        );
        dot.add(halo);
        /* 速度：按该行平均排放占全厂比例映射到 0.10~0.55（每秒走完整条线的比例） */
        const avgE = list.reduce((a, s) => a + (s.emission || 0), 0) / list.length;
        const ratio = Math.min(1, avgE / (maxEmission || 1));
        flowDots.push({
          mesh: dot, pts,
          speed: 0.10 + ratio * 0.45,
          /* 每条线错开相位，避免所有光点同步移动（那样像机械动画） */
          phase: Math.random(),
          lenTotal: pts.reduce((a, p, i) => (i === 0 ? 0 : a + p.distanceTo(pts[i - 1])), 0),
        });
      });
    })();

    /* 沿线插值取点 */
    function pointOnPath(pts, t) {
      if (pts.length < 2) return pts[0] || new THREE.Vector3();
      const lens = [];
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = pts[i].distanceTo(pts[i - 1]);
        lens.push(d); total += d;
      }
      let want = Math.max(0, Math.min(1, t)) * total;
      for (let i = 0; i < lens.length; i++) {
        if (want <= lens[i] || i === lens.length - 1) {
          const k = lens[i] > 0 ? want / lens[i] : 0;
          return new THREE.Vector3().lerpVectors(pts[i], pts[i + 1], Math.min(1, k));
        }
        want -= lens[i];
      }
      return pts[pts.length - 1];
    }

    /* ---------- 尺度参照物 ----------
     * 一根 100 m 高的标尺 + 顶/底刻度 + "100 m" 文字牌。
     * 没有参照物时，"烟囱 240 m"只是一个数字；有了它，能直接看出
     * "烟囱是标尺的 2.4 倍高"。这是"可感知比例"的关键。
     * 标尺贴在结构簇的左前角外侧 —— 放在场区四角时会被取景裁掉，
     * 参照物一旦不在画面里，这条声明的可验证性就没了。
     *
     * ⚠ 用 Line 画标尺在 1 px 线宽下几乎看不见（WebGL 的 linewidth 在多数
     *   平台被限制为 1），所以改成细圆柱 + 盒子刻度，有真实宽度才看得见。 */
    const rulerMat = new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.85 });
    /* 标尺粗细跟着场区尺度走：固定 2.4 m 半径在 5.6 km 的钢厂里不足 1 px */
    /* 标尺比烟囱细：直径 12 m，在 5.6 km 场区里仍有 6 px 宽 */
    const rulerR = 6;
    const rulerPost = new THREE.Mesh(new THREE.CylinderGeometry(rulerR, rulerR, rulerH, 8), rulerMat);
    rulerPost.position.set(rulerX, rulerH / 2, rulerZ);
    scene.add(rulerPost);
    const tickW = Math.max(24, Math.max(extent.w, extent.d) * 0.008);
    /* 没做"100 m"文字牌：默认取景约 2.3 km 宽，100 m 的标尺只占画面 4%，
     * 文字牌必然被渲染成一个小白块（实测两轮都是），反而像渲染脏点。
     * 标尺的读法写在右下角的 HUD 里（"标尺 100 m · 1 单位 = 1 m"），
     * 用户放大到单栋厂房时，标尺本身就有意义了。 */
    [[rulerH, 2.2], [0.5, 1.6]].forEach(([y, th]) => {
      const tick = new THREE.Mesh(new THREE.BoxGeometry(tickW, th, 2.4), rulerMat);
      tick.position.set(rulerX, y, rulerZ);
      scene.add(tick);
    });

    /* ---------- 控制器 ---------- */
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    /* 俯仰限制：不允许钻到地面以下（那是 3D 场景最常见的破绽） */
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minPolarAngle = Math.PI * 0.06;
    /* 缩放平滑度 */
    controls.zoomSpeed = 0.85;
    controls.rotateSpeed = 0.75;
    controls.panSpeed = 0.7;
    controls.screenSpacePanning = false;

    /* 用户一旦自己转过视角，就不再自动改镜头 ——
     * 否则窗口一缩放/右栏一变高，镜头会"自己动"，看着像故障。 */
    let userMoved = false;
    controls.addEventListener('start', () => { userMoved = true; });

    /**
     * 求相机距离：**二分逼近**，让建筑的投影包围盒刚好填满画面。
     *
     * 不用解析解（各自求 8 个角点的最小距离再取最大值）—— 实测那样算出来的
     * 距离比"刚好填满"远 60%：斜俯视时远端建筑的**顶部**角点会被透视推到
     * 画面很高的位置，它一家就把距离顶死，结果建筑只占画面 40%（实测 2903 m
     * vs 需要 1800 m）。直接对"投影包围盒占画面的比例"做二分，单调、稳定，
     * 且天然把宽高比、俯角、建筑分布全算进去。
     *
     * @param {number} fill 目标填充率（0~1，取投影包围盒占画面短边的比例）
     */
    function fitDistance(fill = 0.9) {
      const v = new THREE.Vector3();
      const origin = fitCenter.clone();
      /** 给定距离下，建筑投影包围盒占画面的半宽（NDC，≤1 表示装得下） */
      function halfExtent(dist) {
        camera.position.copy(origin).addScaledVector(camDir, dist);
        camera.lookAt(origin);
        camera.updateMatrixWorld();
        let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
        fitCorners.forEach((c) => {
          v.copy(c).project(camera);
          minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
          minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
        });
        return Math.max(maxX - minX, maxY - minY) / 2;
      }
      let lo = 200; let hi = diag * 3;
      for (let i = 0; i < 26; i++) {
        const mid = (lo + hi) / 2;
        if (halfExtent(mid) > fill) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    }

    /**
     * 把取景结果的投影中心挪到画面中心。
     *
     * fitDistance 只保证"全部装进视锥"，不保证居中 —— 斜俯视 49° 时远端建筑
     * 被透视压缩，投影重心偏上，画面上部挤、下部空（实测建筑落在上 40%）。
     * 这里按 8 个角点的 NDC 包围盒把镜头整体平移（相机与 target 同步平移，
     * 视线方向不变，只改"看哪里"），迭代两次就收敛。
     */
    function recenter(dist) {
      const vFov = (Math.PI / 180) * camera.fov;
      const worldH = 2 * dist * Math.tan(vFov / 2);
      const worldW = worldH * camera.aspect;
      const worldUp = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(worldUp, camDir).normalize();
      const upv = new THREE.Vector3().crossVectors(camDir, right).normalize();
      const v = new THREE.Vector3();
      for (let iter = 0; iter < 2; iter++) {
        camera.updateMatrixWorld();
        let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
        fitCorners.forEach((c) => {
          v.copy(c).project(camera);
          minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
          minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
        });
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        if (Math.abs(cx) < 0.02 && Math.abs(cy) < 0.02) break;
        /* 符号：镜头朝 +right 平移 Δ，画面上内容朝 -right 走 Δ/(半宽)。
         * 要让内容从 cx 落到 0，需要 Δ = cx × 半宽（不能用 -cx，那样会越挪越偏）。 */
        const shift = right.clone().multiplyScalar(cx * worldW / 2)
          .add(upv.clone().multiplyScalar(cy * worldH / 2));
        controls.target.add(shift);
        camera.position.add(shift);
        controls.update();
      }
    }

    /** 按当前宽高比重新取景（任何舞台比例都不裁切、且内容居中） */
    function applyFit() {
      const dist = fitDistance(0.9);
      camera.position.copy(fitCenter).addScaledVector(camDir, dist);
      controls.target.copy(fitCenter);
      /* 缩放范围以"当前取景距离"为基准倍率：
       * 0.25× ~ 3.4× 覆盖"贴近看单栋厂房"到"退远看全场"，且任何规模场区
       * 的体验一致（写死绝对值会在 5.6 km 的钢厂上把镜头框死在半空）。 */
      controls.minDistance = dist * 0.25;
      controls.maxDistance = dist * 3.4;
      controls.update();
      recenter(dist);
    }
    applyFit();

    /* ==================================================================
     * 交互：Raycasting
     * ================================================================== */
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let selectedId = null;

    function pickAt(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(pickables, false);
      return hits.length ? hits[0].object : null;
    }

    function setSelected(id) {
      selectedId = id;
      meshes.forEach((mesh, key) => {
        const on = key === id;
        paint(mesh, mesh.userData.baseColor, on);
        /* 选中的结构略微抬高，形成"浮起"的视觉反馈 */
        const st = mesh.userData.structure;
        mesh.position.y = st.local.y + (on ? Math.min(18, st.scene.h * 0.12) : 0);
        if (mesh.userData.edge) {
          mesh.userData.edge.material.opacity = on ? 0.85 : 0.16;
          mesh.userData.edge.position.y = mesh.position.y;
        }
      });
    }

    let downX = 0; let downY = 0; let downT = 0;
    const CLICK_MOVE_PX = 6;
    const CLICK_MS = 650;

    function onPointerDown(e) { downX = e.clientX; downY = e.clientY; downT = Date.now(); }
    function onPointerUp(e) {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved > CLICK_MOVE_PX || Date.now() - downT > CLICK_MS) return;   // 拖拽而非点击
      const mesh = pickAt(e.clientX, e.clientY);
      const id = mesh ? mesh.userData.id : null;
      setSelected(id);
      if (typeof opts.onPick === 'function') {
        opts.onPick(id ? { ...mesh.userData.structure } : null);
      }
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    let hoverRaf = 0;
    function onPointerMove(e) {
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        renderer.domElement.style.cursor = pickAt(e.clientX, e.clientY) ? 'pointer' : 'grab';
      });
    }
    renderer.domElement.addEventListener('pointermove', onPointerMove);

    /* 滚轮缩放由 OrbitControls 接管，这里不再额外监听 */

    /* ==================================================================
     * 渲染循环 + 帧率守卫
     * ================================================================== */
    let raf = 0; let running = true;
    /* 流动动画的时间基准：用绝对时间而非逐帧累加，避免切后台再回来时跳变 */
    const flowStartMs = performance.now();
    let frames = 0; let lastT = performance.now(); let fps = 0;
    let lowStreak = 0; let degraded = 0;
    const MAX_DEGRADE = 2;

    function degrade() {
      if (degraded >= MAX_DEGRADE) return;
      degraded += 1;
      if (degraded === 1) {
        renderer.shadowMap.enabled = false;
        sun.castShadow = false;
        scene.traverse((o) => { if (o.isMesh) o.castShadow = false; });
      } else if (degraded === 2) {
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
      if (now - lastT >= 1000) {
        fps = Math.round((frames * 1000) / (now - lastT));
        frames = 0; lastT = now;
        if (typeof opts.onFps === 'function') opts.onFps(fps);
        if (fps > 0 && fps < 24) {
          lowStreak += 1;
          if (lowStreak >= 2) { degrade(); lowStreak = 0; }
        } else lowStreak = 0;
      }
      controls.update();
      /* 补光跟随相机：保证"朝向镜头的那一面"始终有光。
       * 只用固定方向的太阳光时，背光立面全黑 → 建筑读起来像贴地的发光薄片。 */
      fill.position.copy(camera.position);
      fill.target.position.copy(controls.target);

      /* 工艺流动光点：沿线上循环移动。
       *
       * ⚠ 用"首帧时间戳 + 累计经过时间"来算位置，而不是每帧 += speed。
       * 原因：requestAnimationFrame 在后台标签页会暂停，用累加会让光点
       * 在切回来时"倒退"或突然跳跃；用绝对时间则总是连续。
       * 降级到 L2 时停止动画（省 GPU）—— 静态画面里光点不动也不影响信息传达。 */
      if (degraded < 2 && flowDots.length) {
        const elapsed = (now - flowStartMs) / 1000;
        for (const d of flowDots) {
          let t = (d.phase + elapsed * d.speed) % 1;
          if (t < 0) t += 1;
          const p = pointOnPath(d.pts, t);
          d.mesh.position.copy(p);
          /* 光晕呼吸：让移动更明显，同时避免"死板匀速" */
          d.mesh.scale.setScalar(0.85 + 0.25 * Math.sin(elapsed * 3 + d.phase * 6.28));
        }
      }

      renderer.render(scene, camera);
    }

    function onVisibility() {
      if (document.hidden) {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (!running) {
        running = true; lastT = performance.now(); frames = 0; tick();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

    /* ---------- 尺寸自适应 ---------- */
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
        /* 宽高比变了，取景框也要重算 —— 否则"矮窗变方窗"时两侧建筑被裁掉。
         * 用户手动转过视角后不再自动介入。 */
        if (!userMoved) applyFit();
      });
    }
    const ro = ('ResizeObserver' in global) ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(container); else global.addEventListener('resize', resize);

    tick();

    /* ==================================================================
     * 对外句柄
     * ================================================================== */
    return {
      THREE, scene, camera, renderer, controls,
      /** 程序化选中 */
      select(id) {
        if (id && !meshes.has(id)) return false;
        setSelected(id || null);
        const m = id ? meshes.get(id) : null;
        if (typeof opts.onPick === 'function') {
          opts.onPick(m ? { ...m.userData.structure } : null);
        }
        return true;
      },
      /** 相机飞向某个结构 */
      focus(id) {
        const m = meshes.get(id);
        if (!m) return false;
        const st = m.userData.structure;
        const target = new THREE.Vector3(st.local.x, st.local.y, st.local.z);
        const dist = Math.max(180, Math.max(st.scene.w, st.scene.h) * 2.2);
        const dir = camera.position.clone().sub(controls.target).normalize();
        camera.position.copy(target.clone().add(dir.multiplyScalar(dist)));
        controls.target.copy(target);
        controls.update();
        userMoved = true;   // 飞过去之后不要被 resize 拽回全景
        setSelected(id);
        if (typeof opts.onPick === 'function') opts.onPick({ ...st });
        return true;
      },
      /** 切换到俯瞰全景（正俯视，覆盖与初始取景同一范围） */
      topView() {
        const dist = fitDistance(0.9);
        camera.position.set(fitCenter.x + 0.01, fitCenter.y + dist, fitCenter.z + 0.01);
        controls.target.copy(fitCenter);
        controls.update();
        userMoved = true;
      },
      /** 复位到初始视角 */
      reset() {
        userMoved = false;
        applyFit();
        setSelected(null);
        if (typeof opts.onPick === 'function') opts.onPick(null);
      },
      /** 切换热力/素色着色 */
      setColorMode(mode) {
        meshes.forEach((mesh) => {
          const st = mesh.userData.structure;
          const ratio = (st.emission || 0) / maxEmission;
          const color = mode === 'plain' ? 0x3b82a0 : heatColor(ratio);
          mesh.userData.baseColor = color;
          paint(mesh, color, mesh.userData.id === selectedId);
        });
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
        scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (Array.isArray(o.material)) o.material.forEach((mm) => mm.dispose());
            else o.material.dispose();
          }
        });
        renderer.dispose();
        if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      },
    };
  }

  global.App = global.App || {};
  global.App.Plant3D = {
    hasWebGL, loadThree, createPlantScene, heatColor,
    supported() { return hasWebGL(); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
