/* =====================================================================
   login.js —— /login 路由：平台端登录页
   ---------------------------------------------------------------------
   2026-10-30 整体重设计：悬浮玻璃卡片（左品牌叙事 / 右登录注册表单）
   悬于「链网粒子 canvas（静帧）+ 网格肌理 + 极光渐晕」背景之上。
   粒子网络隐喻联盟链节点互联；定帧绘制不持续重绘 —— 实测持续动画叠加
   毛玻璃会让软件渲染合成器卡死，弱机演示必须回避。

   功能层保持不变：登录 / 注册（控排企业 · 核查机构双通道）、演示身份
   下拉（分组 + 搜索 + 一键填入）、口令明文切换、大写锁定提示、协议
   摘要弹窗。品牌叙事完整内容仍由 views/brand-page.js 提供。

   顶栏「登录平台」按钮在其他页面通过 App.go('/login') 落到这里；
   在本页时通过 window.__cchOpenAuth 切换登录 / 注册页签。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed, onMounted, onUnmounted } = Vue;
  const h = App.h;

  function roleHome(role) {
    const map = (App.routeAccess && App.routeAccess.ROLE_HOME) || {};
    return map[role] || '/screen';
  }

  /* 品牌区权益清单 */
  const LOGIN_PERKS = [
    { icon: 'leaf', t: '企业碳账本', d: '动态核算与缺口预警' },
    { icon: 'block', t: '链上存证', d: '结论上链，公开可核验' },
    { icon: 'coin', t: '配额交易', d: '挂单 · 履约清缴一体' },
    { icon: 'dash', t: '数字孪生', d: '3D 厂区与 CEMS 实时监控' },
  ];

  /* 演示身份的图标与职责说明 —— 键与 /auth/demo-accounts 的 role 对齐。
   * 新增角色账号后只需在这里补一行，下拉即自动展示。 */
  const ROLE_META = {
    ADMIN: { icon: 'shield', d: '全平台配置与用户治理' },
    REGULATOR: { icon: 'bank', d: '存证核验与行业对标' },
    ENTERPRISE: { icon: 'factory', d: '碳账本与履约清缴' },
    VERIFIER: { icon: 'verify', d: '核查任务与出证' },
    TRADER: { icon: 'trade', d: '配额交易与履约策略' },
  };

  /* 下拉里的角色分组顺序：按业务主线排列（企业 → 核查 → 监管 → 管理 → 交易）。
   * 不用后端返回顺序，是为了让"多账号"这件事读起来有结构，而不是 23 行平铺。 */
  const ROLE_ORDER = ['ENTERPRISE', 'VERIFIER', 'REGULATOR', 'ADMIN', 'TRADER'];

  const PageLogin = defineComponent({
    name: 'page-login',
    setup() {
      const tab = ref('login');
      const username = ref('');
      const password = ref('');
      const loading = ref(false);
      const accounts = ref([]);
      const demoClosed = ref(false);
      const err = ref('');

      /* 交互精修：口令明文切换 / 大写锁定提示 / 演示身份下拉 */
      const pwShow = ref(false);
      const capsOn = ref(false);
      const ddOpen = ref(false);
      const demoSel = ref(null);
      const ddQuery = ref('');

      /* 背景画布的宿主与 canvas 节点（模板 ref） */
      const pageEl = ref(null);
      const netEl = ref(null);

      /* 演示身份分组：角色 → 主体 → 账号。
       * 十几个账号平铺成一个长列表没人读得下去，分组后才看得出
       * "一个主体下有几个岗位、谁负责录入、谁负责审批"。 */
      const ddGroups = computed(() => {
        const q = ddQuery.value.trim().toLowerCase();
        const hit = (a) => !q || [a.username, a.realName, a.orgName, a.postCn, a.roleCn]
          .some((v) => v && String(v).toLowerCase().includes(q));
        const list = accounts.value.filter(hit);
        return ROLE_ORDER
          .map((role) => {
            const items = list.filter((a) => a.role === role);
            if (!items.length) return null;
            /* 同一角色下按主体归并；保持后端给的顺序（同主体岗位相邻） */
            const orgs = [];
            for (const a of items) {
              const name = a.orgName || ROLE_META[role]?.d || '平台账号';
              let g = orgs.find((o) => o.name === name);
              if (!g) { g = { name, items: [] }; orgs.push(g); }
              g.items.push(a);
            }
            return {
              role,
              roleCn: items[0].roleCn || role,
              meta: ROLE_META[role] || {},
              count: items.length,
              /* 只有一个主体时不重复显示主体名（如监管端两个岗位同属一个厅） */
              showOrg: orgs.length > 1,
              orgs,
            };
          })
          .filter(Boolean);
      });
      const ddTotal = computed(() => ddGroups.value.reduce((n, g) => n + g.count, 0));

      /* 品牌区实时数据（与主页首屏同源：/api/public/dashboard） */
      const dash = ref(null);
      const wall = computed(() => {
        const d = dash.value || {};
        const k = d.kpi || {};
        /* 字段名与 brand-page.js 的首屏一致：kpi.entCount / kpi.regionCount /
         * chain.totalTxs。取不到时显示 —，与「数据是 0」可区分。 */
        return [
          { n: k.entCount != null ? String(k.entCount) : '—', u: '家', t: '控排企业' },
          { n: k.regionCount != null ? String(k.regionCount) : '—', u: '省', t: '覆盖省份' },
          { n: d.chain && d.chain.totalTxs != null ? App.fmt.num(d.chain.totalTxs) : '—', u: '笔', t: '链上存证' },
        ];
      });

      const reg = ref({
        role: 'ENTERPRISE',
        username: '', password: '', password2: '', realName: '',
        orgName: '', industry: '', region: '', contactPhone: '',
      });
      const isVerifierReg = computed(() => reg.value.role === 'VERIFIER');
      const regLoading = ref(false);
      const regAgree = ref(false);
      const agreeModal = ref(false);
      const INDUSTRIES = ['电力', '钢铁', '建材', '化工', '有色金属', '造纸', '石化', '其他'];
      const REGIONS = ['北京','天津','河北','山西','内蒙古','辽宁','吉林','黑龙江','上海','江苏',
        '浙江','安徽','福建','江西','山东','河南','湖北','湖南','广东','广西','海南','重庆','四川',
        '贵州','云南','西藏','陕西','甘肃','青海','宁夏','新疆','台湾'];

      /* 顶栏「登录平台」入口兼容：本页内切换页签；其他页面由调用方跳转 /login */
      function openAuth(which) {
        tab.value = which || 'login';
        err.value = '';
      }
      onMounted(() => { window.__cchOpenAuth = openAuth; });
      onUnmounted(() => {
        if (window.__cchOpenAuth) delete window.__cchOpenAuth;
      });

      /* 演示身份下拉：点击外部 / Esc 关闭 */
      function onDocClick(e) {
        if (ddOpen.value && !(e.target.closest && e.target.closest('.au-dd'))) {
          ddOpen.value = false;
          ddQuery.value = '';
        }
      }
      function onEsc(e) {
        if (e.key === 'Escape' && ddOpen.value) { ddOpen.value = false; ddQuery.value = ''; }
      }
      onMounted(() => document.addEventListener('click', onDocClick));
      onUnmounted(() => document.removeEventListener('click', onDocClick));
      onMounted(() => document.addEventListener('keydown', onEsc));
      onUnmounted(() => document.removeEventListener('keydown', onEsc));

      /* ------------------------------------------------------------------
       * 背景链网粒子：静态绘制的节点 + 距离阈值内连线，隐喻联盟链上
       * 互联互通的节点。2026-10-30 实测：canvas 持续重绘叠加毛玻璃
       * backdrop-filter 会让软件渲染合成器持续重算（弱机/内嵌 WebView
       * 直接卡死），故定帧绘制一次，仅随容器尺寸变化重绘。
       * ------------------------------------------------------------------ */
      let netCleanup = null;
      onMounted(() => {
        const host = pageEl.value;
        const cv = netEl.value;
        if (!host || !cv || !cv.getContext) return;
        const ctx = cv.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        function draw() {
          const r = host.getBoundingClientRect();
          const w = Math.max(1, r.width), hgt = Math.max(1, r.height);
          cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, w, hgt);
          /* 密度随面积自适应，钳制在 22~56 个节点 */
          const n = Math.max(22, Math.min(56, Math.round(w * hgt / 30000)));
          const pts = Array.from({ length: n }, () => ({
            x: Math.random() * w, y: Math.random() * hgt,
            r: Math.random() * 1.5 + .8,
            cyan: Math.random() < .18,
          }));
          const LINK = 128;
          for (let i = 0; i < pts.length; i++) {
            for (let j = i + 1; j < pts.length; j++) {
              const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
              const d2 = dx * dx + dy * dy;
              if (d2 < LINK * LINK) {
                const o = (1 - Math.sqrt(d2) / LINK) * .15;
                ctx.strokeStyle = `rgba(16, 185, 129, ${o.toFixed(3)})`;
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
              }
            }
          }
          for (const p of pts) {
            ctx.fillStyle = p.cyan ? 'rgba(103, 232, 249, .55)' : 'rgba(110, 231, 183, .45)';
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
          }
        }

        draw();
        const ro = new ResizeObserver(draw);
        ro.observe(host);
        netCleanup = () => ro.disconnect();
      });
      onUnmounted(() => { if (netCleanup) netCleanup(); });

      onMounted(async () => {
        try {
          accounts.value = await App.API.request('GET', '/auth/demo-accounts', null, { noAuth: true });
        } catch (e) {
          if (e && /关闭/.test(e.message || '')) demoClosed.value = true;
        }
        try {
          dash.value = await App.API.request('GET', '/public/dashboard', null, { noAuth: true });
        } catch (e) { /* 品牌区数字展示 —，不阻塞登录 */ }
        /* 已登录：直接进工作台 */
        if (App.Store.user && App.Store.token) { App.go(roleHome(App.Store.user.role)); }
      });

      function useAccount(a) {
        tab.value = 'login';
        username.value = a.username;
        password.value = a.password;
        demoSel.value = a;
        ddOpen.value = false;
        ddQuery.value = '';
        err.value = '';
      }

      function toggleDd() {
        ddOpen.value = !ddOpen.value;
        if (!ddOpen.value) ddQuery.value = '';
      }

      function pwKey(e) {
        capsOn.value = !!(e.getModifierState && e.getModifierState('CapsLock'));
      }

      async function submit() {
        if (!username.value || !password.value) { err.value = '请输入账号与密码'; return; }
        loading.value = true; err.value = '';
        try {
          const d = await App.API.request('POST', '/auth/login', { username: username.value, password: password.value }, { noRedirect: true });
          setSession(d.token, d.user);
          App.notify.ok(`欢迎回来，${d.user.realName || d.user.username}（${d.user.roleCn}）`);
          App.go(roleHome(d.user.role));
        } catch (e) {
          err.value = e.message;
        } finally {
          loading.value = false;
        }
      }

      async function submitRegister() {
        const r = reg.value;
        const verifier = r.role === 'VERIFIER';
        err.value = '';
        if (!/^[A-Za-z0-9_]{3,30}$/.test(r.username)) { err.value = '账号需为 3-30 位字母、数字或下划线'; return; }
        if (r.password.length < 6) { err.value = '密码至少 6 位'; return; }
        if (r.password !== r.password2) { err.value = '两次输入的密码不一致'; return; }
        if (!r.realName.trim()) { err.value = '请填写联系人姓名'; return; }
        if (!r.orgName.trim()) { err.value = verifier ? '请填写机构名称' : '请填写企业名称'; return; }
        if (!verifier && !r.industry) { err.value = '请选择所属行业'; return; }
        if (!r.region) { err.value = verifier ? '请选择机构所在省份' : '请选择所在省份'; return; }
        if (!regAgree.value) { err.value = '请先阅读并勾选同意《用户协议》与《隐私政策》'; return; }

        regLoading.value = true;
        try {
          const d = await App.API.request('POST', '/auth/register', {
            role: r.role,
            username: r.username.trim(),
            password: r.password,
            realName: r.realName.trim(),
            orgName: r.orgName.trim(),
            industry: r.industry,
            region: r.region,
            contactPhone: r.contactPhone.trim(),
          }, { noAuth: true, noRedirect: true });
          if (d.pending) {
            /* 核查机构通道：不自动登录，提示等待审核 */
            err.value = '';
            tab.value = 'login';
            App.notify.ok(`注册成功，${d.user.orgName} 的机构账号已提交，管理员审核通过后即可登录`);
            username.value = d.user.username;
            return;
          }
          setSession(d.token, d.user);
          App.notify.ok(`注册成功，欢迎加入碳链通，${d.user.realName || d.user.username}`);
          App.go(roleHome(d.user.role));
        } catch (e) {
          err.value = e.message;
        } finally {
          regLoading.value = false;
        }
      }

      /* ==================== 渲染 ==================== */
      return () => h('div', { class: 'au-page', ref: pageEl }, [
        h('canvas', { class: 'au-net', ref: netEl, 'aria-hidden': 'true' }),

        h('div', { class: 'au-card' }, [
          /* ==================== 左：品牌叙事区 ==================== */
          h('aside', { class: 'au-brand' }, [
            h('a', { class: 'au-back', href: '#/', onClick: (e) => { e.preventDefault(); App.go('/'); } }, [
              h('x-icon', { name: 'chevronLeft', size: 12 }), '返回首页',
            ]),
            h('div', { class: 'au-logo' }, [
              h('span', { class: 'au-logo-mark' }, [h('x-icon', { name: 'leaf', size: 20 })]),
              h('span', { class: 'au-logo-t' }, [h('b', {}, '碳链通'), h('small', {}, 'CarbonChain Hub · 平台端')]),
            ]),
            h('h1', { class: 'au-h1' }, ['工业碳资产动态核算', h('em', {}, '链上可信存证')]),
            h('p', { class: 'au-slogan' }, '让每一吨碳 · 可测量 · 可信赖 · 可核验'),
            h('ul', { class: 'au-perks' }, LOGIN_PERKS.map((p) =>
              h('li', { key: p.t }, [
                h('span', { class: 'au-perk-ico' }, [h('x-icon', { name: p.icon, size: 14 })]),
                h('span', { class: 'au-perk-t' }, [h('b', {}, p.t), h('small', {}, p.d)]),
              ]))),
            h('div', { class: 'au-stats' }, wall.value.map((s) =>
              h('span', { key: s.t }, [h('b', {}, [s.n, h('i', {}, s.u)]), h('small', {}, s.t)]))),
          ]),

          /* ==================== 右：登录 / 注册表单区 ==================== */
          h('main', { class: 'au-form' }, [
            h('div', { class: 'au-form-in' }, [
              h('div', { class: ['au-tabs', tab.value === 'register' ? 'on-reg' : 'on-login'], role: 'tablist' }, [
                h('span', { class: 'au-thumb', 'aria-hidden': 'true' }),
                h('button', {
                  class: ['au-tab', tab.value === 'login' && 'on'], type: 'button', role: 'tab',
                  'aria-selected': tab.value === 'login' ? 'true' : 'false',
                  onClick: () => { tab.value = 'login'; err.value = ''; },
                }, '登录'),
                h('button', {
                  class: ['au-tab', tab.value === 'register' && 'on'], type: 'button', role: 'tab',
                  'aria-selected': tab.value === 'register' ? 'true' : 'false',
                  onClick: () => { tab.value = 'register'; err.value = ''; },
                }, '注册'),
              ]),

              /* ---------- 登录 ---------- */
              tab.value === 'login' ? h('div', { class: 'au-view', key: 'login' }, [
                h('h2', { class: 'au-title' }, '登录工作台'),
                h('p', { class: 'au-sub' }, '企业 · 核查 · 监管 · 管理 · 交易，五类角色统一入口'),
                h('form', {
                  onSubmit: (e) => { e.preventDefault(); submit(); },
                }, [
                  h('div', { class: 'field' }, [
                    h('label', {}, '登录账号'),
                    h('div', { class: 'au-fbox' }, [
                      h('x-icon', { name: 'users', size: 14, class: 'au-fbox-ico' }),
                      h('input', {
                        class: 'input', value: username.value, placeholder: '请输入账号',
                        autocomplete: 'username',
                        onInput: (e) => { username.value = e.target.value; },
                        onKeyup: (e) => { if (e.key === 'Enter') submit(); },
                      }),
                    ]),
                  ]),
                  h('div', { class: 'field' }, [
                    h('label', {}, '登录口令'),
                    h('div', { class: 'au-fbox' }, [
                      h('x-icon', { name: 'lock', size: 14, class: 'au-fbox-ico' }),
                      h('input', {
                        class: 'input', type: pwShow.value ? 'text' : 'password', value: password.value,
                        placeholder: '请输入口令', autocomplete: 'current-password',
                        onInput: (e) => { password.value = e.target.value; },
                        onKeydown: pwKey, onKeyup: pwKey,
                        onBlur: () => { capsOn.value = false; },
                      }),
                      h('button', {
                        class: 'au-eye', type: 'button', title: pwShow.value ? '隐藏口令' : '显示口令',
                        'aria-label': pwShow.value ? '隐藏口令' : '显示口令',
                        onClick: () => { pwShow.value = !pwShow.value; },
                      }, [h('x-icon', { name: pwShow.value ? 'eyeOff' : 'eye', size: 14 })]),
                    ]),
                    capsOn.value ? h('div', { class: 'au-caps' }, [
                      h('x-icon', { name: 'alert', size: 12 }), '大写锁定已开启',
                    ]) : null,
                  ]),
                  err.value && h('div', { class: 'alertbar err au-err' }, [h('x-icon', { name: 'alert', size: 15 }), err.value]),
                  h('button', {
                    class: 'btn primary block lg au-cta', type: 'submit', disabled: loading.value, onClick: submit,
                  }, [
                    h('x-icon', { name: loading.value ? 'refresh' : 'logout', size: 16 }),
                    loading.value ? '正在验证…' : '登 录',
                  ]),

                  /* 演示身份下拉：与主表单解耦，账号数量不影响表单区高度 */
                  accounts.value.length ? h('div', { class: ['au-dd', demoSel.value && 'has-sel'] }, [
                    h('button', {
                      class: 'au-dd-btn', type: 'button', 'aria-expanded': ddOpen.value ? 'true' : 'false',
                      'aria-haspopup': 'listbox',
                      onClick: toggleDd,
                    }, [
                      h('x-icon', {
                        name: (demoSel.value && (ROLE_META[demoSel.value.role] || {}).icon) || 'users',
                        size: 14, class: 'au-dd-ico',
                      }),
                      h('b', { class: 'au-dd-cur' }, demoSel.value
                        ? `${demoSel.value.orgName || demoSel.value.realName || demoSel.value.roleCn}`
                          + (demoSel.value.postCn ? ` · ${demoSel.value.postCn}` : `（${demoSel.value.roleCn}）`)
                        : `选择演示身份，一键填入（${accounts.value.length} 个账号）`),
                      h('x-icon', { name: 'chevronDown', size: 13, class: ['au-dd-chev', ddOpen.value && 'up'] }),
                    ]),
                    ddOpen.value ? h('div', { class: 'au-dd-pop', role: 'listbox', 'aria-label': '演示身份列表' }, [
                      /* 搜索框：账号多了靠滚动找太慢，按账号 / 姓名 / 企业 / 岗位过滤 */
                      h('div', { class: 'au-dd-search' }, [
                        h('x-icon', { name: 'search', size: 13 }),
                        h('input', {
                          class: 'au-dd-search-in', type: 'text', value: ddQuery.value,
                          placeholder: '搜索账号 / 企业 / 岗位',
                          'aria-label': '搜索演示账号',
                          onInput: (e) => { ddQuery.value = e.target.value; },
                          /* 搜索框内回车不应提交登录表单 */
                          onKeydown: (e) => { if (e.key === 'Enter') e.preventDefault(); },
                        }),
                        ddQuery.value ? h('button', {
                          class: 'au-dd-search-x', type: 'button', 'aria-label': '清空搜索',
                          onClick: () => { ddQuery.value = ''; },
                        }, [h('x-icon', { name: 'close', size: 12 })]) : null,
                      ]),
                      h('div', { class: 'au-dd-scroll' },
                        ddTotal.value ? ddGroups.value.map((g) => h('div', { class: 'au-dd-group', key: g.role }, [
                          h('div', { class: 'au-dd-group-h' }, [
                            h('span', { class: 'au-dd-group-t' }, [
                              h('x-icon', { name: g.meta.icon || 'users', size: 12 }),
                              g.roleCn,
                            ]),
                            h('span', { class: 'au-dd-group-d' }, g.meta.d || ''),
                            h('span', { class: 'au-dd-group-n' }, g.count),
                          ]),
                          g.orgs.map((o) => h('div', { class: 'au-dd-org', key: o.name }, [
                            g.showOrg ? h('div', { class: 'au-dd-org-h', title: o.name }, o.name) : null,
                            o.items.map((a) => h('button', {
                              class: ['au-dd-item', demoSel.value && demoSel.value.username === a.username && 'on'],
                              type: 'button', role: 'option',
                              'aria-selected': demoSel.value && demoSel.value.username === a.username ? 'true' : 'false',
                              onClick: () => useAccount(a),
                            }, [
                              h('span', { class: 'au-dd-item-t' }, [
                                h('b', {}, a.postCn || a.realName || a.roleCn),
                                h('small', {}, `${a.username} / ${a.password}`),
                              ]),
                              /* 姓名只在它与岗位名不同时才显示 —— 多数岗位账号的
                               * realName 就是岗位名（如「排放填报员」），再列一遍
                               * 只会让每行读起来像重复了两次。 */
                              a.realName && a.postCn && a.realName !== a.postCn
                                ? h('span', { class: 'au-dd-item-who' }, a.realName) : null,
                            ])),
                          ])),
                        ])) : h('div', { class: 'au-dd-empty' }, '没有匹配的账号'),
                      ),
                    ]) : null,
                  ]) : h('div', { class: 'alertbar warn au-err' }, [
                    h('x-icon', { name: 'alert', size: 15 }),
                    demoClosed.value
                      ? '当前环境未开放演示账号（DEMO_ACCOUNTS 未开启）。新企业可在「注册」页开户。'
                      : '未读取到演示账号，请确认后端服务已启动且数据库已初始化。',
                  ]),

                  h('p', { class: 'au-foot' }, [
                    '没有账号？',
                    h('a', { onClick: (e) => { e.preventDefault(); tab.value = 'register'; err.value = ''; } },
                      '注册企业 / 机构接入'),
                  ]),
                ]),
              ]) : null,

              /* ---------- 注册（账号信息 / 企业信息两段分组） ---------- */
              tab.value === 'register' ? h('div', { class: 'au-view', key: 'register' }, [
                h('h2', { class: 'au-title' }, '注册接入'),
                h('p', { class: 'au-sub' }, isVerifierReg.value
                  ? '核查机构实名注册：提交后由平台管理员审核，通过后方可登录开展核查业务'
                  : '注册即创建企业档案与账号，自动进入企业工作台开始核算'),
                h('div', { class: 'au-roles', role: 'radiogroup', 'aria-label': '注册类型' }, [
                  h('label', { class: ['au-role', !isVerifierReg.value && 'on'] }, [
                    h('input', {
                      type: 'radio', name: 'reg-role', checked: !isVerifierReg.value,
                      onChange: () => { reg.value.role = 'ENTERPRISE'; },
                    }),
                    h('span', {}, ['控排企业', h('em', {}, '注册即开户')]),
                  ]),
                  h('label', { class: ['au-role', isVerifierReg.value && 'on'] }, [
                    h('input', {
                      type: 'radio', name: 'reg-role', checked: isVerifierReg.value,
                      onChange: () => { reg.value.role = 'VERIFIER'; },
                    }),
                    h('span', {}, ['核查机构', h('em', {}, '注册后审核准入')]),
                  ]),
                ]),
                h('form', {
                  onSubmit: (e) => { e.preventDefault(); submitRegister(); },
                }, [
                  h('div', { class: 'au-group' }, [
                    h('div', { class: 'au-group-t' }, '账号信息'),
                    h('div', { class: 'au-reg-grid' }, [
                      h('div', { class: 'field' }, [
                        h('label', {}, '登录账号 *'),
                        h('input', { class: 'input', value: reg.value.username, placeholder: '3-30 位字母 / 数字 / 下划线',
                          onInput: (e) => { reg.value.username = e.target.value; } }),
                      ]),
                      h('div', { class: 'field' }, [
                        h('label', {}, '联系人姓名 *'),
                        h('input', { class: 'input', value: reg.value.realName, placeholder: '企业联系人',
                          onInput: (e) => { reg.value.realName = e.target.value; } }),
                      ]),
                      h('div', { class: 'field' }, [
                        h('label', {}, '登录密码 *'),
                        h('input', { class: 'input', type: 'password', value: reg.value.password, placeholder: '至少 6 位',
                          onInput: (e) => { reg.value.password = e.target.value; } }),
                      ]),
                      h('div', { class: 'field' }, [
                        h('label', {}, '确认密码 *'),
                        h('input', { class: 'input', type: 'password', value: reg.value.password2, placeholder: '再次输入密码',
                          onInput: (e) => { reg.value.password2 = e.target.value; } }),
                      ]),
                    ]),
                  ]),
                  h('div', { class: 'au-group' }, [
                    h('div', { class: 'au-group-t' }, isVerifierReg.value ? '机构信息' : '企业信息'),
                    h('div', { class: 'field' }, [
                      h('label', {}, isVerifierReg.value ? '机构名称 *' : '企业名称 *'),
                      h('input', { class: 'input', value: reg.value.orgName, placeholder: isVerifierReg.value ? '核查机构全称（如：XX碳排放核查有限公司）' : '营业执照上的企业全称',
                        onInput: (e) => { reg.value.orgName = e.target.value; } }),
                    ]),
                    !isVerifierReg.value && h('div', { class: 'au-reg-grid' }, [
                      h('div', { class: 'field' }, [
                        h('label', {}, '所属行业 *'),
                        h('select', { class: 'select', value: reg.value.industry,
                          onChange: (e) => { reg.value.industry = e.target.value; } }, [
                          h('option', { value: '' }, '请选择'),
                          ...INDUSTRIES.map((x) => h('option', { value: x }, x)),
                        ]),
                      ]),
                      h('div', { class: 'field' }, [
                        h('label', {}, '所在省份 *'),
                        h('select', { class: 'select', value: reg.value.region,
                          onChange: (e) => { reg.value.region = e.target.value; } }, [
                          h('option', { value: '' }, '请选择'),
                          ...REGIONS.map((x) => h('option', { value: x }, x)),
                        ]),
                      ]),
                    ]),
                    isVerifierReg.value && h('div', { class: 'field' }, [
                      h('label', {}, '机构所在省份 *'),
                      h('select', { class: 'select', value: reg.value.region,
                        onChange: (e) => { reg.value.region = e.target.value; } }, [
                        h('option', { value: '' }, '请选择'),
                        ...REGIONS.map((x) => h('option', { value: x }, x)),
                      ]),
                    ]),
                    h('div', { class: 'field' }, [
                      h('label', {}, '联系电话'),
                      h('input', { class: 'input', value: reg.value.contactPhone, placeholder: '选填，便于核查机构联络',
                        onInput: (e) => { reg.value.contactPhone = e.target.value; } }),
                    ]),
                  ]),
                  err.value && h('div', { class: 'alertbar err au-err' }, [h('x-icon', { name: 'alert', size: 15 }), err.value]),
                  h('label', { class: 'au-agree' }, [
                    h('input', {
                      type: 'checkbox', checked: regAgree.value,
                      onChange: (e) => { regAgree.value = e.target.checked; },
                    }),
                    h('span', {}, [
                      '我已阅读并同意',
                      h('a', { class: 'au-link', onClick: (e) => { e.preventDefault(); agreeModal.value = true; } }, '《用户协议》'),
                      '与',
                      h('a', { class: 'au-link', onClick: (e) => { e.preventDefault(); agreeModal.value = true; } }, '《隐私政策》'),
                    ]),
                  ]),
                  h('button', {
                    class: 'btn primary block lg au-cta', type: 'submit', disabled: regLoading.value, onClick: submitRegister,
                  }, [
                    h('x-icon', { name: regLoading.value ? 'refresh' : 'factory', size: 16 }),
                    regLoading.value
                      ? '正在提交注册…'
                      : (isVerifierReg.value ? '提交机构注册申请' : '注 册 企 业'),
                  ]),
                  h('p', { class: 'tiny dim au-note' },
                    isVerifierReg.value
                      ? '机构账号需管理员审核通过后开通（第三方准入）。注册信息与审核动作均计入操作审计日志。'
                      : '注册产生的账号为企业端角色，注册即开户；核查机构请选择「核查机构」通道（审核准入）。注册信息将计入操作审计日志。'),
                ]),
              ]) : null,
            ]),
          ]),
        ]),

        /* ==================== 协议摘要弹窗 ==================== */
        agreeModal.value ? h('div', { class: 'au-modal-mask', onClick: () => { agreeModal.value = false; } }, [
          h('div', { class: 'au-modal', onClick: (e) => e.stopPropagation() }, [
            h('div', { class: 'au-modal-head' }, [
              h('b', {}, '用户协议与隐私政策（摘要）'),
              h('button', { class: 'au-modal-x', onClick: () => { agreeModal.value = false; } }, '✕'),
            ]),
            h('div', { class: 'au-modal-body' }, [
              h('h4', {}, '用户协议'),
              h('p', {}, '① 平台账号仅限本企业使用，不得出借、转让；② 企业应保证上报数据真实准确，虚假申报将计入碳信用分并承担相应责任；③ 平台提供核算、存证、交易辅助功能，不替代法定核查结论；④ 违规使用账号或恶意篡改数据，平台有权终止服务并留存审计证据。'),
              h('h4', {}, '隐私政策'),
              h('p', {}, '① 平台采集的数据仅用于碳排放核算、存证与监管报送，不作任何商业转售；② 原始监测明细仅企业与获授权的核查、监管方可查看，公众可见内容仅为汇总口径；③ 全部操作写入审计日志哈希链，任何查看与修改留痕可溯；④ 注册信息（企业名称、联系人、地区）用于建立企业档案与合规联络。'),
            ]),
            h('button', { class: 'btn primary block', onClick: () => { regAgree.value = true; agreeModal.value = false; } }, '我已阅读并同意'),
          ]),
        ]) : null,
      ]);
    },
  });

  App.views = App.views || {};
  App.views['page-login'] = PageLogin;
})();
