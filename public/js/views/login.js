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
          h('div', { class: 'flex gap-12 mb-16' }, [
            h('div', { class: 'brand-mark' }, [h('x-icon', { name: 'leaf', size: 21 })]),
            h('div', { class: 'brand-txt' }, [
              h('strong', {}, '碳链通 CarbonChain Hub'),
              h('span', {}, 'Blockchain · Carbon · Compliance'),
            ]),
          ]),
          h('h1', { class: 'hero-title' }, ['让每一吨碳排', h('br'), '都可被', h('em', {}, '追溯与信任')]),
          h('p', { class: 'hero-sub' },
            '面向全国碳排放权交易市场的企业碳足迹存证与配额交易一体化平台。排放数据、核查结论、配额划转与成交清算全部上链，形成不可篡改、可公开核验的碳数据账本。'),

          h('div', { class: 'hero-points' }, [
            h('div', { class: 'hero-point' }, [
              h('div', { class: 'n' }, '01'),
              h('div', {}, [
                h('b', {}, '数据上链存证 · 一改就露馅'),
                h('p', {}, 'SHA-256 哈希链 + Merkle 树 + secp256k1 数字签名，任何篡改都会导致全链校验失败。'),
              ]),
            ]),
            h('div', { class: 'hero-point' }, [
              h('div', { class: 'n' }, '02'),
              h('div', {}, [
                h('b', {}, '四方协同 · 企业 / 核查 / 监管 / 公众'),
                h('p', {}, '排放上报由企业签名，核查结论由机构签名，配额分配由监管签名，职责分离、各留痕迹。'),
              ]),
            ]),
            h('div', { class: 'hero-point' }, [
              h('div', { class: 'n' }, '03'),
              h('div', {}, [
                h('b', {}, '配额交易撮合与链上清算'),
                h('p', {}, '价格优先、时间优先连续撮合，成交即存证，账实相符、可审计。'),
              ]),
            ]),
          ]),

          h('div', { class: 'hero-chain' }, [
            h('span', { class: 'hero-block' }, '#1542'),
            h('span', { class: 'hero-arrow' }, '→'),
            h('span', { class: 'hero-block' }, '#1543'),
            h('span', { class: 'hero-arrow' }, '→'),
            h('span', { class: 'hero-block' }, '#1544'),
            h('span', { class: 'hero-arrow' }, '→'),
            h('span', { class: 'hero-block' }, '#1545'),
            h('span', {
              class: 'chip live', style: 'margin-left:8px',
            }, [
              h('x-icon', { name: 'chain', size: 14 }),
              pact.value ? `链高度 ${pact.value.height} · ${App.fmt.num(pact.value.totalTxs)} 笔存证` : '节点连接中…',
            ]),
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
