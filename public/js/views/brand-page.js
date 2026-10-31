/* =====================================================================
   brand-page.js —— 平台主页品牌叙事（/ 与 /login 共用）
   ---------------------------------------------------------------------
   参考西门子 Xcelerator 首页的功能布局，全部为浅层展示性功能：
     ① Hero 轮播（2 帧：数据墙 / 动态核算，8 秒自动切换，
        底部两段进度线——对应西门子 hero 轮播）
     ② AI 问答搜索栏（输入问题回车 → 唤起 AI 顾问自动回答，
        对应西门子的 AI 搜索栏）
     ③ 居中标语带 / 平台介绍 / 核心能力 Bento / 主题标签云
     ④ 开放查询的数据屏（脱敏口径）
     ⑤ 行业数据实证（行业 Tab 切换 + 真实公开数据 KPI，
        对应西门子"成功案例"的行业 Tab，但内容为平台真实数据）
     ⑥ 应用场景三卡
     ⑦ 碳治理·古今中外（实拍视频模块 + 时间线）
     ⑧ 常见问题手风琴
     ⑨ Footer（四列 + 版权，对应西门子 footer）
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;

  const HERO_VIDEOS = ['./img/login/hero-loop.mp4', './img/login/energy-wind.mp4'];
  const HERO_POSTER = './img/login/hero-poster.jpg';

  const DOC_VIDEOS = [
    { src: './img/login/vid/plant-smoke.mp4', label: '火电厂蒸汽排放 · 碳源主视觉（Mixkit 免费素材）' },
    { src: './img/login/vid/chimneys.mp4', label: '工业烟囱排放 · CEMS 实测对象（Mixkit 免费素材）' },
    { src: './img/login/vid/factory-aerial.mp4', label: '工业厂区航拍 · 企业碳账本（Mixkit 免费素材）' },
    { src: './img/login/vid/wind-farm.mp4', label: '风电场日落 · 清洁电力转型（Mixkit 免费素材）' },
  ];

  /* Hero 轮播两帧（对标西门子 hero 轮播） */
  const HERO_SLIDES = [
    { key: 'wall' },   // 数据墙（主标题 + 实时四数字）
    { key: 'ai' },     // 动态核算
  ];
  const SLIDE_MS = 8000;
  /* 分段进度线旁的帧名——"轮播"是系统词，用户该看到的是内容名 */
  const SLIDE_NAMES = ['工业碳资产动态核算', '从"看见排放"到"提前治理"'];

  const INTRO = [
    { n: '01', t: '采集', d: 'CEMS 烟气在线监测与车间智能电表、物料台账多源接入，从工业排口源头采集真实数据',
      spec: ['HJ 212 协议', '分钟级同步'] },
    { n: '02', t: '核算', d: '按逐条附文号的权威排放因子自动折算，范围一 / 二分钟级滚动出数',
      spec: ['30 条因子', '逐条附文号'] },
    { n: '03', t: '存证', d: '国密签名 + 联盟链五道校验，核算结论一经上链不可篡改',
      spec: ['国密 SM2/SM3', '五道校验'] },
    { n: '04', t: '核验', d: '监管与公众可公开核验存证，形成可监督的碳资产账本',
      spec: ['公开可查', '任意回查'] },
  ];

  const LOGIN_PERKS = [
    { icon: 'leaf', t: '企业碳账本', d: '动态核算与缺口预警' },
    { icon: 'block', t: '链上存证', d: '结论上链，公开可核验' },
    { icon: 'coin', t: '配额交易', d: '挂单 · 履约清缴一体' },
    { icon: 'dash', t: '数字孪生', d: '3D 厂区与 CEMS 实时监控' },
  ];

  const SCENARIOS = [
    { img: './img/login/scene-steel.svg', tag: '控排企业', t: '月度动态核算与履约预警',
      d: '高炉与转炉的 CEMS 实测数据滚动核算，年中即知期末缺口——提前交易补足，而非年底被动清缴。',
      foot: ['月度滚动核算', '缺口预警', '履约提醒'] },
    { img: './img/login/scene-export.svg', tag: '出口企业', t: 'CBAM 申报与产品碳足迹',
      d: 'ISO 14067 双轨口径自动生成产品碳足迹，对齐欧盟碳边境调节机制的申报要求。',
      foot: ['ISO 14067 口径', 'CBAM 申报模板', '一键导出'] },
    { img: './img/login/scene-gov.svg', tag: '监管机构', t: '存证核验与行业对标',
      d: '链上存证任意回查、行业分位数对标、异常排放智能预警——监管从抽查变成穿透式核验。',
      foot: ['存证任意回查', '行业分位对标', '异常预警'] },
  ];

  const BENTO = [
    { span: 'lg', img: './img/login/bento-1.jpg', tag: '范围一 / 二 实时接入', title: '工业源端采集与排放因子折算',
      stat: ['30 条', '权威因子 · 逐条附文号'],
      desc: '对接 CEMS 烟气在线监测、车间智能电表与物料台账，按权威排放因子台账（逐条附文号）自动折算，多源数据统一入湖、分钟级同步。' },
    { span: 'md', img: './img/login/bento-dual.svg', tag: 'ISO 14064 / 14067 双轨', title: '动态核算与双轨对账',
      stat: ['2 轨', '组织碳 / 产品碳足迹'],
      desc: 'CEMS 实测滚动核算引擎，按组织碳（ISO 14064）与产品碳足迹（ISO 14067，范围一 + 二）双轨口径出数，并做一致性对账。' },
    { span: 'md', img: './img/login/bento-3.jpg', tag: '五道校验', title: '联盟链可信存证与防篡改',
      stat: ['5 道', '校验 · 改动即失败'],
      desc: 'PoA 授权出块 + SHA-256 哈希链 + Merkle 树 + ECDSA 签名，叠加链下重算绑定，任何改动都会导致全链校验失败。' },
    { span: 'wide', img: './img/login/bento-4.jpg', tag: '多方共治', title: '联盟链成员治理与链副本',
      stat: ['4 方', '节点 · 各持全量链副本'],
      desc: '监管、核查、企业、管理四方许可准入，各自持有全量链副本；任一节点被篡改，其余节点即可凭副本比对发现异常。' },
  ];

  const FLOW = [
    { icon: 'db', t: '工业排口 / 计量表采集', sub: 'CEMS · 智能电表 · 台账' },
    { icon: 'chart', t: '动态核算与双轨对账', sub: 'ISO 14064 / 14067' },
    { icon: 'block', t: '联盟链 PoA 共识上链', sub: '五道校验 · 不可篡改' },
    { icon: 'shield', t: '存证核验与监管出证', sub: '公众可查 · 监管出证' },
  ];

  const TECH_PILLS = ['碳核算', '联盟链', '国密 SM2/SM3', 'CEMS 实测', '零知识证明', '动态配额', 'CBAM', 'CCER', 'ISO 14064', '数字孪生'];
  const INDUSTRY_PILLS = ['电力', '钢铁', '建材', '化工', '有色金属', '造纸', '石化'];

  const TIMELINE = [
    { era: '古代 · 中国', tone: 'g', glyph: '古', items: [
      { y: '西周', t: '设"虞"官', d: '《周礼》记载山虞、泽虞执掌山林川泽——世界最早的环境管理职官制度' },
      { y: '战国', t: '都江堰', d: '李冰主持修建，分水鱼嘴四六分水——两千余年泽被天府的工程与生态共生智慧' },
      { y: '秦代', t: '《田律》', d: '睡虎地秦简《田律》规定春二月毋敢伐材木山林——中国最早的自然保护法令' },
    ] },
    { era: '现代 · 国际', tone: 'b', glyph: '世', items: [
      /* 2026-10-30 收敛：删 1962《寂静的春天》与 1972 斯德哥尔摩会议——
       * 保留纯碳治理法理主线（公约 → 议定书 → 协定），与古代列 3 条对称 */
      { y: '1992', t: '《联合国气候变化框架公约》', d: '里约地球峰会通过，全球气候治理的法律基石——为《京都议定书》与《巴黎协定》铺路' },
      { y: '1997', t: '《京都议定书》', d: '首次以法律约束量化减排义务，碳定价机制发端' },
      { y: '2015', t: '《巴黎协定》', d: '全球温升控制在 2℃ 以内并努力争取 1.5℃——碳中和成为全球共识' },
    ] },
    { era: '现代 · 中国', tone: 'g', glyph: '中', items: [
      { y: '2005', t: '两山理念', d: '"绿水青山就是金山银山"——生态价值与经济价值统一的东方答案' },
      { y: '2020', t: '"双碳"目标提出', d: '中国向世界宣布"2030 年前碳达峰、2060 年前碳中和"——碳账本从此有了硬约束' },
      { y: '2021', t: '全国碳市场上线', d: '全球覆盖排放量最大的碳市场鸣锣开市，电力行业首批纳入' },
      { y: '2025', t: '碳市场扩围', d: '钢铁、水泥、铝冶炼纳入全国碳市场，覆盖排放量升至全国六成以上（《碳排放权交易管理暂行条例》已于 2024 年施行）' },
    ] },
  ];

  const FAQS = [
    { q: '什么是碳配额？', a: '政府按年度免费或有偿分配给控排企业的碳排放权利——1 吨配额对应合法排放 1 吨 CO₂e。企业实际排放超出配额需到市场购买，节省的部分可以出售，"排碳有成本、减碳有收益"。' },
    { q: '平台会泄露我们的生产数据吗？', a: '不会。公众只能看到区域与行业的汇总口径（总量、均值、趋势）；单家企业的原始监测明细、工艺参数、交易对手与价格全部锁在企业与监管的双向授权之内，且这份公开口径本身由链上存证保证不可篡改。' },
    { q: '核算数据从哪里来？', a: '核心链路来自工业现场的 CEMS 烟气在线监测系统，经 HJ 212 协议接入平台；燃料消耗等活动数据支持填报与批量导入。两条数据轨按逐条附文号的权威排放因子台账折算（共 30 条因子、16 类文号出处），并做双轨对账——每一笔数字皆有来源可溯。' },
    { q: '为什么核算结论值得相信？', a: '数据在边缘端即以国密 SM2/SM3 签名防伪；上链需通过 PoA 授权出块、哈希链、Merkle 树、ECDSA 签名与链下重算五道校验。任何一处被改动，全链校验立刻失败。' },
    { q: '如何加入平台？', a: '控排企业在"注册"页填妥信息即可开户；第三方核查机构走"核查机构"通道实名注册，由平台管理员审核通过后开通（审核准入）；监管部门账号由平台管理员创建并授权。' },
  ];

  /* 行业数据实证 Tab（真实公开数据） */
  const IND_TABS = ['电力', '钢铁', '建材', '化工'];

  /* ---------- 迭代升级（2026-10-30 第二轮）：国际化分节编号 ----------
   * 每个区块的 sec-head 顶部加 mono 小字 kicker（01 · JOURNEY …），
   * 形成可预期的阅读节拍；编号与右侧锚导航的序号一致。 */
  const KICKERS = {
    'sec-intro': '01 · JOURNEY',
    'sec-cap': '02 · CAPABILITIES',
    'sec-open': '03 · OPEN DATA',
    'sec-proof': '04 · EVIDENCE',
    'sec-scenes': '05 · SCENARIOS',
    'sec-history': '06 · TIMELINE',
    'sec-faq': '07 · FAQ',
  };
  function secHead(id, title, desc) {
    return h('div', { class: 'sec-head' }, [
      h('span', { class: 'sec-kicker' }, KICKERS[id]),
      h('h2', {}, title),
      h('p', {}, desc),
    ]);
  }

  /* 分行业内容：画像与平台能力各写各的，不再一段话通吃四个行业。
   * 事实口径：电力为全国碳市场首批纳入行业（2021）；
   * 钢铁、水泥（建材）、铝冶炼 2025 年扩围纳入（与"碳治理"时间线一致）。 */
  const IND_META = {
    '电力': {
      profile: '全国碳市场首批管控行业（2021 年上线即纳入发电行业）。平台在册燃煤机组经 CEMS 实测接入，月度动态核算、年度履约清缴，全部结论上链存证。',
      ability: '机组 CEMS 实测接入，净购入电力的间接排放按电网因子折算，ISO 14064 口径出数，动态配额缺口预测。',
    },
    '钢铁': {
      profile: '2025 年全国碳市场扩围首批纳入行业。长流程"烧结—高炉—转炉"工艺排放集中，平台对主要工序 CEMS 实测接入并滚动核算。',
      ability: '多工序 CEMS 实测、物料台账交叉校验、ISO 14064 口径出数、缺口预警提前至年中。',
    },
    '建材': {
      profile: '以水泥熟料为代表，石灰石分解带来的工艺排放占比高，2025 年随全国碳市场扩围纳入。平台按窑线 CEMS 实测与产量台账双轨核算。',
      ability: '回转窑 CEMS 实测、熟料产量活动数据校验、双轨一致性对账、履约清缴预测。',
    },
    '化工': {
      profile: '排放源分散、工艺气体种类多，是核算口径最复杂的行业之一。平台以 CEMS 实测为主、活动数据折算为辅双轨并行，因子逐条附文号保证口径一致。',
      ability: '多气源 CEMS 接入、物料平衡交叉校验、30 条因子自动折算、异常排放预警。',
    },
  };

  const BrandPage = defineComponent({
    name: 'brand-page',
    props: { autoAuth: Boolean },   // /login 路由自动弹出登录框
    setup(props) {
      /* ---------- hero 轮播 ---------- */
      const slideIdx = ref(0);
      let slideTimer = null;
      function startSlides() {
        stopSlides();
        slideTimer = setInterval(() => { slideIdx.value = (slideIdx.value + 1) % HERO_SLIDES.length; }, SLIDE_MS);
      }
      function stopSlides() { if (slideTimer) { clearInterval(slideTimer); slideTimer = null; } }
      function pickSlide(i) { slideIdx.value = i; startSlides(); }

      /* ---------- hero 背景视频 ---------- */
      const heroA = ref(null);
      const heroB = ref(null);
      let heroTimer = null;
      let heroActive = 'a';
      let heroSrcIdx = 0;
      let heroFailCount = 0;
      function heroPlay(v) { if (!v) return; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      function nextSrc() { heroSrcIdx = (heroSrcIdx + 1) % HERO_VIDEOS.length; return HERO_VIDEOS[heroSrcIdx]; }
      function heroVideoError() {
        heroFailCount++;
        if (heroFailCount >= HERO_VIDEOS.length * 2) return;
        const v = heroActive === 'a' ? heroB.value : heroA.value;
        if (v) { v.src = nextSrc(); v.load(); }
      }
      function setupHeroCrossFade() {
        const va = heroA.value, vb = heroB.value;
        if (!va || !vb) return;
        [va, vb].forEach((v) => {
          v.playbackRate = 0.5; v.loop = false; v.muted = true;
          v.addEventListener('error', heroVideoError, true);
        });
        heroActive = 'a';
        va.style.opacity = '1'; vb.style.opacity = '0';
        heroPlay(va);
        heroTimer = setInterval(() => {
          const A = heroActive === 'a' ? va : vb;
          const B = heroActive === 'a' ? vb : va;
          if (!A || !A.duration || A.paused) return;
          if (A.duration - A.currentTime <= 0.8 && B.paused) {
            B.src = nextSrc(); B.load();
            try { B.currentTime = 0; } catch (e) {}
            heroPlay(B); B.style.opacity = '1'; A.style.opacity = '0';
            heroActive = heroActive === 'a' ? 'b' : 'a';
          }
          if (A.ended || (A.duration && A.currentTime >= A.duration - 0.05)) { A.pause(); try { A.currentTime = 0; } catch (e) {} }
        }, 150);
      }
      function teardownHero() {
        if (heroTimer) { clearInterval(heroTimer); heroTimer = null; }
        [heroA.value, heroB.value].forEach((v) => {
          if (!v) return;
          v.removeEventListener('error', heroVideoError, true);
          try { v.pause(); } catch (e) {}
        });
      }

      /* ---------- 纪实视频 ---------- */
      const docIdx = ref(0);
      const docEl = ref(null);
      function pickDoc(i) {
        docIdx.value = i;
        const v = docEl.value;
        if (v) { v.src = DOC_VIDEOS[i].src; v.load(); const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      }

      /* ---------- 开放数据环图 ---------- */
      const openChartEl = ref(null);
      let openChart = null;
      function renderOpenChart(rows) {
        if (!openChartEl.value || !window.echarts || !rows.length) return;
        if (!openChart) {
          openChart = echarts.init(openChartEl.value);
          openChart.setOption({
            tooltip: { show: false },
            series: [{ type: 'pie', radius: ['58%', '82%'], center: ['50%', '50%'],
              label: { show: false }, itemStyle: { borderWidth: 2, borderColor: 'rgba(6,12,10,.9)' }, data: [] }],
          });
        }
        openChart.setOption({ series: [{ data: rows.slice(0, 7).map((r) => ({
          name: r.name, value: r.value,
          itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 1, 1, [
            { offset: 0, color: '#10b981' }, { offset: 1, color: '#06b6d4' }]) },
        })) }] });
      }

      /* ---------- FAQ ---------- */
      const faqOpen = ref(-1);
      function toggleFaq(i) { faqOpen.value = faqOpen.value === i ? -1 : i; }

      /* ---------- 行业数据实证 ---------- */
      const indTab = ref('电力');
      function switchInd(t) { indTab.value = t; }
      const industryStats = computed(() => {
        const d = dash.value || {};
        const k = d.kpi || {};
        const rows = d.byIndustry || [];
        const ind = indTab.value;
        const row = rows.find((r) => r.name === ind);
        return {
          emission: row ? Number(row.value) : 0,
          share: row && k.emissionYtd ? Number(((Number(row.value) / Number(k.emissionYtd)) * 100).toFixed(1)) : 0,
          enterprises: indEntCount.value[ind] || 0,
        };
      });
      const indEntCount = ref({});

      /* ---------- AI 问答搜索栏 ----------
       * 每个话题是一条"完整的提问"，而不是关键词——
       * 点下去就该得到一个值得回答的问题，避免"什么是碳价怎么形成？"式拼接病句。 */
      const aiQuery = ref('');
      const AI_TOPICS = [
        { chip: '碳配额', q: '什么是碳配额？' },
        { chip: '碳价怎么形成', q: '碳价是怎么形成的？' },
        { chip: '年中缺口怎么算', q: '平台怎么在年中就知道年度配额缺口？' },
        { chip: '五道校验', q: '链上存证的"五道校验"分别是哪五道？' },
        { chip: 'CBAM', q: 'CBAM 碳边境调节机制对出口企业意味着什么？平台能帮什么？' },
        { chip: 'CCER', q: '什么是 CCER？平台支持用 CCER 抵销履约吗？' },
        { chip: '碳交易', q: '在碳链通上做一笔碳交易的完整流程是什么？' },
        { chip: '产品碳足迹', q: '什么是产品碳足迹？ISO 14067 口径怎么算？' },
        { chip: '范围一/二/三', q: '范围一、范围二、范围三排放分别指什么？' },
        { chip: 'MRV 体系', q: '什么是 MRV 体系？平台如何落实 MRV？' },
        { chip: 'CEMS', q: 'CEMS 是什么？平台怎么接入 CEMS 数据？' },
        { chip: '排放因子', q: '平台使用的排放因子来自哪里？一共多少条？' },
        { chip: 'PoA 共识', q: '什么是 PoA 共识？联盟链如何出块？' },
        { chip: '国密 SM2/SM3', q: '平台用了哪些国密算法？分别保护什么？' },
        { chip: '零知识证明', q: '零知识证明在平台里怎么用？' },
        { chip: '数字孪生', q: '平台的数字孪生能看到什么？' },
        { chip: '双碳目标', q: '什么是"双碳"目标？' },
        { chip: '碳达峰', q: '什么是碳达峰？' },
        { chip: '碳中和', q: '什么是碳中和？' },
        { chip: '碳汇', q: '什么是碳汇？' },
        { chip: '绿电绿证', q: '绿电和绿证有什么区别？' },
        { chip: 'CCUS', q: '什么是 CCUS？' },
        { chip: '碳普惠', q: '什么是碳普惠？' },
        { chip: 'SBTi', q: '什么是 SBTi 科学碳目标？' },
        { chip: '不确定度', q: '核算结果的不确定度怎么评估？' },
        { chip: '履约清缴', q: '履约清缴是什么流程？' },
        { chip: '配额分配方法', q: '碳配额是怎么分配的？' },
      ];
      /* 未输入时的默认六题：覆盖"概念→机制→自身利益"三层，评委首屏即可各问一句 */
      const AI_DEFAULT_CHIPS = ['碳配额', '碳价怎么形成', '年中缺口怎么算', '五道校验', 'CBAM', '产品碳足迹'];
      const aiSuggest = computed(() => {
        const q = aiQuery.value.trim();
        if (!q) return AI_TOPICS.filter((t) => AI_DEFAULT_CHIPS.includes(t.chip));
        const lq = q.toLowerCase();
        return AI_TOPICS.filter((t) => t.chip.includes(q) || q.includes(t.chip.replace(/\/.*/, ''))
          || t.chip.toLowerCase().includes(lq) || t.q.toLowerCase().includes(lq)).slice(0, 6);
      });
      function askAi() {
        const q = aiQuery.value.trim();
        if (!q) return;
        if (window.__cchCopilotOpen) window.__cchCopilotOpen(q);
        else App.notify.info('AI 顾问加载中，请稍候再试');
      }
      function askTopic(t) {
        aiQuery.value = t.q;
        askAi();
      }

      /* ---------- 锚点导航 ---------- */
      const ANCHORS = [
        { id: 'sec-hero', label: '概览' },
        { id: 'sec-intro', label: '平台介绍' },
        { id: 'sec-cap', label: '核心能力' },
        { id: 'sec-open', label: '开放数据' },
        { id: 'sec-proof', label: '数据实证' },
        { id: 'sec-scenes', label: '应用场景' },
        { id: 'sec-history', label: '碳治理' },
        { id: 'sec-faq', label: '常见问题' },
      ];
      const activeAnchor = ref('sec-hero');
      let anchorObserver = null;
      function setupAnchors() {
        if (!('IntersectionObserver' in window)) return;
        anchorObserver = new IntersectionObserver((entries) => {
          for (const en of entries) if (en.isIntersecting) activeAnchor.value = en.target.id;
        }, { rootMargin: '-30% 0px -55% 0px' });
        ANCHORS.forEach((a) => { const el = document.getElementById(a.id); if (el) anchorObserver.observe(el); });
      }
      function jumpTo(id) { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' } ); }

      /* ---------- 迭代升级：顶部滚动进度条 + 区块入场显现 ----------
       * 进度条：window 滚动比例写入 CSS 变量 --bh-scroll，纯 transform 驱动，零布局抖动。
       * 入场：整节（.sec / 标语带 / AI 条 / 页脚）首次进入视口加 .in 淡入上移；
       * 只挂在"永不因数据刷新而重建"的容器上，避免 Vue 重渲染抹掉类名导致内容消失。 */
      let revealObserver = null;
      let progressEl = null;
      function onWinScroll() {
        if (!progressEl) return;
        const doc = document.documentElement;
        const max = doc.scrollHeight - window.innerHeight;
        const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
        progressEl.style.setProperty('--bh-scroll', p.toFixed(4));
      }
      function setupReveal() {
        progressEl = document.querySelector('.login-hero');
        window.addEventListener('scroll', onWinScroll, { passive: true });
        onWinScroll();
        if (!('IntersectionObserver' in window)) return;
        revealObserver = new IntersectionObserver((entries) => {
          for (const en of entries) {
            if (en.isIntersecting) { en.target.classList.add('in'); revealObserver.unobserve(en.target); }
          }
        }, { rootMargin: '0px 0px -8% 0px' });
        document.querySelectorAll('.rv').forEach((el) => revealObserver.observe(el));
      }

      /* ---------- 数据 ---------- */
      const pact = ref(null);
      const dash = ref(null);
      const wall = computed(() => {
        const d = dash.value || {};
        const k = d.kpi || {};
        /* ⚠ 字段名必须与 /api/public/dashboard 的实际返回一致。
         * 这里曾写成 d.enterprises 与 d.chain.confirmed —— 两个字段都不存在
         * （接口给的是 kpi.entCount 与 chain.totalTxs），
         * 结果首屏"控排企业"显示 —、"链上存证"显示 0 笔，而接口本身完全正常。
         * 这类"取错键静默得到空值"的缺陷最难发现：没有报错、没有日志，
         * 只是数字看起来像刚上线。取不到时显示 —（而非 0），让"无数据"与"数据是 0"可区分。
         * 排序按说服力：存证累计（最大数）领头；第 4 位在「年度排放」为 0 时
         * 自动换成 24h 出块——首屏不放零值指标，但也不编造数字。 */
        const last24Blocks = (d.chain && Array.isArray(d.chain.blockRate))
          ? d.chain.blockRate.reduce((s, r) => s + (Number(r.cnt) || 0), 0)
          : null;
        return [
          { n: d.chain && d.chain.totalTxs != null ? App.fmt.num(d.chain.totalTxs) : '—', u: '笔', t: '链上存证\n实时累计', live: true },
          { n: k.entCount != null ? String(k.entCount) : '—', u: '家', t: '控排企业\n平台在册' },
          { n: k.regionCount != null ? String(k.regionCount) : '—', u: '省', t: '覆盖省份\n全国布局' },
          k.emissionYtd > 0
            ? { n: App.fmt.num(Math.round(k.emissionYtd / 10000)), u: '万 t', t: '年度排放\n（tCO₂e）' }
            : { n: last24Blocks != null ? App.fmt.num(last24Blocks) : '—', u: '块', t: '近 24h\n出块数' },
        ];
      });

      onMounted(async () => {
        setupHeroCrossFade();
        startSlides();
        setTimeout(setupAnchors, 500);
        setupReveal();
        try { pact.value = await App.API.get('/chain/stats'); } catch (e) { /* ignore */ }
        try {
          dash.value = await App.API.request('GET', '/public/dashboard', null, { noAuth: true });
          setTimeout(() => renderOpenChart(dash.value.byIndustry || []), 120);
          /* 各行业企业数（公开名录）—— 行业数据实证 Tab 用 */
          try {
            const list = await App.API.request('GET', '/public/enterprises?page=1&size=200', null, { noAuth: true });
            const rows = Array.isArray(list) ? list : (list.rows || []);
            const cnt = {};
            for (const e of rows) cnt[e.industry] = (cnt[e.industry] || 0) + 1;
            indEntCount.value = cnt;
          } catch { /* ignore */ }
          window.addEventListener('resize', resizeOpenChart);
        } catch (e) { /* ignore */ }
        /* /login 路由：自动弹出登录框 */
        if (props.autoAuth && window.__cchOpenAuth) setTimeout(() => window.__cchOpenAuth('login'), 600);
      });
      onUnmounted(() => {
        teardownHero(); stopSlides();
        if (anchorObserver) { anchorObserver.disconnect(); anchorObserver = null; }
        if (revealObserver) { revealObserver.disconnect(); revealObserver = null; }
        window.removeEventListener('scroll', onWinScroll);
        window.removeEventListener('resize', resizeOpenChart);
        if (openChart) { openChart.dispose(); openChart = null; }
      });

      return () => {
        const d = dash.value || {};
        const k = d.kpi || {};
        return h('div', { class: 'login-hero brand-scroll' }, [
          /* 顶部滚动进度条（--bh-scroll 驱动） */
          h('div', { class: 'bh-progress', 'aria-hidden': 'true' }, [h('i')]),

          /* 右侧 sticky 竖锚导航（非当前项标签隐藏，悬停展开——降噪） */
          h('div', { class: 'hero-anchors' }, ANCHORS.map((a) =>
            h('button', { class: activeAnchor.value === a.id ? 'on' : '', onClick: () => jumpTo(a.id) },
              [h('span', { class: 'al' }, a.label), h('i')]))),

            /* ---------- Hero 首屏（单列：左信息纵队） ---------- */
            h('section', { class: 'hero', id: 'sec-hero' }, [
            h('div', { class: 'hero-media' }, [
              h('video', { class: 'hero-video', muted: true, autoplay: true, loop: false, playsinline: true,
                preload: 'auto', poster: HERO_POSTER, src: HERO_VIDEOS[0],
                style: 'opacity:1;transition:opacity 1.6s linear', ref: (el) => { heroA.value = el; } }),
              h('video', { class: 'hero-video', muted: true, loop: false, playsinline: true,
                preload: 'auto', poster: HERO_POSTER, style: 'opacity:0;transition:opacity 1.6s linear',
                ref: (el) => { heroB.value = el; } }),
              /* 装饰层：细网格 + 噪点，让视频压暗后的死黑有结构感 */
              h('div', { class: 'hero-deco', 'aria-hidden': 'true' }),
              h('div', { class: 'hero-mask' }),
            ]),
            h('div', { class: 'hero-inner' }, [
              /* 左：信息纵队（眉部徽章 → 主标 → 副标 → 数据条 → CTA → 轮播进度） */
              h('div', { class: 'hero-main' }, [
                h('div', { class: 'hero-eyebrow rise d1' }, [
                  h('i', { class: 'pulse', 'aria-hidden': 'true' }), '链上网络运行中 · 实时同步',
                ]),

                /* 帧 1：主标题 + 数据墙 */
                slideIdx.value === 0 ? h('div', { key: 's0' }, [
                  h('h1', { class: 'hero-title rise d2' }, ['工业碳资产动态核算', h('br'), h('em', {}, '链上可信存证')]),
                  h('p', { class: 'hero-sub rise d3' }, ['让每一吨碳', h('em', {}, '可测量、可核验、可交易')]),
                  h('div', { class: 'hero-wall rise d4' }, wall.value.map((x) =>
                    h('div', { class: 'hw-item' }, [
                      h('div', { class: 'hw-num' }, [x.n, h('span', { class: 'hw-unit' }, x.u),
                        x.live ? h('i', { class: 'hw-live', title: '实时累计 · 与区块链浏览器同源', 'aria-hidden': 'true' }) : null]),
                      h('div', { class: 'hw-label' }, x.t),
                    ]))),
                  h('div', { class: 'wall-note rise d5' },
                    '以上数字来自平台公开接口，与数据公示大屏同源 —— 任何人均可独立核验'),
                ]) : null,

                /* 帧 2：动态核算 */
                slideIdx.value === 1 ? h('div', { key: 's1' }, [
                  h('h1', { class: 'hero-title rise d2' }, ['从"看见排放"', h('br'), h('em', {}, '到"提前治理"')]),
                  h('p', { class: 'hero-sub rise d3' }, ['CEMS 实测滚动核算引擎，年中即知期末缺口——', h('em', {}, '提前交易补足，而非年底被动清缴')]),
                  h('div', { class: 'hero-wall rise d4' }, [
                    h('div', { class: 'hw-item' }, [h('div', { class: 'hw-num' }, ['分钟级']), h('div', { class: 'hw-label' }, 'CEMS 实测\n滚动核算')]),
                    h('div', { class: 'hw-item' }, [h('div', { class: 'hw-num' }, ['5 道']), h('div', { class: 'hw-label' }, '上链存证\n五道校验')]),
                    h('div', { class: 'hw-item' }, [h('div', { class: 'hw-num' }, ['30 条']), h('div', { class: 'hw-label' }, '排放因子\n逐条附文号')]),
                    h('div', { class: 'hw-item' }, [h('div', { class: 'hw-num' }, ['2 轨']), h('div', { class: 'hw-label' }, '双轨口径\n一致性对账')]),
                  ]),
                ]) : null,

                h('div', { class: 'hero-cta rise d5' }, [
                  h('button', { class: 'cta cta-primary', onClick: () => App.go('/screen') }, [
                    h('x-icon', { name: 'globe', size: 16 }), '进入数据公示大屏',
                  ]),
                  h('button', { class: 'cta cta-ghost', onClick: () => App.go('/explorer') }, [
                    h('x-icon', { name: 'block', size: 16 }), '查看链上存证',
                  ]),
                ]),
                /* 轮播进度线（2 段）+ 当前帧名 */
                h('div', { class: 'slide-progress rise d5' }, [
                  ...HERO_SLIDES.map((s, i) =>
                    h('button', { class: ['sp-seg', i === slideIdx.value && 'on'],
                      'aria-label': '切换到第 ' + (i + 1) + ' 帧：' + SLIDE_NAMES[i], onClick: () => pickSlide(i) })),
                  h('span', { class: 'sp-name' }, '0' + (slideIdx.value + 1) + ' · ' + SLIDE_NAMES[slideIdx.value]),
                ]),
              ]),
            ]),
          ]),

          /* ---------- AI 问答搜索栏 ---------- */
          h('div', { class: 'ai-search rv' }, [
            h('x-icon', { name: 'spark', size: 17 }),
            h('input', {
              class: 'ai-input', value: aiQuery.value,
              placeholder: '问碳链通 AI 顾问一个问题，如：什么是碳配额？',
              onInput: (e) => { aiQuery.value = e.target.value; },
              onKeydown: (e) => { if (e.key === 'Enter') askAi(); },
            }),
            h('button', { class: 'ai-send', onClick: askAi, 'aria-label': '提问' }, '➤'),
          ]),
          h('div', { class: 'ai-suggest rv' }, [
            h('span', { class: 'as-label' }, '试试问我：'),
            ...aiSuggest.value.map((t) =>
              h('button', { class: 'as-chip', onClick: () => askTopic(t) }, t.chip)),
          ]),

          /* ---------- ① 平台介绍 ---------- */
          h('section', { class: 'sec rv', id: 'sec-intro' }, [
            secHead('sec-intro', '平台介绍', '一次采集、全程留痕：从工业排口到链上账本的完整旅程。'),
            h('div', { class: 'intro-wrap' }, [
              h('div', { class: 'intro-photo', style: 'background-image:url("./img/login/intro-plant.svg")' },
                [h('div', { class: 'intro-photo-tag' }, '工业排口 · CEMS 监测对象')]),
              h('div', { class: 'intro-points' }, INTRO.map((x) =>
                h('div', { class: 'intro-point' }, [
                  h('span', { class: 'ip-num' }, x.n),
                  h('div', { class: 'ip-body' }, [h('b', {}, x.t), h('p', {}, x.d),
                    h('div', { class: 'ip-spec' }, x.spec.map((s) => h('i', {}, s)))]),
                ]))),
            ]),
            h('div', { class: 'flow-track' }, FLOW.flatMap((f, i) => {
              const node = h('div', { class: 'flow-node' }, [
                h('div', { class: 'flow-ico' }, [h('x-icon', { name: f.icon, size: 18 })]),
                h('div', { class: 'flow-txt' }, [f.t, h('span', { class: 'flow-sub' }, f.sub)]),
              ]);
              return i < FLOW.length - 1 ? [node, h('i', { class: 'flow-link' })] : [node];
            })),
          ]),

          /* ---------- ② 平台核心能力 ---------- */
          h('section', { class: 'sec rv', id: 'sec-cap' }, [
            secHead('sec-cap', '平台核心能力', '从工业排口计量到链上可信存证，端到端打通的碳资产动态核算体系。'),
            h('div', { class: 'bento-grid' }, BENTO.map((b) => h('article', { class: ['bento-item', b.span] }, [
              h('div', { class: 'bento-bg', style: `background-image:url("${b.img}")` }),
              h('div', { class: 'bento-veil' }),
              h('div', { class: 'bento-body' }, [
                h('span', { class: 'bento-tag' }, [h('i', { class: 'dot' }), b.tag]),
                h('h3', {}, b.title),
                h('p', {}, b.desc),
                h('div', { class: 'bento-stat' }, [h('b', {}, b.stat[0]), h('span', {}, b.stat[1])]),
              ]),
            ]))),
            h('div', { class: 'pill-cloud', style: 'margin-top:26px' }, TECH_PILLS.map((p) => h('span', { class: 'pc-item' }, p))),
            h('div', { class: 'pill-cloud', style: 'margin-top:10px' }, INDUSTRY_PILLS.map((p) => h('span', { class: 'pc-item' }, p))),
          ]),

          /* ---------- ③ 开放查询的数据屏 ---------- */
          h('section', { class: 'sec rv', id: 'sec-open' }, [
            secHead('sec-open', '开放查询的数据屏', '面向全社会公众开放实时查询 —— 数据公示与数据保密的边界，清清楚楚。'),
            h('div', { class: 'open-wrap' }, [
              h('div', { class: 'open-live' }, [
                h('div', { class: 'open-live-head' }, [
                  h('span', { class: 'live-dot' }), 'LIVE · 实时公开数据',
                  h('button', { class: 'open-more', onClick: () => App.go('/screen') }, '进入大屏 ↗'),
                ]),
                h('div', { class: 'open-kpis' }, [
                  h('div', { class: 'ok-item' }, [h('b', {}, dash.value ? App.fmt.num(k.emissionYtd || 0) : '—'), h('span', {}, '年度排放 (tCO₂e)')]),
                  h('div', { class: 'ok-item' }, [h('b', {}, k.verifiedRate != null ? k.verifiedRate + '%' : '—'), h('span', {}, '核查通过率')]),
                  h('div', { class: 'ok-item' }, [h('b', {}, [d.chain && d.chain.totalTxs != null ? App.fmt.num(d.chain.totalTxs) : '—',
                    h('i', { class: 'ok-live', title: '实时累计 · 与区块链浏览器同源', 'aria-hidden': 'true' })]), h('span', {}, '链上存证（笔）')]),
                  h('div', { class: 'ok-item' }, [h('b', {}, k.entCount != null ? String(k.entCount) : '—'), h('span', {}, '控排企业（家）')]),
                ]),
                h('div', { class: 'open-chart-row' }, [
                  h('div', { class: 'open-chart-box' }, [
                    h('div', { class: 'open-chart', ref: openChartEl }),
                    k.emissionYtd > 0 ? h('div', { class: 'open-chart-center' }, [
                      h('b', {}, App.fmt.num(Math.round(k.emissionYtd / 10000))),
                      h('span', {}, '万 tCO₂e · 年度'),
                    ]) : null,
                  ]),
                  h('div', { class: 'open-chart-side' }, [
                    h('b', {}, '行业排放构成'),
                    h('p', {}, '按国民经济行业分类汇总，全部来自企业上报与核查结论的公开口径。'),
                    h('div', { class: 'open-legend' }, (d.byIndustry || []).slice(0, 5).map((r) =>
                      h('span', { class: 'ol-item' }, [h('i'), r.name]))),
                    k.regionCount != null ? h('p', { class: 'ob-leaders' },
                      '已覆盖 ' + k.regionCount + ' 个省级区域 · 当前排放量前三：'
                      + (d.byRegion || []).slice(0, 3).map((r) => r.name.replace(/省|市$/, '')).join('、')) : null,
                  ]),
                ]),
              ]),
              h('div', { class: 'open-boundary' }, [
                h('h3', {}, '公开什么，不公开什么'),
                h('div', { class: 'ob-block ok' }, [
                  h('b', {}, '✓ 公开（汇总口径）'),
                  h('ul', {}, [
                    h('li', {}, '区域与行业的排放总量、均值与趋势'),
                    h('li', {}, '链上存证高度与账本结构'),
                    h('li', {}, '核查通过率等合规指标'),
                  ]),
                ]),
                h('div', { class: 'ob-block no' }, [
                  h('b', {}, '✕ 保密数据（仅授权可见）'),
                  h('ul', {}, [
                    h('li', {}, '单家企业未脱敏的原始监测明细'),
                    h('li', {}, '企业配方、工艺参数与台账细节'),
                    h('li', {}, '交易对手与成交价格'),
                  ]),
                ]),
                h('p', { class: 'ob-note' },
                  '公众看到的是"总量与趋势"，敏感数据锁在企业与监管的双向授权之内 —— 由链上存证保证这份公开口径本身不可被篡改。'),
              ]),
            ]),
          ]),

          /* ---------- ④ 行业数据实证（Tab 切换真实数据） ---------- */
          h('section', { class: 'sec rv', id: 'sec-proof' }, [
            secHead('sec-proof', '行业数据实证', '切换行业，查看平台内该行业的实时公开数据 —— 不是宣传语，是正在发生的数据。'),
            h('div', { class: 'ind-tabs' }, IND_TABS.map((t) =>
              h('button', { class: ['ind-tab', indTab.value === t && 'on'], onClick: () => switchInd(t) }, t))),
            h('div', { class: 'ind-panel', key: indTab.value }, [
              h('div', { class: 'ind-head' }, [
                h('span', { class: 'ind-logo' }, indTab.value.slice(0, 1)),
                h('b', {}, indTab.value + '行业 · 平台实时画像'),
              ]),
              h('div', { class: 'ind-kpis' }, [
                h('div', { class: 'ik' }, [h('b', {}, String(industryStats.value.enterprises)), h('span', {}, '在册企业（家）')]),
                h('div', { class: 'ik' }, [h('b', {}, App.fmt.num(Math.round(industryStats.value.emission / 10000))), h('span', {}, '年度排放（万 tCO₂e）')]),
                h('div', { class: 'ik' }, [h('b', {}, industryStats.value.share + '%'), h('span', {}, '占全平台排放比例')]),
              ]),
              h('div', { class: 'ind-cols' }, [
                h('div', { class: 'ic' }, [
                  h('b', {}, '行业画像'),
                  h('p', {}, (IND_META[indTab.value] || {}).profile || ''),
                ]),
                h('div', { class: 'ic' }, [
                  h('b', {}, '平台能力'),
                  h('p', {}, (IND_META[indTab.value] || {}).ability || ''),
                ]),
                h('div', { class: 'ic' }, [
                  h('b', {}, '实时数据'),
                  h('p', {}, '上方三项数字来自平台公开接口的实时汇总，与数据公示大屏同源，任何人均可独立核验。'),
                ]),
              ]),
            ]),
          ]),

          /* ---------- ⑤ 应用场景 ---------- */
          h('section', { class: 'sec rv', id: 'sec-scenes' }, [
            secHead('sec-scenes', '应用场景', '同一个账本，服务三类主体——企业管资产，出口保合规，监管有抓手。'),
            h('div', { class: 'scene-grid' }, SCENARIOS.map((s) =>
              h('article', { class: 'scene-card' }, [
                h('div', { class: 'sc-img', style: `background-image:url("${s.img}")` }, [h('span', { class: 'sc-tag' }, s.tag)]),
                h('div', { class: 'sc-body' }, [h('h3', {}, s.t), h('p', {}, s.d),
                  h('div', { class: 'sc-foot' }, s.foot.map((c) => h('i', {}, c)))]),
              ]))),
          ]),

          /* ---------- ⑥ 碳治理·古今中外 ---------- */
          h('section', { class: 'sec rv', id: 'sec-history' }, [
            secHead('sec-history', '碳治理 · 古今中外', '从西周的虞官到巴黎协定——一部跨越三千年的"环境账本"。今天，碳链通把它记到每一吨排放。'),
            h('div', { class: 'doc-wrap' }, [
              h('div', { class: 'doc-video' }, [
                h('video', { ref: docEl, src: DOC_VIDEOS[0].src, class: 'doc-player', muted: true, loop: true, autoplay: true, playsinline: true }),
                h('div', { class: 'doc-switch' }, DOC_VIDEOS.map((v, i) =>
                  h('button', { class: ['doc-btn', i === docIdx.value && 'on'], onClick: () => pickDoc(i) }, v.label.split(' · ')[0]))),
                h('div', { class: 'doc-caption' }, DOC_VIDEOS[docIdx.value].label),
              ]),
              h('div', { class: 'doc-photos' }, [
                h('div', { class: 'dp-item', style: 'background-image:url("./img/login/carbon-farm.jpg")' }, [h('span', {}, '风电场 · 清洁电力')]),
                h('div', { class: 'dp-item', style: 'background-image:url("./img/login/carbon-solar.jpg")' }, [h('span', {}, '光伏阵列 · 分布式能源')]),
                h('div', { class: 'dp-item', style: 'background-image:url("./img/login/carbon-forest.jpg")' }, [h('span', {}, '森林碳汇 · 生态屏障')]),
              ]),
            ]),
            h('div', { class: 'tl-grid' }, TIMELINE.map((col) =>
              h('div', { class: ['tl-col', 'tl-' + col.tone], 'data-glyph': col.glyph }, [
                h('div', { class: 'tl-era' }, [col.era, h('span', { class: 'tl-count' }, col.items.length + ' 个节点')]),
                col.items.map((it) => h('div', { class: 'tl-item' }, [
                  h('div', { class: 'tl-y' }, it.y),
                  h('div', { class: 'tl-body' }, [h('b', {}, it.t), h('p', {}, it.d)]),
                ])),
              ]))),
          ]),

          /* ---------- ⑦ 常见问题 ---------- */
          h('section', { class: 'sec rv', id: 'sec-faq' }, [
            secHead('sec-faq', '常见问题', '关于碳资产、数据安全与准入的五个高频问题。'),
            h('div', { class: 'faq-list' }, FAQS.map((f, i) =>
              h('div', { class: ['faq-item', faqOpen.value === i && 'open'] }, [
                h('button', { class: 'faq-q', onClick: () => toggleFaq(i) }, [
                  h('span', {}, f.q),
                  h('i', { class: 'faq-caret' }, faqOpen.value === i ? '−' : '+'),
                ]),
                faqOpen.value === i ? h('div', { class: 'faq-a' }, f.a) : null,
              ]))),
          ]),

          /* ---------- Footer ---------- */
          h('footer', { class: 'brand-footer rv' }, [
            h('div', { class: 'bf-brand' }, [
              h('div', { class: 'brand-logo' }, [h('img', { src: './img/logo-mark.png', alt: '碳链通' })]),
              h('div', { class: 'brand-txt' }, [h('strong', {}, '碳链通 CarbonChain Hub'), h('span', {}, '工业碳资产动态核算可信存证平台')]),
            ]),
            h('div', { class: 'bf-cols' }, [
              h('div', { class: 'bf-col' }, [
                h('b', {}, '公众探索'),
                h('button', { onClick: () => App.go('/screen') }, '数据公示大屏'),
                h('button', { onClick: () => App.go('/explorer') }, '区块链浏览器'),
                h('button', { onClick: () => App.go('/notice') }, '通知公告'),
                h('button', { onClick: () => jumpTo('sec-open') }, '开放数据'),
              ]),
              h('div', { class: 'bf-col' }, [
                h('b', {}, '数据来源'),
                h('a', { href: 'https://www.mee.gov.cn', target: '_blank', rel: 'noopener noreferrer' }, '生态环境部'),
                h('a', { href: 'https://www.cneeex.com', target: '_blank', rel: 'noopener noreferrer' }, '上海环境能源交易所'),
                h('a', { href: 'https://icapcarbonaction.com', target: '_blank', rel: 'noopener noreferrer' }, 'ICAP 国际碳行动伙伴关系'),
                h('button', { onClick: () => jumpTo('sec-history') }, '碳治理时间线'),
              ]),
              h('div', { class: 'bf-col' }, [
                h('b', {}, '支持'),
                h('button', { onClick: () => jumpTo('sec-faq') }, '常见问题'),
                h('button', { onClick: () => { if (window.__cchOpenAuth) window.__cchOpenAuth('login'); else App.go('/login'); } }, '登录 / 注册'),
                h('button', { onClick: () => { if (window.__cchCopilotOpen) window.__cchCopilotOpen(''); } }, 'AI 顾问'),
              ]),
            ]),
            h('div', { class: 'bf-copy' }, [
              h('span', {}, '碳链通 CarbonChain Hub · 工业碳资产动态核算可信存证平台'),
              h('span', {}, '公开数据与商业保密的边界由链上存证机制支撑 · ' + new Date().getFullYear()),
              h('span', { class: 'tiny', style: 'opacity:.75' },
                '本平台为高校学生竞赛演示项目（挑战杯），未取得任何政府授权或机构背书；'
                + '业务库企业/机构主体均为合成演示数据，真实外部数据（EPA GHGRP、Climate TRACE、世界银行等）均注明原始出处，'
                + '平台提供核算与存证辅助功能，不替代法定核查结论，不构成任何投资或法律建议。'),
            ]),
          ]),
        ]);
      };
    },
  });

  App.BrandPage = BrandPage;
})();
