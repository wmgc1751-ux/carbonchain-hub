/* =====================================================================
   settings-panel.js —— 显示与偏好设置面板（【新增增强】2026-10-25）
   ---------------------------------------------------------------------
   【为什么单独一个文件】
   app.js 已经 56 KB，"外壳 + 路由 + 顶栏 + 侧栏 + 弹窗"全挤在一起。
   设置面板是一个**自包含**功能（自己管状态、自己渲染、自己持久化），
   再往 app.js 里塞只会让它更难读。按"拆臃肿模块"的原则独立成文件。

   【为什么放在抽屉里而不是新页面】
   它改的是"当前页怎么显示"。跳页面去改设置，改完还得跳回来，
   改完的效果也看不见 —— 抽屉在旁边打开，调一下就能看到表格行高变了。

   【持久化】
   全部走 App.setPref（core.js 九·七），写入 localStorage.cch_prefs。
   只影响本机浏览器，不上传服务端，也不影响其他账号 —— 这点必须在界面上写明，
   否则用户会以为"我把全平台字号改小了"。
   ===================================================================== */
(function () {
  'use strict';
  const { defineComponent, ref, computed } = Vue;
  /* ⚠ 必须用 App.h：字符串标签 'x-drawer' 交给 Vue.h 会渲染成空的自定义元素 */
  const h = App.h;

  /* ------------------------------------------------------------------
   * 单例状态
   * ------------------------------------------------------------------ */
  const open = ref(false);
  const tab = ref('display');   // display | advanced | extend

  function openSettings() { open.value = true; }
  function closeSettings() { open.value = false; }
  function toggleSettings() { open.value = !open.value; }

  /* ------------------------------------------------------------------
   * 渲染原子
   * ------------------------------------------------------------------ */
  /** 分段选择器：点击即生效，不需要"保存"按钮 —— 效果立刻可见，保存是多余的仪式 */
  function seg(label, cur, opts, onPick, tip) {
    return h('div', { class: 'set-row' }, [
      h('div', { class: 'set-lbl', title: tip || '' }, label),
      h('div', { class: 'seg' }, opts.map((o) => h('button', {
        type: 'button',
        class: ['seg-i', cur === o.value && 'on'],
        onClick: () => onPick(o.value),
      }, o.label))),
    ]);
  }

  /** 开关行 */
  function sw(label, on, onToggle, tip) {
    return h('div', { class: 'set-row' }, [
      h('div', { class: 'set-lbl', title: tip || '' }, label),
      h('button', {
        type: 'button',
        class: ['sw', on && 'on'],
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label,
        onClick: () => onToggle(!on),
      }, [h('i')]),
    ]);
  }

  function group(title, sub, children) {
    return h('div', { class: 'set-group' }, [
      h('div', { class: 'set-group-head' }, [
        h('h4', {}, title),
        sub ? h('span', { class: 'tiny dim' }, sub) : null,
      ]),
      ...children,
    ]);
  }

  /* ------------------------------------------------------------------
   * 扩展位（【扩展预埋】）
   * ------------------------------------------------------------------
   * 只放"入口 + 说明"，不放假按钮：点了就说"尚未开通"。
   * 为什么不做成可点的假流程 —— 答辩现场点进去一个空壳，
   * 比明确写"规划中"更伤可信度。
   * ------------------------------------------------------------------ */
  const EXTENSIONS = [
    { key: 'cn', name: '第三方核查机构系统', desc: '对接核查机构出具的报告编号与结论，实现报告与存证双向核对' },
    { key: 'cems', name: '企业侧 CEMS 直连', desc: '标准 HJ 212-2017 报文上行，当前设备通道已就绪（9100）' },
    { key: 'reg', name: '地方碳市场注册登记系统', desc: '配额分配与清缴结果回传，避免双轨台账' },
    { key: 'plugin', name: '自定义数据源插件', desc: '按统一适配器协议接入企业内部系统（ERP / MES / 能耗采集）' },
  ];

  function renderExtensions() {
    return [
      h('div', { class: 'set-group' }, [
        h('div', { class: 'set-group-head' }, [
          h('h4', {}, '扩展对接'),
          h('span', { class: 'tiny dim' }, '规划中 · 不改变现有功能'),
        ]),
        ...EXTENSIONS.map((e) => h('div', { class: 'ext-row', title: '尚未开通' }, [
          h('div', { class: 'ext-ico' }, [h('x-icon', { name: 'link', size: 15 })]),
          h('div', { class: 'ext-tx' }, [
            h('div', { class: 'ext-nm' }, e.name),
            h('div', { class: 'tiny dim' }, e.desc),
          ]),
          h('span', { class: 'tag t-mute' }, '规划中'),
        ])),
      ]),
      h('p', { class: 'set-note' },
        '以上对接位只预留入口与说明，未接任何外部系统。当前平台所有数据来源见「数据真实性」页面，可逐条核查。'),
    ];
  }

  /* ------------------------------------------------------------------
   * 组件
   * ------------------------------------------------------------------ */
  const SettingsPanel = defineComponent({
    name: 'settings-panel',
    setup() {
      const p = App.prefs;

      const TABS = [
        { key: 'display', label: '显示' },
        { key: 'advanced', label: '高级' },
        { key: 'extend', label: '扩展' },
      ];

      function resetAll() {
        ['density', 'font', 'nav', 'contrast', 'motion'].forEach((k) => {
          const d = { density: 'normal', font: 'normal', nav: 'expanded', contrast: 'normal', motion: 'on' }[k];
          App.setPref(k, d);
        });
        App.notify.ok('已恢复默认显示设置');
      }

      return () => {
        const body = [];

        if (tab.value === 'display') {
          body.push(group('信息密度', '同一屏能多看几行', [
            seg('表格行高', p.density, [
              { value: 'compact', label: '紧凑' },
              { value: 'normal', label: '标准' },
              { value: 'loose', label: '宽松' },
            ], (v) => App.setPref('density', v), '紧凑档一屏可多显示 4–6 行'),
            seg('字号', p.font, [
              { value: 'sm', label: '小' },
              { value: 'normal', label: '标准' },
              { value: 'lg', label: '大' },
            ], (v) => App.setPref('font', v), '与「投屏模式」互不影响，可叠加'),
            seg('侧边栏', p.nav, [
              { value: 'expanded', label: '展开' },
              { value: 'collapsed', label: '收起' },
            ], (v) => App.setPref('nav', v), '收起后仅显示图标，正文区更宽'),
          ]));

          body.push(group('可读性', '投影 / 强光 / 低配机器', [
            seg('对比度', p.contrast, [
              { value: 'normal', label: '标准' },
              { value: 'more', label: '高对比' },
            ], (v) => App.setPref('contrast', v), '提亮最弱一级辅助文字，适合投影与室外'),
            seg('动效', p.motion, [
              { value: 'on', label: '开启' },
              { value: 'off', label: '关闭' },
            ], (v) => App.setPref('motion', v), '关闭后去掉过渡与入场动画，减少低配设备掉帧'),
          ]));
        }

        if (tab.value === 'advanced') {
          body.push(group('功能开关', '出问题时可单独关闭，不必整站回滚', [
            sw('表格批量选择与 CSV 导出', App.flag('table.batch'), (v) => {
              App.setFlag('table.batch', v);
              App.notify.info('已' + (v ? '开启' : '关闭') + '，刷新后生效');
            }, '关闭后所有表格恢复为无复选列的原始形态'),
            sw('命令面板（⌘K）', App.flag('shell.cmdk'), (v) => {
              App.setFlag('shell.cmdk', v);
              App.notify.info('已' + (v ? '开启' : '关闭') + '，刷新后生效');
            }, '关闭后顶栏入口与快捷键同时失效'),
            sw('路由切换过渡', App.flag('shell.turb'), (v) => {
              App.setFlag('shell.turb', v);
              App.notify.info('已' + (v ? '开启' : '关闭') + '，刷新后生效');
            }, '仅影响切页时的 120ms 淡入'),
          ]));

          body.push(h('div', { class: 'set-group' }, [
            h('div', { class: 'set-group-head' }, [h('h4', {}, '操作')]),
            h('div', { class: 'set-acts' }, [
              h('button', { class: 'btn sm ghost', onClick: () => { closeSettings(); App.palette && App.palette.toggleHelp(); } }, [
                h('x-icon', { name: 'command', size: 14 }), '查看快捷键',
              ]),
              h('button', { class: 'btn sm ghost', onClick: () => location.reload() }, [
                h('x-icon', { name: 'refresh', size: 14 }), '刷新页面',
              ]),
              h('button', { class: 'btn sm ghost', onClick: resetAll }, '恢复默认显示'),
            ]),
          ]));

          body.push(h('p', { class: 'set-note' },
            '开关状态保存在本机浏览器（localStorage.cch_flags）。需要复现某次问题时，可在地址后追加 ?flags=-table.batch 临时关闭对应能力。'));
        }

        if (tab.value === 'extend') body.push(...renderExtensions());

        return h('x-drawer', {
          modelValue: open.value,
          title: '显示与偏好',
          sub: '仅保存在本机浏览器 · 不上传 · 不影响他人',
          width: '430px',
          'onUpdate:modelValue': (v) => { open.value = v; },
        }, {
          default: () => [
            h('div', { class: 'set-tabs' }, TABS.map((t) => h('button', {
              type: 'button',
              class: ['set-tab', tab.value === t.key && 'on'],
              onClick: () => { tab.value = t.key; },
            }, t.label))),
            ...body,
          ],
          footer: () => [
            h('button', { class: 'btn sm ghost', onClick: closeSettings }, '关闭'),
          ],
        });
      };
    },
  });

  App.SettingsPanel = SettingsPanel;
  App.settings = { open, openSettings, closeSettings, toggleSettings };
})();
