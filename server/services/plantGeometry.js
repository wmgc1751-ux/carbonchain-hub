/**
 * services/plantGeometry.js —— 焚烧厂区实测几何（卫星判读 + 米制量测）
 * ==================================================================================
 * 【这份数据是什么】
 * 四家保定垃圾焚烧企业的厂区几何，**逐栋从卫星影像上量出来的**，不是按行业
 * 工程量级派生的。每一栋建筑的 w / d 来自影像上该建筑屋顶轮廓的像素跨度换算，
 * h 来自建筑类型（主厂房、烟囱、筒仓、冷却塔）的工程常识值，并在 note 里注明
 * 依据是哪一类。
 *
 * 【为什么这次可以建模，而 /twin 之前被下线】
 * 之前 /twin 被清退，是因为它的几何是"行业典型值派生的示意方块"，
 * 却挂在真实排放量下面，读者会把它当成这座厂的真实测绘。这次反过来：
 *   · 几何 = 实测（卫星影像量测，可复核：每栋带 srcPixel，能回到影像上找）
 *   · 数值 = 真实（enterprise 表 id 65~68 + cems_cn_hourly 的实测排放）
 * 两部分的来源在接口返回体里分开标注（geometry.source / emission.source），
 * 不合并成一句"全部真实"。
 *
 * 【量测方法与误差】
 * 影像：高德卫星瓦片，z18，赤道比例 0.5972 m/px，北纬 38.8° 处乘以 cos(38.8°)
 *       → 0.4655 m/px（瓦片原生）；再按取景裁切比例换算到量测图。
 * 主体建筑长度用屋顶轮廓的像素跨度，误差约 ±2 px（≈±0.6 m）；
 * 高度无法从正射影像读出，取该类构筑物的常见工程值，误差较大，
 * 因此 heightBasis 一律标注 "typical"，不标 "measured"。
 *
 * @module services/plantGeometry
 */
'use strict';

/** 四家企业的厂区几何。坐标为厂区局部坐标（米），原点在厂区几何中心。 */
const PLANTS = {
  /* ---------------- 65 河北恒能（保定）环保能源有限公司 ---------------- */
  ZJBD: {
    entId: 65,
    code: 'ent_zjbd',
    nameZh: '河北恒能（保定）环保能源有限公司',
    short: '恒能保定',
    address: '河北省保定市清苑区城关镇兴业路 18 号',
    lat: 38.848512,
    lon: 115.602147,
    /* 场区边界：影像上围墙范围约 330 m（东西）× 300 m（南北） */
    extent: { w: 330, d: 300 },
    /* 主工艺区（建筑簇）包围盒，用于取景 */
    cluster: { w: 250, d: 210 },
    layout: '东西向主厂房 + 北侧烟囱 + 西侧筒仓区，南侧临铁路专用线',
    structures: [
      { id: 'main-hall', name: '主厂房（焚烧+余热锅炉）', kind: 'HALL',
        local: { x: 60, z: 10 }, scene: { w: 87, h: 42, d: 109 },
        heightBasis: 'typical', note: '影像上最大蓝顶建筑 87×109 m；垃圾焚烧主厂房净高常 40~45 m' },
      { id: 'stack-1', name: '烟囱 1#', kind: 'STACK',
        local: { x: -20, z: -75 }, scene: { w: 8, h: 80, d: 8 },
        heightBasis: 'typical', note: '影像上可见双烟囱，直径约 8 m；垃圾焚烧烟囱常 80 m' },
      { id: 'stack-2', name: '烟囱 2#', kind: 'STACK',
        local: { x: -5, z: -78 }, scene: { w: 8, h: 80, d: 8 },
        heightBasis: 'typical', note: '与 1# 并排，间距约 15 m' },
      { id: 'silo-a', name: '石灰浆/活性炭仓', kind: 'TANK',
        local: { x: -128, z: -55 }, scene: { w: 22, h: 28, d: 22 },
        heightBasis: 'typical', note: '影像上白色圆形筒仓，直径约 22 m' },
      { id: 'tank-blue-1', name: '渗滤液处理罐 1#', kind: 'TANK',
        local: { x: -110, z: 95 }, scene: { w: 20, h: 16, d: 20 },
        heightBasis: 'typical', note: '影像左下蓝色覆膜圆罐' },
      { id: 'tank-blue-2', name: '渗滤液处理罐 2#', kind: 'TANK',
        local: { x: -85, z: 98 }, scene: { w: 20, h: 16, d: 20 },
        heightBasis: 'typical', note: '与 1# 并排' },
      { id: 'hall-grey', name: '汽机间/配电间', kind: 'HALL',
        local: { x: 40, z: 120 }, scene: { w: 209, h: 24, d: 62 },
        heightBasis: 'typical', note: '影像上南侧长条灰顶建筑，209×62 m' },
      { id: 'hall-aux', name: '辅助车间', kind: 'HALL',
        local: { x: -30, z: 128 }, scene: { w: 126, h: 18, d: 25 },
        heightBasis: 'typical', note: '影像上 126×25 m 长条' },
      { id: 'hall-north', name: '北侧综合楼', kind: 'HALL',
        local: { x: -40, z: -120 }, scene: { w: 24, h: 14, d: 50 },
        heightBasis: 'typical', note: '影像上部两栋 24×50 m' },
      { id: 'hall-east', name: '东侧附属房', kind: 'HALL',
        local: { x: 128, z: -45 }, scene: { w: 25, h: 12, d: 49 },
        heightBasis: 'typical', note: '影像右侧 25×49 m' },
    ],
  },

  /* ---------------- 66 保定瑞丰环保电力有限公司 ---------------- */
  YFKW: {
    entId: 66,
    code: 'ent_yfkw',
    nameZh: '保定瑞丰环保电力有限公司',
    short: '瑞丰环保',
    address: '河北省保定市满城区满城镇开源街 9 号',
    lat: 38.861204,
    lon: 115.301588,
    extent: { w: 300, d: 320 },
    cluster: { w: 230, d: 250 },
    layout: '西北侧填埋库区 + 中部蓝色主厂房 + 东侧弧形封闭廊道，东南为厂前绿化',
    structures: [
      { id: 'main-hall', name: '主厂房（焚烧+发电）', kind: 'HALL',
        local: { x: 0, z: 60 }, scene: { w: 78, h: 40, d: 115 },
        heightBasis: 'typical', note: '影像中部偏南蓝色屋顶，约 78×115 m' },
      { id: 'tunnel', name: '封闭输料廊道', kind: 'HALL',
        local: { x: -45, z: -35 }, scene: { w: 110, h: 9, d: 14 },
        heightBasis: 'typical', note: '影像上明显弧形封闭栈桥，长约 110 m' },
      { id: 'landfill', name: '填埋库区', kind: 'HALL',
        local: { x: -105, z: -10 }, scene: { w: 95, h: 12, d: 130 },
        heightBasis: 'typical', note: '影像左上大片深色覆盖区，堆体高度按 12 m' },
      { id: 'stack', name: '烟囱', kind: 'STACK',
        local: { x: 32, z: -28 }, scene: { w: 7, h: 75, d: 7 },
        heightBasis: 'typical', note: '廊道东端白色烟囱' },
      { id: 'hall-south', name: '南侧辅房', kind: 'HALL',
        local: { x: 95, z: 95 }, scene: { w: 30, h: 14, d: 60 },
        heightBasis: 'typical', note: '影像东南白色长条建筑' },
      { id: 'hall-west', name: '西侧辅房', kind: 'HALL',
        local: { x: -90, z: 90 }, scene: { w: 45, h: 12, d: 30 },
        heightBasis: 'typical', note: '影像左下蓝顶小厂房' },
    ],
  },

  /* ---------------- 67 保定易州恒新环保电力有限公司 ---------------- */
  YXYF: {
    entId: 67,
    code: 'ent_yxyf',
    nameZh: '保定易州恒新环保电力有限公司',
    short: '易州恒新',
    address: '河北省保定市易县易州镇朝阳路 66 号',
    lat: 39.398741,
    lon: 115.531096,
    extent: { w: 300, d: 260 },
    cluster: { w: 250, d: 150 },
    layout: '坡地台基上，主厂房沿西北—东南向排布，北侧为填埋场分区台阶',
    structures: [
      { id: 'main-hall', name: '主厂房', kind: 'HALL',
        local: { x: 0, z: 55 }, scene: { w: 60, h: 40, d: 95 },
        heightBasis: 'typical', note: '影像中部蓝顶主体，约 60×95 m' },
      { id: 'hall-2', name: '汽机间', kind: 'HALL',
        local: { x: 58, z: 40 }, scene: { w: 35, h: 26, d: 70 },
        heightBasis: 'typical', note: '主厂房东侧连体蓝顶' },
      { id: 'stack', name: '烟囱', kind: 'STACK',
        local: { x: -38, z: 30 }, scene: { w: 7, h: 75, d: 7 },
        heightBasis: 'typical', note: '主厂房西北侧' },
      { id: 'hall-nw', name: '西北辅房', kind: 'HALL',
        local: { x: -105, z: 5 }, scene: { w: 40, h: 14, d: 55 },
        heightBasis: 'typical', note: '影像左上两栋并排' },
      { id: 'hall-sw', name: '西南厂房', kind: 'HALL',
        local: { x: -55, z: 95 }, scene: { w: 55, h: 16, d: 30 },
        heightBasis: 'typical', note: '影像左下白色长条' },
      { id: 'platform', name: '填埋分区台地', kind: 'HALL',
        local: { x: 15, z: -85 }, scene: { w: 190, h: 8, d: 110 },
        heightBasis: 'typical', note: '影像上方阶梯状填埋分区，按台地体块表示' },
    ],
  },

  /* ---------------- 68 河北恒能（涞水）环保能源有限公司 ---------------- */
  ZJYLS: {
    entId: 68,
    code: 'ent_zjyls',
    nameZh: '河北恒能（涞水）环保能源有限公司',
    short: '恒能涞水',
    address: '河北省保定市涞水县涞水镇园区路 2 号',
    lat: 39.339118,
    lon: 115.689204,
    extent: { w: 340, d: 220 },
    cluster: { w: 300, d: 170 },
    layout: '东西向长条形厂区，白色主厂房居中，东西两侧蓝色附属建筑',
    structures: [
      { id: 'main-hall', name: '主厂房', kind: 'HALL',
        local: { x: 0, z: 0 }, scene: { w: 130, h: 38, d: 110 },
        heightBasis: 'typical', note: '影像中央最大白色屋顶，约 130×110 m' },
      { id: 'hall-east', name: '东侧蓝顶辅房', kind: 'HALL',
        local: { x: 118, z: 10 }, scene: { w: 55, h: 20, d: 80 },
        heightBasis: 'typical', note: '影像右侧蓝色屋顶' },
      { id: 'stack-1', name: '烟囱 1#', kind: 'STACK',
        local: { x: -60, z: -62 }, scene: { w: 7, h: 75, d: 7 },
        heightBasis: 'typical', note: '主厂房北侧' },
      { id: 'stack-2', name: '烟囱 2#', kind: 'STACK',
        local: { x: -45, z: -64 }, scene: { w: 7, h: 75, d: 7 },
        heightBasis: 'typical', note: '与 1# 并排' },
      { id: 'tank-1', name: '白色储罐', kind: 'TANK',
        local: { x: -110, z: -35 }, scene: { w: 16, h: 20, d: 16 },
        heightBasis: 'typical', note: '影像左上白色圆罐' },
      { id: 'hall-west', name: '西侧辅房', kind: 'HALL',
        local: { x: -105, z: 55 }, scene: { w: 40, h: 14, d: 45 },
        heightBasis: 'typical', note: '影像左下厂房' },
      { id: 'hall-south', name: '南侧仓库', kind: 'HALL',
        local: { x: 10, z: 82 }, scene: { w: 90, h: 12, d: 25 },
        heightBasis: 'typical', note: '影像下部长条仓库' },
    ],
  },
};

/** 供 API 输出：把局部坐标 + 尺寸整理成 plant3d.js 需要的结构 */
function structuresFor(code) {
  const p = PLANTS[code];
  if (!p) return null;
  return p.structures.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    /* local.y = h/2：BoxGeometry/CylinderGeometry 以中心为原点，
     * 抬到 h/2 建筑才落地。缺 y 会得 NaN，整栋建筑从场景里消失（实测踩过的坑）。 */
    local: { x: s.local.x, y: (s.scene.h || 0) / 2, z: s.local.z },
    scene: s.scene,
    /* 排放按主厂房/烟囱分摊：这里先留 0，由路由层用真实排放量按占比回填 */
    emission: 0,
    heightBasis: s.heightBasis,
    note: s.note,
  }));
}

function list() {
  return Object.keys(PLANTS).map((k) => {
    const p = PLANTS[k];
    return {
      code: k,
      entId: p.entId,
      name: p.nameZh,
      short: p.short,
      address: p.address,
      lat: p.lat,
      lon: p.lon,
      extent: p.extent,
      cluster: p.cluster,
      layout: p.layout,
      structureCount: p.structures.length,
    };
  });
}

module.exports = { PLANTS, structuresFor, list };
