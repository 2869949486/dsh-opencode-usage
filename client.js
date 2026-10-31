window.__ModuleLoader__.load({
  id: '@local/dsh-opencode-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const money = (value) => {
      if (value === undefined || value === null) return '—';
      if (value === 'free') return '免费';
      if (value === Infinity) return '免费';
      return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
    };
    const tokens = (n) => (n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    const percent = (used, limit) => {
      if (limit === undefined || limit === null) return '—';
      if (limit === Infinity || limit === 'free') return '免费';
      if (!limit) return '—';
      const ratio = (used / limit) * 100;
      return `${ratio < 10 ? ratio.toFixed(1) : ratio.toFixed(0)}%`;
    };

    const cell = (content, extra) =>
      h('td', { style: { padding: '5px 10px', borderBottom: '1px solid rgba(127,127,127,.22)', whiteSpace: 'nowrap', ...extra } }, content);

    function UsageSection() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null });

      const load = React.useCallback(async (force) => {
        setState((previous) => ({ ...previous, phase: previous.data ? 'refreshing' : 'loading' }));
        try {
          const response = await fetch(`/opencode-usage.json${force ? '?refresh=1' : ''}`, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          setState({ phase: 'ready', data, error: null });
        } catch (error) {
          setState((previous) => ({ phase: 'error', data: previous.data, error: String(error?.message ?? error) }));
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        const run = (force) => {
          if (!alive) return;
          void load(force);
        };
        run(false);
        const timer = setInterval(() => run(false), 60000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [load]);

      const data = state.data;
      const rows = (data?.models ?? []).map((row) =>
        h('tr', { key: row.model },
          cell(h('span', { style: { fontFamily: 'ui-monospace, Consolas, monospace' } }, row.model)),
          cell(row.requests),
          cell(`${tokens(row.input + row.cacheRead)} / ${tokens(row.output)}`),
          cell(`${money(row.rolling)} / ${money(row.rollingLimit)}`),
          cell(`${money(row.weekly)} / ${money(row.weeklyLimit)}`),
          cell(`${money(row.monthly)} / ${money(row.limit)}`),
          cell(money(row.remaining), { fontWeight: 600 }),
        ),
      );

      const usage = data?.usage;
      const planNote = data
        ? data.detectedPlan && data.detectedPlan !== data.configuredPlan
          ? `检测到套餐变化：${data.configuredPlan} → ${data.detectedPlan}`
          : `套餐：${data.plan}`
        : '';

      return h('div', { style: { padding: '0 2px 24px', color: 'inherit' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, margin: '2px 0 10px', flexWrap: 'wrap' } },
          h('div', { style: { fontWeight: 600, fontSize: 15 } }, 'OpenCode Go 用量'),
          usage && h('span', { style: { opacity: .7, fontSize: 12 } },
            `官方：5 小时 ${usage.rolling?.percent ?? '?'}% · 本周 ${usage.weekly?.percent ?? '?'}% · 本月 ${usage.monthly?.percent ?? '?'}%`),
          h('span', { style: { opacity: .7, fontSize: 12 } }, planNote),
          h('span', { style: { flex: 1 } }),
          data && h('span', { style: { opacity: .6, fontSize: 12 } }, `更新：${new Date(data.checkedAt).toLocaleTimeString()}`),
          h('button', {
            type: 'button',
            onClick: () => void load(true),
            disabled: state.phase === 'loading' || state.phase === 'refreshing',
            style: {
              padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(127,127,127,.45)',
              background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: 13,
            },
          }, state.phase === 'refreshing' ? '刷新中…' : '立即刷新'),
        ),
        state.error && h('div', { style: { color: '#d9534f', fontSize: 13, marginBottom: 8 } },
          `读取失败：${state.error}（确认 opencode-usage 插件已启用）`),
        !data && state.phase === 'loading' && h('div', { style: { opacity: .6, fontSize: 13 } }, '加载中…'),
        data && h('div', { style: { overflowX: 'auto', maxHeight: '62vh', overflowY: 'auto' } },
          h('table', { style: { borderCollapse: 'collapse', width: '100%', fontSize: 13 } },
            h('thead', null,
              h('tr', null,
                ['模型', '请求', '输入/输出 tokens', '5 小时', '本周', '本月', '本月剩余'].map((title) =>
                  h('th', {
                    key: title,
                    style: {
                      textAlign: 'left', padding: '6px 10px', position: 'sticky', top: 0,
                      background: 'var(--dsh-surface, rgba(127,127,127,.08))', backdropFilter: 'blur(4px)',
                      borderBottom: '1px solid rgba(127,127,127,.3)', fontWeight: 600, whiteSpace: 'nowrap',
                    },
                  }, title),
                ),
              ),
            ),
            h('tbody', null, rows),
          ),
        ),
        h('div', { style: { opacity: .55, fontSize: 12, marginTop: 10 } },
          '金额按离峰价估算；DeepSeek 模型峰时（UTC 周一至周五 01–04、06–10）按 2 倍。免费模型不计费；数据来自本机会话日志。'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'opencode-usage', order: 18, label: 'OpenCode 用量' }, UsageSection),
        );
      },
    };
  },
});
