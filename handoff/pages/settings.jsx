// settings.jsx — Settings hub: Profile, Users, MCP, Theme. Four directions.

// =============================================================================
// V4 — Aurora
// =============================================================================
const SettingsV4 = () => {
  const sections = [
    { id: 'profile', label: 'Profile', icon: 'people', active: true },
    { id: 'workspace', label: 'Workspace', icon: 'box' },
    { id: 'users', label: 'Users & permissions', icon: 'people' },
    { id: 'theme', label: 'Theme & display', icon: 'sparkle' },
    { id: 'integrations', label: 'Integrations', icon: 'globe' },
    { id: 'mcp', label: 'MCP servers', icon: 'mcp' },
    { id: 'billing', label: 'Billing', icon: 'dollar' },
    { id: 'security', label: 'Security', icon: 'lock' },
  ];
  return (
    <V4Frame
      active="dashboard"
      eyebrow="Workspace settings"
      title="Configure your workspace"
      crumbs={['INOMY', 'SETTINGS']}
      actions={<button className="btn btn-line"><Icon name="external" size={11}/>Help</button>}
    >
      <div style={{ display: 'flex', gap: 28, flex: 1, minHeight: 0 }}>
        {/* sidebar */}
        <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {sections.map(s => (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              borderRadius: 99, fontSize: 13, cursor: 'pointer',
              color: s.active ? '#fff' : 'var(--ink-2)',
              background: s.active ? 'var(--ink)' : 'transparent',
              fontWeight: s.active ? 500 : 400,
            }}>
              <Icon name={s.icon} size={13} color={s.active ? '#fff' : 'var(--ink-3)'} />
              <span style={{ flex: 1 }}>{s.label}</span>
            </div>
          ))}
        </div>

        {/* main panel */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18, overflow: 'hidden' }}>
          {/* Profile card */}
          <AuroraCard padded style={{ padding: 24 }}>
            <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
              <AuroraAvatar name="Ashish Sehgal" size={64} hue={28} />
              <div style={{ flex: 1 }}>
                <div className="display" style={{ fontSize: 24, lineHeight: 1.1 }}>Ashish Sehgal</div>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 4 }}>ashish@inomy.shop · Founder · Admin</div>
              </div>
              <button className="btn btn-line">Edit photo</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginTop: 22 }}>
              {[
                { label: 'Display name', value: 'Ashish Sehgal' },
                { label: 'Email', value: 'ashish@inomy.shop' },
                { label: 'Role', value: 'Founder · Admin', readonly: true },
                { label: 'Timezone', value: 'Asia/Kolkata (IST · UTC+05:30)' },
              ].map((f, i) => (
                <div key={i}>
                  <div className="uppercase-label" style={{ marginBottom: 4 }}>{f.label}</div>
                  <div style={{
                    padding: '8px 12px', borderRadius: 8, fontSize: 13,
                    background: f.readonly ? 'var(--bg-2)' : 'var(--bg-1)',
                    border: '1px solid var(--line)', color: f.readonly ? 'var(--ink-3)' : 'var(--ink)',
                  }}>{f.value}</div>
                </div>
              ))}
            </div>
          </AuroraCard>

          {/* Theme preview */}
          <AuroraCard padded style={{ padding: 22 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
              <div className="display" style={{ fontSize: 20 }}>Theme</div>
              <div style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>aurora · default</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {[
                { name: 'Aurora', sw: ['#f7f4ee', '#5b4ae6', '#1c1a17'], active: true },
                { name: 'Mission', sw: ['#0a0e12', '#5eead4', '#e6edf3'] },
                { name: 'Linear', sw: ['#fbfbfa', '#5e6ad2', '#18181a'] },
                { name: 'Operator', sw: ['#f5f4f0', '#c2410c', '#0a0a0a'] },
              ].map((t, i) => (
                <div key={i} style={{
                  border: t.active ? '2px solid var(--acc)' : '1px solid var(--line)',
                  borderRadius: 12, padding: 12, cursor: 'pointer', background: 'var(--bg-1)',
                }}>
                  <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                    {t.sw.map((c, j) => (
                      <div key={j} style={{ flex: 1, height: 28, borderRadius: 6, background: c, border: '1px solid var(--line)' }}/>
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500 }}>{t.name}</span>
                    {t.active && <Icon name="check" size={11} color="var(--acc)" />}
                  </div>
                </div>
              ))}
            </div>
          </AuroraCard>

          {/* Quick toggles */}
          <AuroraCard padded style={{ padding: 22 }}>
            <div className="display" style={{ fontSize: 20, marginBottom: 14 }}>Preferences</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {[
                { label: 'Dense layout', sub: 'Reduce padding throughout the app', on: false },
                { label: 'Show keyboard hints', sub: 'Display ⌘ shortcuts on hover', on: true },
                { label: 'Sound on intervention', sub: 'Soft chime when a run needs your attention', on: true },
                { label: 'Auto-approve safe runs', sub: 'Skip approval for whitelisted workflows', on: false },
              ].map((p, i, arr) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 14, padding: '12px 0',
                  borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 'none',
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{p.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{p.sub}</div>
                  </div>
                  <div style={{
                    width: 36, height: 20, borderRadius: 99, padding: 2,
                    background: p.on ? 'var(--acc)' : 'var(--bg-3)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: p.on ? 'flex-end' : 'flex-start',
                  }}>
                    <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff' }}/>
                  </div>
                </div>
              ))}
            </div>
          </AuroraCard>
        </div>
      </div>
    </V4Frame>
  );
};

// =============================================================================
// V1 — Mission Control: settings as a config terminal
// =============================================================================
const SettingsV1 = () => {
  const sections = ['PROFILE', 'WORKSPACE', 'USERS', 'THEME', 'INTEGR', 'MCP', 'BILLING', 'SECURITY'];
  return (
    <V1Frame
      active="dashboard"
      crumbs={['ALLEN', 'CONFIG', 'PROFILE']}
      actions={<>
        <button className="btn btn-ghost mono" style={{fontSize:11}}>RESET</button>
        <button className="btn btn-primary mono" style={{fontSize:11}}>APPLY ⏎</button>
      </>}
    >
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* section nav */}
        <div style={{ width: 160, borderRight: '1px solid var(--line)', padding: '14px 0', flexShrink: 0 }}>
          {sections.map((s, i) => (
            <div key={i} className="mono" style={{
              padding: '6px 16px', fontSize: 11, letterSpacing: '0.06em',
              color: i === 0 ? 'var(--acc)' : 'var(--ink-2)',
              borderLeft: i === 0 ? '2px solid var(--acc)' : '2px solid transparent',
              cursor: 'pointer',
            }}>{s}</div>
          ))}
        </div>

        {/* config panel */}
        <div style={{ flex: 1, padding: 20, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em' }}>
            ALLEN.CONFIG / PROFILE.YAML
          </div>

          {/* profile fields as kv */}
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4 }}>
            {[
              { k: 'user.id', v: 'usr_8f3a91bc', readonly: true },
              { k: 'user.email', v: 'ashish@inomy.shop' },
              { k: 'user.display_name', v: 'Ashish Sehgal' },
              { k: 'user.role', v: 'founder/admin', tone: 'acc' },
              { k: 'user.tz', v: 'Asia/Kolkata' },
              { k: 'user.created', v: '2024-08-12T04:11:08Z', readonly: true },
            ].map((r, i) => (
              <div key={i} className="mono" style={{
                display: 'grid', gridTemplateColumns: '180px 1fr auto',
                padding: '8px 14px', fontSize: 11.5, gap: 16,
                borderBottom: '1px solid var(--line)',
              }}>
                <span style={{ color: 'var(--ink-3)' }}>{r.k}</span>
                <span style={{
                  color: r.tone === 'acc' ? 'var(--acc)' : (r.readonly ? 'var(--ink-3)' : 'var(--ink)'),
                }}>{r.v}</span>
                {!r.readonly && <Icon name="edit" size={11} color="var(--ink-3)" />}
              </div>
            ))}
          </div>

          {/* THEME picker */}
          <div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em', marginBottom: 8 }}>THEME / ACTIVE: aurora</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {[
                { id: 'aurora', sw: ['#f7f4ee', '#5b4ae6', '#1c1a17'], active: true },
                { id: 'mission', sw: ['#0a0e12', '#5eead4', '#e6edf3'] },
                { id: 'linear', sw: ['#fbfbfa', '#5e6ad2', '#18181a'] },
                { id: 'operator', sw: ['#f5f4f0', '#c2410c', '#0a0a0a'] },
              ].map(t => (
                <div key={t.id} style={{
                  border: `1px solid ${t.active ? 'var(--acc)' : 'var(--line)'}`,
                  background: 'var(--bg-1)', padding: 10, borderRadius: 4,
                }}>
                  <div style={{ display: 'flex', gap: 3, marginBottom: 6 }}>
                    {t.sw.map((c, j) => <div key={j} style={{ flex: 1, height: 22, background: c, border: '1px solid var(--line)' }}/>)}
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: t.active ? 'var(--acc)' : 'var(--ink-2)' }}>
                    {t.active ? '> ' : '  '}{t.id}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* MCP servers strip */}
          <div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.08em', marginBottom: 8 }}>MCP / 8 SERVERS REGISTERED</div>
            <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4 }}>
              {[
                { n: 'github', s: 'connected', c: 'ok', tools: 24 },
                { n: 'linear', s: 'connected', c: 'ok', tools: 12 },
                { n: 'shopify', s: 'connected', c: 'ok', tools: 38 },
                { n: 'sentry', s: 'auth-required', c: 'warn', tools: 0 },
                { n: 'postgres-prod', s: 'connected', c: 'ok', tools: 6 },
              ].map((m, i, arr) => (
                <div key={i} className="mono" style={{
                  display: 'grid', gridTemplateColumns: '160px 1fr auto auto',
                  padding: '6px 14px', fontSize: 11, gap: 12, alignItems: 'center',
                  borderBottom: i < arr.length - 1 ? '1px solid var(--line)' : 'none',
                }}>
                  <span>{m.n}</span>
                  <span style={{ color: m.c === 'ok' ? 'var(--ok)' : 'var(--warn)' }}>● {m.s}</span>
                  <span style={{ color: 'var(--ink-3)' }}>{m.tools} tools</span>
                  <Icon name="external" size={10} color="var(--ink-3)" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </V1Frame>
  );
};

// =============================================================================
// V2 — Linear-clean: tabbed settings with grouped cards
// =============================================================================
const SettingsV2 = () => {
  return (
    <V2Frame
      active="dashboard"
      title="Settings"
      crumbs={['Workspace', 'Settings']}
      tabs={[
        { label: 'Profile', active: true },
        { label: 'Workspace' },
        { label: 'Members', count: 6 },
        { label: 'Theme' },
        { label: 'MCP', count: 8 },
        { label: 'Billing' },
      ]}
    >
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px 32px' }}>
        <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Identity */}
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18 }}>
              <div style={{ width: 56, height: 56, borderRadius: 12, background: 'linear-gradient(135deg, #f59e0b, #ef4444)' }}/>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Ashish Sehgal</div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>ashish@inomy.shop</div>
              </div>
              <button className="btn btn-line" style={{ fontSize: 12 }}>Change</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {[
                ['Full name', 'Ashish Sehgal'],
                ['Email', 'ashish@inomy.shop'],
                ['Role', 'Founder · Admin'],
                ['Timezone', 'Asia/Kolkata'],
              ].map(([k, v], i) => (
                <div key={i}>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginBottom: 4 }}>{k}</div>
                  <div style={{
                    padding: '7px 11px', border: '1px solid var(--line)', borderRadius: 6,
                    fontSize: 13, background: 'var(--bg-1)',
                  }}>{v}</div>
                </div>
              ))}
            </div>
          </div>

          {/* MCP card */}
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>MCP servers</div>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>· 8 connected</span>
              <div style={{ flex: 1 }} />
              <button className="btn btn-line" style={{ fontSize: 12 }}><Icon name="plus" size={11}/>Add server</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                { n: 'GitHub', t: 24, st: 'ok' },
                { n: 'Linear', t: 12, st: 'ok' },
                { n: 'Shopify', t: 38, st: 'ok' },
                { n: 'Sentry', t: 0, st: 'warn' },
                { n: 'Postgres', t: 6, st: 'ok' },
                { n: 'Slack', t: 18, st: 'ok' },
              ].map((m, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  border: '1px solid var(--line)', borderRadius: 6,
                }}>
                  <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="mcp" size={12} color="var(--ink-2)"/>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{m.n}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{m.t} tools</div>
                  </div>
                  <span className={`pill pill-${m.st === 'ok' ? 'ok' : 'warn'}`}>{m.st === 'ok' ? 'ok' : 'auth'}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Theme */}
          <div style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 8, padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Appearance</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {['Aurora', 'Mission', 'Linear', 'Operator'].map((t, i) => (
                <div key={i} style={{
                  border: i === 2 ? '2px solid var(--acc)' : '1px solid var(--line)',
                  borderRadius: 8, padding: 10, cursor: 'pointer',
                }}>
                  <div style={{ height: 40, borderRadius: 5, marginBottom: 6,
                    background: ['linear-gradient(135deg,#f7f4ee,#5b4ae6)',
                      'linear-gradient(135deg,#0a0e12,#5eead4)',
                      'linear-gradient(135deg,#fbfbfa,#5e6ad2)',
                      'linear-gradient(135deg,#f5f4f0,#c2410c)'][i]
                  }}/>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{t}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </V2Frame>
  );
};

// =============================================================================
// V3 — Operator: settings as a giant key/value form
// =============================================================================
const SettingsV3 = () => {
  return (
    <V3Frame active="dashboard" title="Settings" subtitle="Configuration · workspace inomy/main" count={null}
      actions={<>
        <button className="btn btn-line mono" style={{fontSize:11}}>discard</button>
        <button className="btn btn-primary mono" style={{fontSize:11}}>save changes</button>
      </>}
    >
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* left: section list */}
        <div style={{ width: 200, borderRight: '1px solid var(--line)', flexShrink: 0, padding: '8px 0' }}>
          {[
            ['PROFILE', true], ['WORKSPACE', false], ['MEMBERS', false],
            ['ROLES', false], ['THEME', false], ['INTEGRATIONS', false],
            ['MCP SERVERS', false], ['API KEYS', false], ['AUDIT LOG', false],
            ['BILLING', false],
          ].map(([s, a], i) => (
            <div key={i} className="mono" style={{
              padding: '6px 16px', fontSize: 11, fontWeight: a ? 700 : 400,
              background: a ? 'var(--acc-dim)' : 'transparent',
              borderLeft: a ? '3px solid var(--acc)' : '3px solid transparent',
              cursor: 'pointer',
            }}>{s}</div>
          ))}
        </div>

        {/* form */}
        <div style={{ flex: 1, padding: 20, overflow: 'auto' }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginBottom: 12, letterSpacing: '0.06em' }}>
            CONFIG.PROFILE / 6 FIELDS / 0 PENDING
          </div>

          <table className="mono" style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <tbody>
              {[
                ['user_id', 'usr_8f3a91bc', true],
                ['display_name', 'Ashish Sehgal', false],
                ['email', 'ashish@inomy.shop', false],
                ['role', 'founder/admin', true],
                ['timezone', 'Asia/Kolkata', false],
                ['locale', 'en-US', false],
                ['mfa_enabled', 'true', false, 'tone-ok'],
                ['session_ttl', '24h', false],
              ].map(([k, v, ro, tone], i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '8px 12px', color: 'var(--ink-3)', width: 200 }}>{k}</td>
                  <td style={{ padding: '8px 12px', color: tone === 'tone-ok' ? 'var(--ok)' : 'var(--ink)' }}>
                    <span style={{ background: ro ? 'var(--bg-2)' : 'transparent', padding: ro ? '2px 6px' : '0' }}>{v}</span>
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--ink-3)', fontSize: 10 }}>
                    {ro ? 'READONLY' : 'EDIT'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', margin: '20px 0 8px', letterSpacing: '0.06em' }}>
            CONFIG.MCP / 8 SERVERS
          </div>
          <table className="mono" style={{ width: '100%', fontSize: 11.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--ink)', color: 'var(--ink-3)', fontSize: 10, letterSpacing: '0.06em' }}>
                <th style={{ padding: '6px 12px', textAlign: 'left' }}>NAME</th>
                <th style={{ padding: '6px 12px', textAlign: 'left' }}>URL</th>
                <th style={{ padding: '6px 12px', textAlign: 'right' }}>TOOLS</th>
                <th style={{ padding: '6px 12px', textAlign: 'left' }}>STATUS</th>
                <th style={{ padding: '6px 12px', textAlign: 'right' }}>LAST PING</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['github', 'mcp.github.com', 24, 'connected', '2s'],
                ['linear', 'mcp.linear.app', 12, 'connected', '4s'],
                ['shopify', 'mcp.shopify.com', 38, 'connected', '1s'],
                ['sentry', 'mcp.sentry.io', 0, 'auth-required', '14m'],
                ['postgres-prod', 'pgmcp.inomy.internal', 6, 'connected', '3s'],
                ['slack', 'mcp.slack.com', 18, 'connected', '6s'],
                ['stripe', 'mcp.stripe.com', 22, 'connected', '2s'],
                ['vercel', 'mcp.vercel.com', 8, 'connected', '5s'],
              ].map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '6px 12px', fontWeight: 500 }}>{r[0]}</td>
                  <td style={{ padding: '6px 12px', color: 'var(--ink-3)' }}>{r[1]}</td>
                  <td style={{ padding: '6px 12px', textAlign: 'right' }}>{r[2]}</td>
                  <td style={{ padding: '6px 12px', color: r[3] === 'connected' ? 'var(--ok)' : 'var(--warn)' }}>● {r[3]}</td>
                  <td style={{ padding: '6px 12px', textAlign: 'right', color: 'var(--ink-3)' }}>{r[4]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </V3Frame>
  );
};

Object.assign(window, { SettingsV1, SettingsV2, SettingsV3, SettingsV4 });
