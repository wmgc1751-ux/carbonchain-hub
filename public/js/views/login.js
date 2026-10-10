/* =====================================================================
   登录页
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, onMounted, computed } = Vue;
  const h = App.h;

  const ROLE_HOME = {
    ENTERPRISE: '/ent/overview',
    VERIFIER: '/ver/overview',
    REGULATOR: '/reg/overview',
    ADMIN: '/reg/overview',
  };

  /* Hero 背景视频：已验证可用的直链（原 preview 路径已返回 403，作为兜底保留） */
  const HERO_VIDEO = 'https://assets.mixkit.co/videos/41484/41484-720.mp4';
  const HERO_VIDEO_FALLBACK = 'https://assets.mixkit.co/videos/preview/mixkit-digital-animation-of-screens-41484-large.mp4';
  const HERO_POSTER = 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1600&q=80';

  /* Bento Grid：4 块不对称核心能力卡片（背景图 + 动态数据徽章） */
  const BENTO = [
    {
      span: 'lg',
      img: 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?auto=format&fit=crop&w=1200&q=80',
      tag: 'Scope 1 / 2 / 3 实时接入',
      title: '碳排因子与多源数据采集',
      desc: '对接 IoT 智能电表、CEMS 在线监测与 ERP 物料台账，按权威排放因子库自动折算，多源数据统一入湖、分钟级同步。',
    },
    {
      span: 'md',
      img: 'https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?auto=format&fit=crop&w=1200&q=80',
      tag: 'ISO-14067 合规认证',
      title: '智能核算与低碳供应链',
      desc: '生命周期 LCA 核算引擎覆盖范围一 / 二 / 三，自动生成核算底稿与减排建议。',
    },
    {
      span: 'md',
      img: 'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?auto=format&fit=crop&w=1200&q=80',
      tag: '哈希验证通过',
      title: '链上可信存证与防篡改',
      desc: 'SHA-256 哈希链 + Merkle 树 + secp256k1 签名，任何改动都会导致全链校验失败。',
    },
    {
      span: 'wide',
      img: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80',
      tag: 'CBAM 就绪',
      title: '国际合规与 CBAM 报告生成',
      desc: '一键导出欧盟碳边境调节机制申报数据包与第三方可核验的存证证书。',
    },
  ];

  /* Carbon Flow：端到端碳链溯源流程轴 */
  const FLOW = [
    { icon: 'db', t: 'IoT / ERP 数据采集' },
    { icon: 'chart', t: '生命周期 LCA 智能核算' },
    { icon: 'block', t: '节点共识哈希上链' },
    { icon: 'shield', t: 'CBAM 报告 / 存证证书' },
  ];

  const PageLogin = defineComponent({
    name: 'page-login',
    setup() {
      const username = ref('');
      const password = ref('');
      const loading = ref(false);
      const accounts = ref([]);
      const demoClosed = ref(false); // 演示账号接口被服务端按安全策略关闭（线上默认）
      const err = ref('');
      const pact = ref(null);

      onMounted(async () => {
        try {
          accounts.value = await App.API.request('GET', '/auth/demo-accounts', null, { noAuth: true });
        } catch (e) {
          // 提示语含「关闭」= 服务端按安全策略关闭了该接口（线上默认），并非服务异常
          if (e && /关闭/.test(e.message || '')) demoClosed.value = true;
        }
        try {
          pact.value = await App.API.get('/chain/stats');
        } catch (e) { /* ignore */ }
        if (App.Store.user && App.Store.token) {
          App.go(ROLE_HOME[App.Store.user.role] || '/screen');
        }
      });

      function useAccount(a) {
        username.value = a.username;
        password.value = a.password;
        err.value = '';
      }

      async function submit() {
        if (!username.value || !password.value) { err.value = '请输入账号与密码'; return; }
        loading.value = true; err.value = '';
        try {
          const d = await App.API.request('POST', '/auth/login', { username: username.value, password: password.value }, { noRedirect: true });
          setSession(d.token, d.user);
          App.notify.ok(`欢迎回来，${d.user.realName || d.user.username}（${d.user.roleCn}）`);
          App.go(ROLE_HOME[d.user.role] || '/screen');
        } catch (e) {
          err.value = e.message;
        } finally {
          loading.value = false;
        }
      }

      return () => h('div', { class: 'login' }, [
        /* 左：品牌区 */
        h('div', { class: 'login-hero' }, [
          /* ---------- Hero 首屏：沉浸式科技多媒体背景 ---------- */
          h('section', { class: 'hero' }, [
            h('div', { class: 'hero-media' }, [
              h('video', {
                class: 'hero-video', autoplay: true, muted: true, loop: true,
                playsinline: true, preload: 'auto', poster: HERO_POSTER,
              }, [
                h('source', { src: HERO_VIDEO, type: 'video/mp4' }),
                h('source', { src: HERO_VIDEO_FALLBACK, type: 'video/mp4' }),
              ]),
              h('div', { class: 'hero-mask' }),
            ]),
            h('div', { class: 'hero-inner' }, [
              h('div', { class: 'hero-brand' }, [
                h('div', { class: 'brand-logo' }, [h('img', { src: './img/logo-mark.png', alt: '碳链通 CarbonChain Hub' })]),
                h('div', { class: 'brand-txt' }, [
                  h('strong', {}, '碳链通 CarbonChain Hub'),
                  h('span', {}, 'Blockchain · Carbon · Compliance'),
                ]),
              ]),
              h('h1', { class: 'hero-title' }, [
                '让每一克碳足迹，', h('br'), h('em', {}, '都有迹可循'),
              ]),
              h('p', { class: 'hero-sub' },
                '基于区块链的供应链碳数据要素流通平台 —— 排放数据、核查结论、配额划转与成交清算全部上链，形成不可篡改、可公开核验的碳数据账本。'),
              h('div', { class: 'hero-cta' }, [
                h('button', { class: 'cta cta-primary', onClick: () => App.go('/screen') }, [
                  h('x-icon', { name: 'globe', size: 16 }), '进入数据公示大屏',
                ]),
                h('button', { class: 'cta cta-ghost', onClick: () => App.go('/explorer') }, [
                  h('x-icon', { name: 'block', size: 16 }), '查看链上存证',
                ]),
              ]),
              h('div', { class: 'hero-chain' }, [
                h('span', { class: 'chip live' }, [
                  h('x-icon', { name: 'chain', size: 14 }),
                  pact.value ? `链高度 ${pact.value.height} · ${App.fmt.num(pact.value.totalTxs)} 笔存证` : '节点连接中…',
                ]),
              ]),
            ]),
          ]),

          /* ---------- Core Capabilities：Bento Grid ---------- */
          h('section', { class: 'sec' }, [
            h('div', { class: 'sec-head' }, [
              h('h2', {}, '核心能力'),
              h('p', {}, '从物理计量到跨境合规申报，端到端打通的碳数据要素基础设施。'),
            ]),
            h('div', { class: 'bento-grid' }, BENTO.map((b) => h('article', { class: ['bento-item', b.span] }, [
              h('div', { class: 'bento-bg', style: `background-image:url("${b.img}")` }),
              h('div', { class: 'bento-veil' }),
              h('div', { class: 'bento-body' }, [
                h('span', { class: 'bento-tag' }, [h('i', { class: 'dot' }), b.tag]),
                h('h3', {}, b.title),
                h('p', {}, b.desc),
              ]),
            ]))),
          ]),

          /* ---------- Carbon Flow：端到端碳链溯源流程轴 ---------- */
          h('section', { class: 'sec' }, [
            h('div', { class: 'sec-head' }, [
              h('h2', {}, '端到端碳链溯源'),
              h('p', {}, '一次采集、全程留痕：从物理计量到跨境合规申报的完整证据链。'),
            ]),
            h('div', { class: 'flow-track' }, FLOW.flatMap((f, i) => {
              const node = h('div', { class: 'flow-node' }, [
                h('div', { class: 'flow-ico' }, [h('x-icon', { name: f.icon, size: 18 })]),
                h('div', { class: 'flow-txt' }, f.t),
              ]);
              return i < FLOW.length - 1 ? [node, h('i', { class: 'flow-link' })] : [node];
            })),
          ]),
        ]),

        /* 右：登录表单 */
        h('div', { class: 'login-panel' }, [
          h('div', { class: 'login-card' }, [
            h('h3', {}, '登录平台'),
            h('p', { class: 'muted tiny mt-8' }, '请选择下方任一演示身份，或手动输入账号密码'),

            h('div', { class: 'mt-20' }, [
              h('div', { class: 'field' }, [
                h('label', {}, '登录账号'),
                h('input', {
                  class: 'input', value: username.value, placeholder: '请输入账号',
                  onInput: (e) => { username.value = e.target.value; },
                  onKeyup: (e) => { if (e.key === 'Enter') submit(); },
                }),
              ]),
              h('div', { class: 'field' }, [
                h('label', {}, '登录口令'),
                h('input', {
                  class: 'input', type: 'password', value: password.value, placeholder: '请输入口令',
                  onInput: (e) => { password.value = e.target.value; },
                  onKeyup: (e) => { if (e.key === 'Enter') submit(); },
                }),
              ]),
              err.value && h('div', { class: 'alertbar err mb-12' }, [h('x-icon', { name: 'alert', size: 15 }), err.value]),
              h('button', {
                class: 'btn primary block lg', disabled: loading.value, onClick: submit,
              }, [
                h('x-icon', { name: loading.value ? 'refresh' : 'logout', size: 16 }),
                loading.value ? '正在验证…' : '登 录',
              ]),
            ]),

            h('div', { class: 'divider' }, '演示账号一键切换'),

            h('div', { class: 'quick-roles' }, accounts.value.map((a) => h('div', {
              class: ['qr', username.value === a.username && 'on'], onClick: () => useAccount(a),
            }, [
              h('b', {}, (a.orgName || a.realName || a.roleCn)),
              h('span', {}, `${a.username} / ${a.password} · ${a.roleCn}`),
            ]))),

            accounts.value.length === 0 && h('div', { class: 'alertbar warn' },
              [h('x-icon', { name: 'alert', size: 15 }),
                demoClosed.value
                  ? '当前为线上环境，演示账号列表已按安全策略关闭（不对外泄露口令）。请使用已知账号登录。'
                  : '未读取到演示账号，请确认后端服务已启动且数据库已初始化。']),

            h('div', { class: 'mt-20 flex gap-8 wrap' }, [
              h('button', { class: 'btn ghost sm', onClick: () => App.go('/screen') }, [
                h('x-icon', { name: 'globe', size: 14 }), '进入数据公示大屏',
              ]),
              h('button', { class: 'btn ghost sm', onClick: () => App.go('/explorer') }, [
                h('x-icon', { name: 'block', size: 14 }), '区块链浏览器',
              ]),
            ]),
          ]),
        ]),
      ]);
    },
  });

  App.views = App.views || {};
  App.views['page-login'] = PageLogin;
})();
