// login.jsx — Login + password reset, four directions

const Aurora = ({ children }) => <div className="frame v4" style={{
  background: 'var(--bg)', position: 'relative', overflow: 'hidden',
}}>{children}</div>;

// =============================================================================
// V4 — Aurora: editorial split-panel with marketing left, form right
// =============================================================================
const LoginV4 = () => (
  <Aurora>
    <div style={{ display: 'flex', flex: 1 }}>
      {/* Left: editorial panel */}
      <div style={{
        flex: 1, padding: '64px 56px', display: 'flex', flexDirection: 'column',
        background: 'linear-gradient(135deg, #efeae0 0%, #e6e0d3 100%)',
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <AllenLogo size={16} color="var(--bg)"/>
          </div>
          <div className="display" style={{ fontSize: 22 }}>Allen</div>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ maxWidth: 460 }}>
          <div className="uppercase-label" style={{ marginBottom: 14, color: 'var(--acc)' }}>The control plane for your agents</div>
          <h1 className="display" style={{ fontSize: 56, lineHeight: 1.05, fontWeight: 400, letterSpacing: '-0.025em', marginBottom: 18 }}>
            <em style={{ fontStyle: 'italic' }}>Choreograph</em> the work,<br/>
            audit the outcomes.
          </h1>
          <p style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.55, maxWidth: 380 }}>
            One workspace for every agent, run, repo and human-in-the-loop intervention. Built for teams who ship.
          </p>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 11.5, color: 'var(--ink-3)' }}>
          <span className="mono">v0.142.7</span>
          <span>·</span>
          <span>Inomy · Bangalore</span>
          <div style={{ flex: 1 }}/>
          <a className="mono" style={{ color: 'var(--ink-3)' }}>privacy</a>
          <a className="mono" style={{ color: 'var(--ink-3)' }}>terms</a>
        </div>

        {/* decorative iris bloom */}
        <div style={{
          position: 'absolute', right: -120, top: 80, width: 320, height: 320,
          borderRadius: '50%', background: 'radial-gradient(circle, rgba(91,74,230,0.18), transparent 70%)',
          pointerEvents: 'none',
        }}/>
      </div>

      {/* Right: form */}
      <div style={{ width: 540, background: 'var(--bg-1)', padding: '64px 56px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <div className="display" style={{ fontSize: 32, marginBottom: 4 }}>Welcome back</div>
        <div style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 32 }}>Sign in to your Allen workspace.</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <button style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            padding: '12px 16px', borderRadius: 99, border: '1px solid var(--line)',
            background: 'var(--bg-1)', fontSize: 13.5, fontWeight: 500, cursor: 'pointer',
          }}>
            <Icon name="github" size={16}/>Continue with GitHub
          </button>
          <button style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            padding: '12px 16px', borderRadius: 99, border: '1px solid var(--line)',
            background: 'var(--bg-1)', fontSize: 13.5, fontWeight: 500, cursor: 'pointer',
          }}>
            <span style={{
              width: 16, height: 16, background: 'conic-gradient(from 0deg, #ea4335, #fbbc04, #34a853, #4285f4, #ea4335)',
              borderRadius: '50%', display: 'inline-block',
            }}/>Continue with Google
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '24px 0', color: 'var(--ink-3)' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--line)' }}/>
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: '0.1em' }}>OR EMAIL</span>
          <div style={{ flex: 1, height: 1, background: 'var(--line)' }}/>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="uppercase-label" style={{ marginBottom: 6 }}>Email</div>
            <div style={{
              padding: '11px 16px', border: '1px solid var(--line)', borderRadius: 12,
              fontSize: 14, background: 'var(--bg-1)',
            }}>ashish@inomy.shop</div>
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div className="uppercase-label">Password</div>
              <a className="mono" style={{ fontSize: 10.5, color: 'var(--acc)', textTransform: 'uppercase', letterSpacing: '0.08em', cursor: 'pointer' }}>Forgot?</a>
            </div>
            <div style={{
              padding: '11px 16px', border: '1px solid var(--ink)', borderRadius: 12,
              fontSize: 14, background: 'var(--bg-1)', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ flex: 1, color: 'var(--ink-3)', letterSpacing: 4 }}>••••••••••</span>
              <Icon name="lock" size={14} color="var(--ink-3)"/>
            </div>
          </div>
        </div>

        <button style={{
          marginTop: 22, padding: '13px 18px', borderRadius: 99,
          background: 'var(--ink)', color: 'var(--bg-1)',
          fontSize: 14, fontWeight: 500, border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>Sign in →</button>

        <div style={{ marginTop: 22, fontSize: 12.5, color: 'var(--ink-3)', textAlign: 'center' }}>
          Don't have an account? <a style={{ color: 'var(--ink)', fontWeight: 500 }}>Request access</a>
        </div>
      </div>
    </div>
  </Aurora>
);

// =============================================================================
// V1 — Mission Control: terminal-style auth prompt
// =============================================================================
const LoginV1 = () => (
  <div className="frame v1" style={{ background: 'var(--bg)', alignItems: 'center', justifyContent: 'center' }}>
    {/* terminal window */}
    <div style={{
      width: 520, background: 'var(--bg-1)', border: '1px solid var(--line)',
      borderRadius: 6, fontFamily: 'var(--font-mono)', boxShadow: '0 24px 80px rgba(0,0,0,0.55)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#f87171' }}/>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#fbbf24' }}/>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#4ade80' }}/>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>allen-auth · 1</div>
      </div>
      <div style={{ padding: 22, fontSize: 12.5, color: 'var(--ink-2)', minHeight: 320, lineHeight: 1.7 }}>
        <div style={{ color: 'var(--acc)' }}>$ allen auth login</div>
        <div style={{ color: 'var(--ink-3)' }}>Allen control-plane v0.142.7 · Inomy/main</div>
        <div style={{ color: 'var(--ink-3)' }}>Authentication required.</div>
        <div style={{ height: 14 }}/>
        <div>email: <span style={{ color: 'var(--ink)' }}>ashish@inomy.shop</span></div>
        <div>password: <span style={{ color: 'var(--ink)' }}>••••••••••</span></div>
        <div style={{ height: 8 }}/>
        <div style={{ color: 'var(--ink-3)' }}>method:
          <span style={{ color: 'var(--acc)', marginLeft: 8 }}>[ password ]</span>
          <span style={{ color: 'var(--ink-3)', marginLeft: 8 }}>[ github ]</span>
          <span style={{ color: 'var(--ink-3)', marginLeft: 8 }}>[ google ]</span>
          <span style={{ color: 'var(--ink-3)', marginLeft: 8 }}>[ sso ]</span>
        </div>
        <div style={{ height: 14 }}/>
        <div style={{ color: 'var(--ok)' }}>✓ verifying credentials…</div>
        <div style={{ color: 'var(--ok)' }}>✓ checking 2FA token (push sent to <span style={{ color: 'var(--ink)'}}>iPhone 15 · Bangalore</span>)…</div>
        <div style={{ color: 'var(--ink-3)' }}>waiting for approval ▌</div>
        <div style={{ height: 14 }}/>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary mono" style={{ fontSize: 11 }}>SUBMIT ⏎</button>
          <button className="btn btn-line mono" style={{ fontSize: 11 }}>RESET PW</button>
          <div style={{ flex: 1 }}/>
          <span style={{ color: 'var(--ink-3)', fontSize: 10, alignSelf: 'center' }}>esc to exit</span>
        </div>
      </div>
    </div>
    <div style={{ position: 'absolute', bottom: 18, left: 0, right: 0, textAlign: 'center',
      fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.1em' }}>
      ALLEN · v0.142.7 · INOMY/MAIN · ALL SYSTEMS NOMINAL
    </div>
  </div>
);

// =============================================================================
// V2 — Linear-clean: centered card
// =============================================================================
const LoginV2 = () => (
  <div className="frame v2" style={{ background: 'var(--bg)', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ width: 380, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, padding: 36, boxShadow: '0 8px 24px rgba(0,0,0,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg, #5e6ad2, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <AllenLogo size={15} color="#fff"/>
        </div>
        <div style={{ fontSize: 17, fontWeight: 600 }}>Allen</div>
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 4, letterSpacing: '-0.02em' }}>Sign in</div>
      <div style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 22 }}>to your Allen workspace</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        <button className="btn btn-line" style={{ justifyContent: 'center', padding: '9px', fontSize: 13 }}>
          <Icon name="github" size={14}/>Continue with GitHub
        </button>
        <button className="btn btn-line" style={{ justifyContent: 'center', padding: '9px', fontSize: 13 }}>
          <Icon name="globe" size={14}/>Continue with SSO
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0', color: 'var(--ink-3)', fontSize: 11 }}>
        <div style={{ flex: 1, height: 1, background: 'var(--line)' }}/>OR<div style={{ flex: 1, height: 1, background: 'var(--line)' }}/>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 13, background: 'var(--bg-1)' }}>ashish@inomy.shop</div>
        <div style={{ padding: '8px 11px', border: '1px solid var(--acc)', borderRadius: 6, fontSize: 13, background: 'var(--bg-1)', boxShadow: '0 0 0 3px var(--acc-dim)' }}>•••••••••</div>
      </div>

      <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 14, padding: '9px' }}>Sign in →</button>

      <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-3)' }}>
        <a style={{ color: 'var(--acc)' }}>Forgot password?</a>
        <a>Request access</a>
      </div>
    </div>
  </div>
);

// =============================================================================
// V3 — Operator: brutalist block
// =============================================================================
const LoginV3 = () => (
  <div className="frame v3" style={{ background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ width: 460, background: 'var(--bg-1)', border: '2px solid var(--ink)', padding: 0 }}>
      <div style={{ borderBottom: '2px solid var(--ink)', padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--ink)', color: 'var(--bg)' }}>
        <AllenLogo size={14} color="var(--bg)"/>
        <span className="mono" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.05em' }}>ALLEN / SIGN IN</span>
        <div style={{ flex: 1 }}/>
        <span className="mono" style={{ fontSize: 10, opacity: 0.6 }}>v0.142.7</span>
      </div>

      <div style={{ padding: 24 }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.06em', marginBottom: 18 }}>
          AUTHENTICATE TO INOMY/MAIN
        </div>

        <div className="mono" style={{ fontSize: 11, marginBottom: 4, color: 'var(--ink-3)' }}>EMAIL</div>
        <div style={{ border: '1px solid var(--ink)', padding: '8px 12px', fontSize: 13, marginBottom: 14, fontFamily: 'var(--font-mono)' }}>ashish@inomy.shop</div>

        <div className="mono" style={{ fontSize: 11, marginBottom: 4, color: 'var(--ink-3)' }}>PASSWORD</div>
        <div style={{ border: '1px solid var(--ink)', padding: '8px 12px', fontSize: 13, marginBottom: 14, fontFamily: 'var(--font-mono)' }}>•••••••••</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 12 }}>
          <div style={{ width: 14, height: 14, border: '1.5px solid var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="check" size={10} color="var(--ink)"/>
          </div>
          <span>Remember this device for 30 days</span>
        </div>

        <button className="btn btn-primary mono" style={{ width: '100%', justifyContent: 'center', padding: '10px', fontSize: 12, fontWeight: 700, letterSpacing: '0.05em' }}>SIGN IN →</button>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
          <button className="btn btn-line mono" style={{ justifyContent: 'center', padding: '7px', fontSize: 11 }}><Icon name="github" size={11}/>GITHUB</button>
          <button className="btn btn-line mono" style={{ justifyContent: 'center', padding: '7px', fontSize: 11 }}><Icon name="globe" size={11}/>SSO</button>
        </div>

        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 18, display: 'flex', justifyContent: 'space-between' }}>
          <a style={{ color: 'var(--acc)', textDecoration: 'underline' }}>FORGOT PASSWORD</a>
          <a>REQUEST ACCESS</a>
        </div>
      </div>
    </div>
  </div>
);

// =============================================================================
// Reset password — same 4 directions, more compact
// =============================================================================
const ResetV4 = () => (
  <Aurora>
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 460, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 18, padding: 40, boxShadow: '0 12px 32px rgba(28,26,23,0.06)' }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--acc-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
          <Icon name="lock" size={18} color="var(--acc)"/>
        </div>
        <h1 className="display" style={{ fontSize: 30, lineHeight: 1.1, marginBottom: 6 }}>Reset your password</h1>
        <p style={{ fontSize: 13.5, color: 'var(--ink-3)', marginBottom: 24, lineHeight: 1.55 }}>
          Enter your email and we'll send a one-time link.
        </p>
        <div className="uppercase-label" style={{ marginBottom: 6 }}>Email</div>
        <div style={{ padding: '11px 14px', border: '1px solid var(--ink)', borderRadius: 12, fontSize: 14, marginBottom: 18 }}>ashish@inomy.shop</div>
        <button style={{
          width: '100%', padding: '12px', borderRadius: 99, background: 'var(--ink)', color: 'var(--bg-1)',
          fontSize: 13.5, fontWeight: 500, border: 'none', cursor: 'pointer',
        }}>Send reset link</button>
        <div style={{ marginTop: 18, fontSize: 12.5, color: 'var(--ink-3)', textAlign: 'center' }}>
          <a style={{ color: 'var(--ink)' }}>← Back to sign in</a>
        </div>
      </div>
    </div>
  </Aurora>
);

const ResetV1 = () => (
  <div className="frame v1" style={{ background: 'var(--bg)', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ width: 460, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 6, fontFamily: 'var(--font-mono)' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', fontSize: 11, color: 'var(--ink-3)' }}>$ allen auth reset</div>
      <div style={{ padding: 22, fontSize: 12.5, lineHeight: 1.7 }}>
        <div style={{ color: 'var(--ink-3)' }}>Enter the email associated with your account.</div>
        <div style={{ color: 'var(--ink-3)' }}>We will send a one-time reset link valid for 15 minutes.</div>
        <div style={{ height: 14 }}/>
        <div>email: <span style={{ color: 'var(--ink)' }}>ashish@inomy.shop</span></div>
        <div style={{ height: 16 }}/>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary mono" style={{ fontSize: 11 }}>SEND LINK ⏎</button>
          <button className="btn btn-line mono" style={{ fontSize: 11 }}>← BACK</button>
        </div>
      </div>
    </div>
  </div>
);

const ResetV2 = () => (
  <div className="frame v2" style={{ background: 'var(--bg)', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ width: 360, background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 12, padding: 32, boxShadow: '0 8px 24px rgba(0,0,0,0.04)' }}>
      <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--acc-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
        <Icon name="lock" size={16} color="var(--acc)"/>
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Reset password</div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginBottom: 18 }}>We'll email you a one-time link.</div>
      <div style={{ padding: '8px 11px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 13, marginBottom: 14 }}>ashish@inomy.shop</div>
      <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '8px' }}>Send link</button>
      <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12, color: 'var(--ink-3)' }}><a style={{ color: 'var(--acc)' }}>← Back to sign in</a></div>
    </div>
  </div>
);

const ResetV3 = () => (
  <div className="frame v3" style={{ background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ width: 420, background: 'var(--bg-1)', border: '2px solid var(--ink)' }}>
      <div style={{ background: 'var(--ink)', color: 'var(--bg)', padding: '10px 16px' }}>
        <span className="mono" style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em' }}>ALLEN / RESET PASSWORD</span>
      </div>
      <div style={{ padding: 22 }}>
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginBottom: 16 }}>STEP 1 OF 3 / EMAIL VERIFICATION</div>
        <div className="mono" style={{ fontSize: 11, marginBottom: 4, color: 'var(--ink-3)' }}>EMAIL</div>
        <div style={{ border: '1px solid var(--ink)', padding: '8px 12px', fontSize: 13, marginBottom: 16, fontFamily: 'var(--font-mono)' }}>ashish@inomy.shop</div>
        <button className="btn btn-primary mono" style={{ width: '100%', justifyContent: 'center', padding: '9px', fontSize: 12, fontWeight: 700, letterSpacing: '0.05em' }}>SEND RESET LINK →</button>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 14, textAlign: 'center' }}>← BACK TO SIGN IN</div>
      </div>
    </div>
  </div>
);

Object.assign(window, { LoginV1, LoginV2, LoginV3, LoginV4, ResetV1, ResetV2, ResetV3, ResetV4 });
