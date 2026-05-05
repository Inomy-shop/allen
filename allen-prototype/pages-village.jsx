// Village — pixel agent town

const { useState: vUseState, useEffect: vUseEffect, useRef: vUseRef, useMemo: vUseMemo, useCallback: vUseCallback } = React;

// World is logical 1200x720; we scale to fit
const VW = 1200, VH = 720;

const ZONES = {
  bench:    { x: 110,  y: 540, w: 300, h: 100, team: 'idle',      label: 'Idle Bench',      sign: 'waiting room' },
  planning: { x: 460,  y: 200, w: 140, h: 120, team: 'planning',  label: 'Planning Desk',   sign: 'PRD · HLA · TDD' },
  mine:     { x: 720,  y: 230, w: 130, h: 110, team: 'implement', label: 'Code Mine',       sign: 'implementation' },
  lab:      { x: 920,  y: 220, w: 130, h: 110, team: 'qa',        label: 'QA Lab',          sign: 'tests · lint' },
  security: { x: 1060, y: 360, w: 90,  h: 140, team: 'security',  label: 'Security Tower',  sign: 'audit' },
  gate:     { x: 950,  y: 480, w: 120, h: 130, team: 'ops',       label: 'PR Gate',         sign: 'merge' },
  workshop: { x: 230,  y: 220, w: 130, h: 110, team: 'builder',   label: 'Workshop',        sign: 'meta' },
  podium:   { x: 720,  y: 470, w: 70,  h: 100, team: 'human',     label: 'Human Gate',      sign: 'awaiting input' },
  fountain: { x: 540,  y: 460, w: 90,  h: 50,  team: 'park',      label: 'Park',            sign: 'token meter' },
};

// Stage-to-zone map for execution flow
const WF_STAGES = [
  { stage: 'plan',      zone: 'planning' },
  { stage: 'implement', zone: 'mine' },
  { stage: 'qa',        zone: 'lab' },
  { stage: 'security',  zone: 'security' },
  { stage: 'gate',      zone: 'gate' },
];

// Sample agent names per team
const AGENT_NAMES = {
  planning: ['intake', 'prd-writer', 'hla-writer', 'tdd-author', 'plan-judge'],
  implement: ['impl-cortex', 'impl-pico', 'impl-nova', 'refactor-bot', 'patch-cat'],
  qa: ['qa-runner', 'lint-stickler', 'flake-hunter', 'cov-reporter'],
  security: ['sec-scout', 'creds-watcher', 'sast-runner'],
  ops: ['pr-bot', 'merge-warden', 'gh-courier'],
  builder: ['team-builder', 'agent-smith', 'meta-mind'],
  data: ['scraper-1', 'scraper-2', 'enricher'],
};

const SPEECH = {
  planning: ['drafting PRD…', 'reading the ticket…', 'pinging hla-writer…', 'open question: scope', 'looks good to me ✓'],
  implement: ['running pytest…', 'fix in shipping.py', 'refactor done', 'rebasing on dev…', 'building…', 'cargo build ok'],
  qa: ['3/12 failing', 'flaky test…', 'all green ✓', 'coverage 87%', 'snapshot updated'],
  security: ['no secrets found', 'scanning deps…', 'CVE-2024-4521 ok', 'audit clean'],
  ops: ['opened PR #598', 'pushing branch…', 'PR linked to ENG-1453', 'merging…'],
  builder: ['training tweak…', 'agent v2 ready', 'persona updated'],
  idle: ['zzz', 'ready', 'anyone need a hand?', 'coffee time', 'standing by', '...'],
  human: ['waiting on you', '?', 'plan needs approval', 'still here…'],
};

// ===== Sprite component =====
function VillageSprite({ s, onClick }) {
  const facing = (s.vx || 0) >= 0 ? 'right' : 'left';
  const cls = ['v-sprite'];
  if (s.mode === 'walk') cls.push('walking');
  if (s.mode === 'idle') {
    cls.push('idle');
    cls.push(s.idleStyle || 'sit');
  }
  if (s.mode === 'work') cls.push('working');
  if (s.stuck) cls.push('stuck');
  return (
    <div
      className={cls.join(' ')}
      data-team={s.team}
      data-facing={facing}
      style={{ left: s.x, top: s.y, zIndex: 4 + Math.floor(s.y / 10) }}
      onClick={(e)=>{ e.stopPropagation(); onClick && onClick(s);}}
    >
      <div className="v-name">{s.name}</div>
      <div className="antenna"></div>
      <div className="head">
        <div className="eye l"></div>
        <div className="eye r"></div>
      </div>
      <div className="body"></div>
      <div className="legs"></div>
      {s.bubble && <div className="v-bubble">{s.bubble}</div>}
    </div>
  );
}

// ===== Building / zone =====
function VillageZone({ z, k }) {
  return (
    <div className="v-zone" style={{ left: z.x, top: z.y, width: z.w, height: z.h }}>
      <div className="v-label">{z.label}</div>
      {k === 'bench' && <div className="v-bldg bench" style={{ width: z.w, height: 30, marginTop: 'auto' }}></div>}
      {k === 'planning' && <div className="v-bldg planning"></div>}
      {k === 'mine' && <div className="v-bldg mine"></div>}
      {k === 'lab' && <div className="v-bldg lab"></div>}
      {k === 'security' && <div className="v-bldg security"></div>}
      {k === 'gate' && <div className="v-bldg gate"></div>}
      {k === 'workshop' && <div className="v-bldg workshop"></div>}
      {k === 'podium' && <div className="v-bldg podium"></div>}
      {k === 'fountain' && <div className="v-fountain" style={{ width: 70, height: 36, marginTop: 'auto' }}></div>}
    </div>
  );
}

// ===== Sprite engine: maintains a population that reflects execs =====
function useVillagePopulation(execs) {
  const [sprites, setSprites] = vUseState(() => makeInitialSprites(execs));
  const spritesRef = vUseRef(sprites);
  spritesRef.current = sprites;
  const [achievement, setAchievement] = vUseState(null);

  // sync population with execs (add/remove)
  vUseEffect(() => {
    setSprites(prev => syncSpritesToExecs(prev, execs));
  }, [execs.map(e=>e.id+e.status).join('|')]);

  // tick — move sprites
  vUseEffect(() => {
    const t = setInterval(() => {
      setSprites(prev => prev.map(s => stepSprite(s, execs)));
    }, 100);
    return () => clearInterval(t);
  }, [execs]);

  // bubble emitter
  vUseEffect(() => {
    const t = setInterval(() => {
      setSprites(prev => prev.map(s => maybeEmitBubble(s, execs)));
    }, 1800);
    return () => clearInterval(t);
  }, [execs]);

  // achievement on completion
  const completedRef = vUseRef(new Set());
  vUseEffect(() => {
    execs.forEach(e => {
      if (e.status === 'completed' && !completedRef.current.has(e.id)) {
        completedRef.current.add(e.id);
        setAchievement({ text: `🎉  ${e.wf.split('/').pop()} merged · ${(e.dur/60).toFixed(1)}m`, ts: Date.now() });
        setTimeout(() => setAchievement(null), 4200);
      }
    });
  }, [execs]);

  return { sprites, achievement };
}

function makeInitialSprites(execs) {
  const all = [];
  let id = 0;
  // idle pool — 14 agents at the bench
  const idleTeams = ['planning','implement','qa','security','builder','ops','planning','implement','qa','data','builder','implement','qa','planning'];
  idleTeams.forEach((team, i) => {
    const z = ZONES.bench;
    all.push(makeSprite(id++, team, z.x + 12 + (i%7)*32, z.y + 16 + Math.floor(i/7)*22, 'idle'));
  });
  // active sprites assigned to execs
  execs.filter(e => e.status === 'running').forEach((e, idx) => {
    const stage = pickStage(e);
    const z = ZONES[stage] || ZONES.planning;
    const team = z.team === 'idle' ? 'planning' : z.team;
    const count = Math.min(4, 2 + (idx % 3));
    for (let i = 0; i < count; i++) {
      const sp = makeSprite(id++, team,
        z.x + 12 + Math.random()*Math.max(8, z.w-20),
        z.y + 14 + Math.random()*Math.max(6, z.h-20),
        'work');
      sp.execId = e.id;
      sp.zoneKey = stage;
      all.push(sp);
    }
  });
  return all;
}

function makeSprite(id, team, x, y, mode) {
  const names = AGENT_NAMES[team] || AGENT_NAMES.planning;
  return {
    id: 's'+id,
    team,
    name: names[id % names.length] + (id>9?'-'+(id%9+1):''),
    x, y,
    tx: x, ty: y,         // target
    vx: 0, vy: 0,
    mode,                  // 'walk' | 'idle' | 'work'
    idleStyle: ['sit','sit','sleep','kick'][id % 4],
    bubble: null,
    bubbleUntil: 0,
    execId: null,
    zoneKey: 'bench',
    nextThink: Date.now() + 1500 + Math.random()*2000,
    stuck: false,
  };
}

function pickStage(e) {
  // pick a stage based on a hash of (id + dur) so it advances over time
  if (!e || e.status !== 'running') return 'bench';
  const stages = WF_STAGES.map(s => s.zone);
  const seed = (e.id || '').split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const t = Math.floor((e.dur || 0) / 30 + (seed % 5)) % stages.length;
  return stages[t];
}

function syncSpritesToExecs(prev, execs) {
  // Keep idle sprites; reassign or trim active ones
  let next = prev.filter(s => !s.execId || execs.find(e => e.id === s.execId && e.status === 'running'));

  // For each running exec, ensure it has at least 2 sprites assigned
  execs.filter(e => e.status === 'running').forEach((e, idx) => {
    const own = next.filter(s => s.execId === e.id);
    const stage = pickStage(e);
    const z = ZONES[stage] || ZONES.planning;
    const team = z.team === 'idle' ? 'planning' : z.team;

    // update zone destination of existing
    own.forEach(s => {
      if (s.zoneKey !== stage) {
        s.zoneKey = stage;
        s.tx = z.x + 12 + Math.random()*Math.max(8, z.w-20);
        s.ty = z.y + 14 + Math.random()*Math.max(6, z.h-20);
        s.mode = 'walk';
        s.team = team;
      }
    });

    // grow pool if we don't have enough
    const want = Math.min(4, 2 + (idx % 3));
    const have = own.length;
    if (have < want) {
      // pull from idle pool
      const idle = next.filter(s => !s.execId && s.zoneKey === 'bench');
      for (let i = 0; i < want - have && i < idle.length; i++) {
        const s = idle[i];
        s.execId = e.id;
        s.zoneKey = stage;
        s.team = team;
        s.tx = z.x + 12 + Math.random()*Math.max(8, z.w-20);
        s.ty = z.y + 14 + Math.random()*Math.max(6, z.h-20);
        s.mode = 'walk';
      }
    }
  });

  // Returning sprites whose execs are gone go back to bench
  next.forEach(s => {
    if (s.execId && !execs.find(e => e.id === s.execId && e.status === 'running')) {
      s.execId = null;
      s.zoneKey = 'bench';
      const z = ZONES.bench;
      s.tx = z.x + 12 + Math.random()*(z.w-20);
      s.ty = z.y + 16 + Math.random()*(z.h-20);
      s.mode = 'walk';
      s.team = s.team; // keep team color
      s.idleStyle = ['sit','sit','sleep','kick'][Math.floor(Math.random()*4)];
    }
  });

  return [...next];
}

function stepSprite(s, execs) {
  const speed = 1.2;
  if (s.mode === 'walk') {
    const dx = s.tx - s.x, dy = s.ty - s.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.5) {
      // arrived
      s.vx = 0; s.vy = 0;
      s.mode = s.execId ? 'work' : 'idle';
      s.x = s.tx; s.y = s.ty;
    } else {
      s.vx = (dx/dist) * speed;
      s.vy = (dy/dist) * speed;
      s.x += s.vx;
      s.y += s.vy;
    }
  } else if (s.mode === 'idle') {
    // occasionally wander
    if (Date.now() > s.nextThink) {
      s.nextThink = Date.now() + 4000 + Math.random()*5000;
      if (Math.random() < 0.2) {
        const z = ZONES.bench;
        s.tx = z.x + 12 + Math.random()*(z.w-20);
        s.ty = z.y + 16 + Math.random()*(z.h-20);
        s.mode = 'walk';
      } else {
        s.idleStyle = ['sit','sit','sleep','kick'][Math.floor(Math.random()*4)];
      }
    }
  } else if (s.mode === 'work') {
    // small jiggle
    if (Date.now() > s.nextThink) {
      s.nextThink = Date.now() + 1800 + Math.random()*2200;
      const z = ZONES[s.zoneKey];
      if (z) {
        s.tx = z.x + 12 + Math.random()*Math.max(8, z.w-20);
        s.ty = z.y + 14 + Math.random()*Math.max(6, z.h-20);
        s.mode = 'walk';
      }
    }
  }
  return { ...s };
}

function maybeEmitBubble(s, execs) {
  // 18% chance per cycle
  if (Date.now() < s.bubbleUntil) return s;
  if (Math.random() > 0.18) {
    if (s.bubble && Date.now() > s.bubbleUntil) return { ...s, bubble: null };
    return s;
  }
  let pool = SPEECH[s.team] || SPEECH.idle;
  if (s.mode === 'idle') pool = SPEECH.idle;
  if (s.zoneKey === 'podium') pool = SPEECH.human;
  const text = pool[Math.floor(Math.random()*pool.length)];
  return { ...s, bubble: text, bubbleUntil: Date.now() + 2400 };
}

// ===== Stars (dark) =====
const STARS = Array.from({length: 40}, (_, i) => ({
  left: Math.random()*100,
  top: Math.random()*40,
  delay: Math.random()*3,
}));

// ===== Page =====
function VillagePage({ execs, setRoute }) {
  const { sprites, achievement } = useVillagePopulation(execs);
  const [selected, setSelected] = vUseState(null);
  const [showLegend, setShowLegend] = vUseState(true);
  const worldRef = vUseRef(null);
  const [scale, setScale] = vUseState(1);

  // fit world to container
  vUseEffect(() => {
    const fit = () => {
      const el = worldRef.current;
      if (!el) return;
      const cw = el.clientWidth, ch = el.clientHeight;
      const s = Math.min(cw / VW, ch / VH);
      setScale(s);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const running = execs.filter(e => e.status === 'running');
  const queued = execs.filter(e => e.status === 'queued');
  const idle = sprites.filter(s => !s.execId).length;
  const working = sprites.filter(s => s.execId).length;

  // exec banners (one per running exec, anchored to current zone)
  const banners = running.map(e => {
    const stage = pickStage(e);
    const z = ZONES[stage] || ZONES.planning;
    const cx = z.x + z.w/2;
    const cy = z.y - 14;
    return { e, x: cx, y: cy };
  });

  return (
    <div className="village-page" data-screen-label="village">
      <div className="village-head">
        <div className="v-stat live"><div className="dot"></div><span className="lbl">live</span></div>
        <div className="v-stat"><span className="ct">{sprites.length}</span><span className="lbl">agents</span></div>
        <div className="v-stat"><span className="ct">{working}</span><span className="lbl">working</span></div>
        <div className="v-stat"><span className="ct">{idle}</span><span className="lbl">idle</span></div>
        <div className="v-stat"><span className="ct">{running.length}</span><span className="lbl">runs</span></div>
        <div className="v-stat"><span className="ct">{queued.length}</span><span className="lbl">queued</span></div>
        <div className="v-actions">
          <button className="btn ghost sm" onClick={() => setShowLegend(v => !v)}>{showLegend ? 'hide' : 'show'} legend</button>
          <button className="btn ghost sm" onClick={() => setRoute && setRoute('executions')}>open run list →</button>
        </div>
      </div>

      <div className="village-world" ref={worldRef} onClick={() => setSelected(null)}>
        <div style={{
          position: 'absolute',
          left: '50%', top: '50%',
          width: VW, height: VH,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: 'center',
        }}>
          {/* sky + stars + clouds */}
          <div className="v-sky"></div>
          <div className="v-stars">
            {STARS.map((s, i) => (
              <div key={i} className="v-star" style={{ left: s.left+'%', top: s.top+'%', animationDelay: s.delay+'s'}}></div>
            ))}
          </div>
          <div className="v-sun"></div>
          <div className="v-cloud c1"></div>
          <div className="v-cloud c2"></div>
          <div className="v-cloud c3"></div>

          {/* ground + grass tufts */}
          <div className="v-ground"></div>
          <div className="v-grass-row" style={{ top: 405 }}></div>
          <div className="v-grass-row" style={{ top: 645, opacity: 0.6 }}></div>

          {/* paths */}
          <div className="v-path" style={{ left: 380, top: 360, width: 720, height: 28, borderRadius: 4 }}></div>
          <div className="v-path" style={{ left: 540, top: 320, width: 28, height: 240, borderRadius: 4 }}></div>
          <div className="v-path" style={{ left: 760, top: 340, width: 28, height: 200, borderRadius: 4 }}></div>

          {/* trees + ambient */}
          <div className="v-tree" style={{ left: 90, top: 470 }}></div>
          <div className="v-tree" style={{ left: 380, top: 470, transform: 'scale(1.2)' }}></div>
          <div className="v-tree" style={{ left: 1100, top: 580 }}></div>
          <div className="v-tree" style={{ left: 60, top: 360, transform: 'scale(0.8)' }}></div>
          <div className="v-tree" style={{ left: 870, top: 580 }}></div>

          {/* zone signposts */}
          {Object.entries(ZONES).map(([k, z]) => (
            <div key={'sign-'+k} className="v-sign" style={{ left: z.x + z.w/2 - 30, top: z.y + z.h + 12, minWidth: 60, textAlign: 'center'}}>
              {z.sign}
            </div>
          ))}

          {/* zones (buildings) */}
          {Object.entries(ZONES).map(([k, z]) => (
            <VillageZone key={k} k={k} z={z} />
          ))}

          {/* exec banners */}
          {banners.map(b => (
            <div key={b.e.id} className={`v-exec-banner`}
              style={{ left: b.x - 90, top: b.y, width: 180, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis'}}>
              <span className="id">{b.e.id.slice(0,6)}</span>{shortWf(b.e.wf)}
            </div>
          ))}

          {/* sprites */}
          {sprites.map(s => (
            <VillageSprite key={s.id} s={s} onClick={(sp) => setSelected({ sprite: sp })} />
          ))}

          {/* achievement */}
          {achievement && <div className="v-achievement">{achievement.text}</div>}

          {/* selected popover */}
          {selected && selected.sprite && (
            <div className="v-popover" style={{
              left: Math.min(selected.sprite.x + 30, VW - 240),
              top: Math.max(selected.sprite.y - 10, 10),
            }} onClick={(e)=>e.stopPropagation()}>
              <h4>{selected.sprite.name}</h4>
              <div className="meta">team: {selected.sprite.team} · {selected.sprite.execId ? 'on '+selected.sprite.execId.slice(0,8) : 'idle'}</div>
              <div style={{ fontSize: 12, color: 'var(--ink-2)'}}>
                {selected.sprite.execId
                  ? `Working in the ${ZONES[selected.sprite.zoneKey]?.label || 'village'}.`
                  : 'Sitting at the bench, ready for a task.'}
              </div>
              <div className="actions">
                {selected.sprite.execId && (
                  <button className="btn sm" onClick={() => { setRoute && setRoute('executions'); setSelected(null);}}>open run</button>
                )}
                <button className="btn ghost sm" onClick={() => setSelected(null)}>close</button>
              </div>
            </div>
          )}
        </div>

        {/* legend / hud (outside scaled) */}
        {showLegend && (
          <div className="v-legend">
            <h5>teams</h5>
            <div className="lg-row"><div className="lg-swatch" style={{background:'oklch(0.65 0.16 258)'}}></div>planning</div>
            <div className="lg-row"><div className="lg-swatch" style={{background:'oklch(0.70 0.14 30)'}}></div>implement</div>
            <div className="lg-row"><div className="lg-swatch" style={{background:'oklch(0.72 0.14 200)'}}></div>qa</div>
            <div className="lg-row"><div className="lg-swatch" style={{background:'oklch(0.60 0.16 320)'}}></div>security</div>
            <div className="lg-row"><div className="lg-swatch" style={{background:'oklch(0.66 0.16 145)'}}></div>ops</div>
            <div className="lg-row"><div className="lg-swatch" style={{background:'oklch(0.68 0.14 100)'}}></div>builder</div>
          </div>
        )}
      </div>
    </div>
  );
}

function shortWf(wf) {
  if (!wf) return '';
  const last = wf.split('/').pop().replace(/-/g, ' ');
  return ' ' + last.slice(0, 22);
}

// ===== Mini-map for Home =====
function VillageMiniMap({ execs, onOpen }) {
  const sprites = vUseMemo(() => makeInitialSprites(execs).slice(0, 24), [execs.length]);
  return (
    <div className="v-minimap" onClick={onOpen}>
      <div style={{
        position: 'absolute',
        left: '50%', top: '50%',
        width: VW, height: VH,
        transform: `translate(-50%, -50%) scale(${180 / VH})`,
        transformOrigin: 'center',
        pointerEvents: 'none',
      }}>
        <div className="v-sky"></div>
        <div className="v-sun"></div>
        <div className="v-cloud c1"></div>
        <div className="v-ground"></div>
        <div className="v-tree" style={{ left: 90, top: 470 }}></div>
        <div className="v-tree" style={{ left: 1100, top: 580 }}></div>
        {Object.entries(ZONES).filter(([k]) => k !== 'fountain').map(([k,z]) => (
          <VillageZone key={k} k={k} z={z} />
        ))}
        {sprites.map(s => <VillageSprite key={s.id} s={s} onClick={()=>{}} />)}
      </div>
      <div className="v-mini-overlay">
        <div className="v-mini-cta">open village →</div>
      </div>
    </div>
  );
}

window.VillagePage = VillagePage;
window.VillageMiniMap = VillageMiniMap;
