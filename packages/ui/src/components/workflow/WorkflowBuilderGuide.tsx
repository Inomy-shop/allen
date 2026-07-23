import { useRef } from 'react';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

/* ── Theme tokens reused inside the SVG figures so they match the canvas ── */
const cBlue = 'rgb(var(--color-accent-blue))';
const cYellow = 'rgb(var(--color-accent-yellow))';
const cPurple = 'rgb(var(--color-accent-purple))';
const cEdge = 'rgb(var(--color-flow-edge-default))';
const cCond = 'rgb(var(--color-flow-edge-conditional))';
const cRetry = 'rgb(var(--color-flow-edge-retry))';
const cText = 'rgb(var(--color-text-primary))';
const cSub = 'rgb(var(--color-text-muted))';
const cCard = 'rgb(var(--color-surface-100))';
const cMuted = 'rgb(var(--color-surface-200))';

/** Pill used to render a node/edge/value type inline, colour-matched to the canvas. */
function Tag({ children, tone = 'blue' }: { children: React.ReactNode; tone?: 'blue' | 'yellow' | 'green' | 'purple' | 'red' | 'muted' }) {
  const tones: Record<string, string> = {
    blue: 'bg-accent-blue/10 text-accent-blue',
    yellow: 'bg-accent-yellow/10 text-accent-yellow',
    green: 'bg-accent-green/10 text-accent-green',
    purple: 'bg-accent-purple/10 text-accent-purple',
    red: 'bg-accent-red/10 text-accent-red',
    muted: 'bg-app-muted text-theme-secondary',
  };
  return <span className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm ${tones[tone]}`}>{children}</span>;
}

const Cls = 'font-mono text-[11px] bg-app-muted text-theme-primary px-1 py-0.5 rounded-sm';
const Code = ({ children }: { children: React.ReactNode }) => <code className={Cls}>{children}</code>;

function Block({ children }: { children: string }) {
  return <pre className="bg-app-sunken rounded-md border border-app p-3 text-[11px] font-mono text-theme-primary overflow-auto leading-relaxed">{children}</pre>;
}

function Field({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <code className={`${Cls} shrink-0`}>{name}</code>
      <span className="text-theme-secondary">{children}</span>
    </li>
  );
}

function Figure({ children, caption }: { children: React.ReactNode; caption: string }) {
  return (
    <figure className="rounded-md border border-app bg-app-muted/30 px-3 pt-3 pb-2 my-1">
      <div className="flex justify-center">{children}</div>
      <figcaption className="mt-1.5 text-center text-[10.5px] text-theme-subtle font-mono">{caption}</figcaption>
    </figure>
  );
}

/* ── SVG figure primitives ──────────────────────────────────────────────── */
function NodeBox({ x, y, w = 96, h = 40, label, sub, stroke = cBlue }: { x: number; y: number; w?: number; h?: number; label: string; sub?: string; stroke?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} style={{ fill: cCard, stroke }} strokeWidth={1.5} />
      <text x={x + w / 2} y={sub ? y + h / 2 - 2 : y + h / 2 + 4} textAnchor="middle" style={{ fill: cText }} fontSize={11} fontWeight={600} fontFamily="monospace">{label}</text>
      {sub && <text x={x + w / 2} y={y + h / 2 + 11} textAnchor="middle" style={{ fill: cSub }} fontSize={8} fontFamily="monospace">{sub}</text>}
    </g>
  );
}

function Pill({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <g>
      <rect x={x} y={y} width={58} height={26} rx={13} style={{ fill: cMuted, stroke: 'rgb(var(--color-border-strong))' }} strokeWidth={1} />
      <text x={x + 29} y={y + 17} textAnchor="middle" style={{ fill: cText }} fontSize={9} fontWeight={600} fontFamily="monospace">{label}</text>
    </g>
  );
}

function Dot({ cx, cy, color = cBlue }: { cx: number; cy: number; color?: string }) {
  return <circle cx={cx} cy={cy} r={3.2} style={{ fill: color, stroke: cCard }} strokeWidth={1.2} />;
}

/* ── Figures ────────────────────────────────────────────────────────────── */
const FigFlow = () => (
  <svg viewBox="0 0 360 64" width="360" height="64">
    <defs><marker id="ff-edge" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style={{ fill: cEdge }} /></marker></defs>
    <Pill x={6} y={19} label="INPUT" />
    <line x1={64} y1={32} x2={128} y2={32} style={{ stroke: cEdge }} strokeWidth={1.6} markerEnd="url(#ff-edge)" />
    <NodeBox x={132} y={12} label="implement" sub="AGENT" />
    <line x1={228} y1={32} x2={292} y2={32} style={{ stroke: cEdge }} strokeWidth={1.6} markerEnd="url(#ff-edge)" />
    <Pill x={296} y={19} label="END" />
  </svg>
);

const FigNode = () => (
  <svg viewBox="0 0 240 110" width="240" height="110">
    <NodeBox x={66} y={36} w={108} h={44} label="review" sub="AGENT" />
    <Dot cx={120} cy={36} /><Dot cx={120} cy={80} /><Dot cx={66} cy={58} color={cYellow} /><Dot cx={174} cy={58} color={cYellow} />
    <text x={120} y={22} textAnchor="middle" style={{ fill: cSub }} fontSize={8.5} fontFamily="monospace">top — incoming flow</text>
    <text x={120} y={100} textAnchor="middle" style={{ fill: cSub }} fontSize={8.5} fontFamily="monospace">bottom — outgoing flow</text>
    <text x={20} y={61} textAnchor="middle" style={{ fill: cSub }} fontSize={8.5} fontFamily="monospace">side</text>
    <text x={216} y={61} textAnchor="middle" style={{ fill: cSub }} fontSize={8.5} fontFamily="monospace">side</text>
  </svg>
);

const FigBranch = () => (
  <svg viewBox="0 0 340 120" width="340" height="120">
    <defs><marker id="fb-cond" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style={{ fill: cCond }} /></marker></defs>
    <NodeBox x={122} y={8} label="classify" sub="AGENT" />
    <path d="M150 48 L150 70 L70 70 L70 84" fill="none" style={{ stroke: cCond }} strokeWidth={1.6} markerEnd="url(#fb-cond)" />
    <path d="M210 48 L210 70 L270 70 L270 84" fill="none" style={{ stroke: cCond }} strokeWidth={1.6} markerEnd="url(#fb-cond)" />
    <rect x={92} y={60} width={66} height={15} rx={3} style={{ fill: cCard, stroke: cCond }} strokeWidth={1} />
    <text x={125} y={71} textAnchor="middle" style={{ fill: cText }} fontSize={8} fontFamily="monospace">severity high</text>
    <rect x={250} y={60} width={62} height={15} rx={3} style={{ fill: cCard, stroke: cCond }} strokeWidth={1} />
    <text x={281} y={71} textAnchor="middle" style={{ fill: cText }} fontSize={8} fontFamily="monospace">severity low</text>
    <NodeBox x={22} y={84} label="escalate" />
    <NodeBox x={222} y={84} label="auto-fix" />
  </svg>
);

const FigParallel = () => (
  <svg viewBox="0 0 340 120" width="340" height="120">
    <defs><marker id="fp-edge" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style={{ fill: cEdge }} /></marker></defs>
    <NodeBox x={122} y={6} label="plan" />
    <path d="M150 46 L150 58 L70 58 L70 70" fill="none" style={{ stroke: cEdge }} strokeWidth={1.6} markerEnd="url(#fp-edge)" />
    <path d="M210 46 L210 58 L270 58 L270 70" fill="none" style={{ stroke: cEdge }} strokeWidth={1.6} markerEnd="url(#fp-edge)" />
    <NodeBox x={26} y={70} w={88} label="build" />
    <NodeBox x={226} y={70} w={88} label="document" />
    <text x={170} y={56} textAnchor="middle" style={{ fill: cSub }} fontSize={8} fontFamily="monospace">parallel · join: wait-all</text>
  </svg>
);

const FigRetry = () => (
  <svg viewBox="0 0 320 96" width="320" height="96">
    <defs>
      <marker id="fr-edge" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style={{ fill: cEdge }} /></marker>
      <marker id="fr-retry" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" style={{ fill: cRetry }} /></marker>
    </defs>
    <NodeBox x={26} y={28} label="implement" />
    <line x1={122} y1={48} x2={186} y2={48} style={{ stroke: cEdge }} strokeWidth={1.6} markerEnd="url(#fr-edge)" />
    <NodeBox x={190} y={28} label="validate" />
    <path d="M238 28 L238 10 L74 10 L74 28" fill="none" style={{ stroke: cRetry, strokeDasharray: '5 4' }} strokeWidth={1.6} markerEnd="url(#fr-retry)" />
    <rect x={132} y={2} width={56} height={15} rx={3} style={{ fill: cCard, stroke: cRetry }} strokeWidth={1} />
    <text x={160} y={13} textAnchor="middle" style={{ fill: cText }} fontSize={8} fontFamily="monospace">↻ ≤ 3</text>
    <text x={160} y={74} textAnchor="middle" style={{ fill: cSub }} fontSize={8.5} fontFamily="monospace">valid == false → retry implement</text>
  </svg>
);

const FigHuman = () => (
  <svg viewBox="0 0 250 112" width="250" height="112">
    <rect x={20} y={8} width={210} height={96} rx={8} style={{ fill: cCard, stroke: cPurple }} strokeWidth={1.5} />
    <text x={32} y={26} style={{ fill: cText }} fontSize={10} fontWeight={700} fontFamily="monospace">Approve the change?</text>
    <text x={32} y={42} style={{ fill: cSub }} fontSize={8.5} fontFamily="monospace">3 files changed · diff attached</text>
    <rect x={32} y={56} width={70} height={20} rx={5} style={{ fill: 'rgb(var(--color-accent-green) / 0.15)', stroke: 'rgb(var(--color-accent-green))' }} strokeWidth={1} />
    <text x={67} y={69} textAnchor="middle" style={{ fill: 'rgb(var(--color-accent-green))' }} fontSize={8.5} fontFamily="monospace">Approve</text>
    <rect x={110} y={56} width={94} height={20} rx={5} style={{ fill: 'rgb(var(--color-accent-yellow) / 0.15)', stroke: 'rgb(var(--color-accent-yellow))' }} strokeWidth={1} />
    <text x={157} y={69} textAnchor="middle" style={{ fill: 'rgb(var(--color-accent-yellow))' }} fontSize={8.5} fontFamily="monospace">Request changes</text>
    <text x={32} y={94} style={{ fill: cSub }} fontSize={8} fontFamily="monospace">approve → continue · changes → retry implement</text>
  </svg>
);

function SectionHead({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-accent-blue/10 text-accent-blue text-[10px] font-mono font-semibold shrink-0">{n}</span>
      <h3 className="text-[14.5px] font-semibold text-theme-primary">{title}</h3>
    </div>
  );
}

function Section({ id, n, title, children }: { id: string; n: number; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-2">
      <SectionHead n={n} title={title} />
      <div className="space-y-2.5 text-[12.5px] leading-relaxed text-theme-secondary font-body">{children}</div>
    </section>
  );
}

const SECTIONS: { id: string; title: string }[] = [
  { id: 'overview', title: 'Overview' },
  { id: 'anatomy', title: 'Workflow anatomy' },
  { id: 'inputs', title: 'Inputs' },
  { id: 'context', title: 'Context' },
  { id: 'nodes', title: 'Nodes — common' },
  { id: 'agent', title: 'Agent nodes' },
  { id: 'code', title: 'Code nodes' },
  { id: 'human', title: 'Human nodes (HITL)' },
  { id: 'subworkflow', title: 'Sub-workflow nodes' },
  { id: 'condition', title: 'Condition nodes' },
  { id: 'outputs', title: 'Outputs & extraction' },
  { id: 'templating', title: 'Templating' },
  { id: 'edges', title: 'Edges' },
  { id: 'conditions', title: 'Conditions (filtrex)' },
  { id: 'parallel', title: 'Parallel & join/merge' },
  { id: 'retries', title: 'Retries & loops' },
  { id: 'gates', title: 'Auto-gates' },
  { id: 'sessions', title: 'Sessions & loops' },
  { id: 'overrides', title: 'Model & MCP overrides' },
  { id: 'validate', title: 'Validate, Save, Run' },
  { id: 'example', title: 'Full YAML example' },
];

/**
 * In-app reference for building workflows — covers every workflow capability
 * (nodes, edges, inputs, outputs, conditions, retries, parallelism, HITL,
 * sub-workflows, sessions, overrides), with canvas-styled figures, grounded in
 * the engine schema.
 */
export default function WorkflowBuilderGuide({ onClose }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const goto = (id: string) => bodyRef.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-md p-6" onClick={onClose}>
      <div className="card w-full max-w-[1160px] h-[90vh] flex flex-col overflow-hidden shadow-popover" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-app shrink-0 bg-app-card">
          <div>
            <h2 className="text-[17px] font-semibold text-theme-primary tracking-tight">Workflow reference</h2>
            <p className="text-[12px] text-theme-muted font-body mt-0.5">A complete guide to building workflows — every node, edge, field, and behaviour.</p>
          </div>
          <button onClick={onClose} title="Close" className="btn-ghost p-1.5 text-theme-muted hover:text-theme-primary">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* TOC */}
          <nav className="w-60 shrink-0 border-r border-app overflow-auto py-3 px-2.5 hidden md:block bg-app-muted/20">
            <div className="overline px-2.5 mb-1.5">Contents</div>
            {SECTIONS.map((s, i) => (
              <button
                key={s.id}
                onClick={() => goto(s.id)}
                className="flex w-full items-center gap-2 text-left px-2.5 py-1.5 rounded-sm text-[12px] text-theme-secondary hover:bg-app-muted hover:text-theme-primary transition-colors"
              >
                <span className="text-[10px] font-mono text-theme-subtle w-4 shrink-0">{i + 1}</span>
                <span className="truncate">{s.title}</span>
              </button>
            ))}
          </nav>

          {/* Content */}
          <div ref={bodyRef} className="flex-1 overflow-auto px-8 py-6 space-y-8">
            <Section id="overview" n={1} title="Overview">
              <p>
                A workflow is a directed graph that runs from the <Tag tone="muted">INPUT</Tag> node to <Tag tone="muted">END</Tag>.
                <strong className="text-theme-primary"> Nodes</strong> are the steps; <strong className="text-theme-primary">edges</strong> are the arrows that decide what
                runs next. The engine walks the graph, runs each node, writes its outputs into a shared <strong className="text-theme-primary">state</strong>, and follows
                whichever edges match. Author it on the <strong className="text-theme-primary">Visual</strong> canvas or in <strong className="text-theme-primary">YAML</strong> — both stay in sync.
              </p>
              <Figure caption="The simplest workflow: INPUT → one agent step → END"><FigFlow /></Figure>
              <p><strong className="text-theme-primary">Build order:</strong> add nodes → configure each → connect them with edges → declare inputs on the INPUT node → set edge conditions/retries → Validate → Save → Run.</p>
              <p className="text-[11.5px] text-theme-subtle">The entry node is labelled <Tag tone="muted">INPUT</Tag> on the canvas; in YAML it's the reserved keyword <Code>START</Code> (so edges read <Code>from: START</Code>).</p>
            </Section>

            <Section id="anatomy" n={2} title="Workflow anatomy">
              <p>Every workflow has these top-level parts:</p>
              <ul className="space-y-1.5">
                <Field name="name">Unique identifier for the workflow.</Field>
                <Field name="description">Human description (shown in lists).</Field>
                <Field name="version">Integer; bump when you change the contract.</Field>
                <Field name="context">Runtime requirements — repos, tools, secrets, concurrency (see Context).</Field>
                <Field name="input">The schema of fields the user supplies at run time (see Inputs).</Field>
                <Field name="nodes">Map of node name → node definition (the steps).</Field>
                <Field name="edges">List of connections between nodes (the flow).</Field>
              </ul>
            </Section>

            <Section id="inputs" n={3} title="Inputs">
              <p>Select the <Tag tone="muted">INPUT</Tag> node to edit the input schema — the form the user fills in when running the workflow. Each field becomes available everywhere as <Code>{'{{field_name}}'}</Code>. Per field:</p>
              <ul className="space-y-1.5">
                <Field name="type">string · number · boolean · object · array.</Field>
                <Field name="required">Whether the run form enforces it.</Field>
                <Field name="default">Value used when the user leaves it blank.</Field>
                <Field name="description">Help text / placeholder in the run form.</Field>
                <Field name="enum">Allowed values — renders a dropdown regardless of type.</Field>
                <Field name="widget">UI hint: text · textarea · checkbox · select · repo_picker · number. Defaults from the type.</Field>
                <Field name="label / placeholder">Override the field's display label / placeholder.</Field>
                <Field name="min / max">Inclusive bounds for number inputs.</Field>
              </ul>
            </Section>

            <Section id="context" n={4} title="Context">
              <p>Also on the INPUT panel — declares what the workflow needs to run:</p>
              <ul className="space-y-1.5">
                <Field name="requires">Repo ids / capabilities that must be present.</Field>
                <Field name="tools">Tool names the workflow uses.</Field>
                <Field name="secrets">Secret names to inject (values are redacted in traces).</Field>
                <Field name="concurrency">Max nodes the engine runs in parallel.</Field>
              </ul>
            </Section>

            <Section id="nodes" n={5} title="Nodes — common fields">
              <p>Connect to a node through its four dots (handles): the top/bottom carry the main flow, the sides are used for retry loops. Pick a node's <Code>type</Code> in the panel; these fields apply to most types:</p>
              <Figure caption="A node's handles — drag from a dot to draw an edge"><FigNode /></Figure>
              <ul className="space-y-1.5">
                <Field name="type">agent · code · human · workflow · condition (default agent).</Field>
                <Field name="outputs">Declared results — key + description (see Outputs).</Field>
                <Field name="timeout">Max seconds before the node is cancelled.</Field>
                <Field name="output_format">json (parse the response by output keys) or freeform (store raw text). Agent nodes.</Field>
                <Field name="session_key">Per-instance session isolation for loops (see Sessions).</Field>
                <Field name="resume_on_retry">Resume the agent's prior session on retry (default true; set false for stateless reviewers).</Field>
              </ul>
            </Section>

            <Section id="agent" n={6} title="Agent nodes">
              <p><Tag tone="blue">agent</Tag> runs an AI agent. Configure:</p>
              <ul className="space-y-1.5">
                <Field name="agent">Which agent persona runs this step.</Field>
                <Field name="prompt">The instruction. Use <Code>{'{{variables}}'}</Code> to pull from inputs / upstream outputs.</Field>
                <Field name="outputs">What the agent must return (drives the response-format block).</Field>
              </ul>
              <p>Open <strong className="text-theme-primary">Model &amp; MCP servers</strong> for per-node overrides — provider, model, reasoning effort, plan mode, and which MCP servers/tools the node may use (see Overrides).</p>
            </Section>

            <Section id="code" n={7} title="Code nodes">
              <p><Tag tone="muted">code</Tag> runs a built-in function deterministically (no LLM):</p>
              <ul className="space-y-1.5">
                <Field name="function">e.g. create-workspace, git-create-branch, git-commit, git-push, git-create-pr, run-build, run-tests, classify-task.</Field>
                <Field name="config">Object of parameters passed to the function.</Field>
                <Field name="retries">How many times to retry on failure.</Field>
                <Field name="backoff">exponential · linear · fixed delay between retries.</Field>
                <Field name="backoff_base_ms">Base delay in milliseconds.</Field>
                <Field name="retry_on">Error substrings that should trigger a retry.</Field>
                <Field name="on_failure">fail (stop) · skip (continue past) · fallback (use fallback_value).</Field>
                <Field name="fallback_value">Object returned as the node's output when on_failure = fallback.</Field>
              </ul>
            </Section>

            <Section id="human" n={8} title="Human nodes (human-in-the-loop)">
              <p><Tag tone="purple">human</Tag> pauses the run for a person. Two layers:</p>
              <p><strong className="text-theme-primary">Fields</strong> — a simple form: each field has a name, type (string · text · textarea · boolean · number · select), label, required flag, and options (for select). Plus <Code>timeout_action</Code> (cancel · apply defaults) for when no one responds.</p>
              <p><strong className="text-theme-primary">Presentation</strong> — a rich approval / escalation gate:</p>
              <Figure caption="An approval gate built from actions + routes"><FigHuman /></Figure>
              <ul className="space-y-1.5">
                <Field name="kind">clarify (ask for info) · review (approve/changes) · recover (after a failure).</Field>
                <Field name="widget">dynamic_form · approval_gate · retry_exhausted_gate · escalation_gate.</Field>
                <Field name="title / summary / question">Heading, context, and the decision to make.</Field>
                <Field name="highlights">Key bullet points to surface.</Field>
                <Field name="evidence">Supporting items — each a label + type (text · artifact · url · diff · log) + value/url.</Field>
                <Field name="actions">The buttons. Each has an id, label, intent (submit · approve · request_changes · reject · retry · override · abandon), optional warning, feedback required/optional flags, and a <strong className="text-theme-primary">route</strong>.</Field>
                <Field name="route">Where the chosen action goes: continue · retry · end, with an optional target node.</Field>
              </ul>
            </Section>

            <Section id="subworkflow" n={9} title="Sub-workflow nodes">
              <p><Tag tone="green">workflow</Tag> runs another saved workflow as one step:</p>
              <ul className="space-y-1.5">
                <Field name="workflow">Name of the sub-workflow to run.</Field>
                <Field name="input_map">Sub-workflow input ← value from this workflow's state.</Field>
                <Field name="output_map">This node's output key ← sub-workflow output.</Field>
              </ul>
            </Section>

            <Section id="condition" n={10} title="Condition nodes">
              <p><Tag tone="yellow">condition</Tag> is an explicit branch point. List named branches, each with a filtrex expression:</p>
              <Block>{`conditions:
  - { name: is_critical, expression: 'severity == "critical"' }
  - { name: otherwise,    expression: 'true' }`}</Block>
              <p>Outgoing edges reference a branch by its <Code>name</Code>. (You can also branch purely with conditional edges — condition nodes just make the fork explicit.)</p>
            </Section>

            <Section id="outputs" n={11} title="Outputs & extraction">
              <p>Declare a node's <strong className="text-theme-primary">outputs</strong> as <em>key + description</em>. The description is injected into the agent's response-format block so it returns exactly those keys. Downstream nodes read them with <Code>{'{{key}}'}</Code>.</p>
              <p>The engine extracts outputs from the raw response in layers, in order: (1) whole response as JSON → (2) a <Code>```json</Code> block → (3) JSON embedded in text → (4) per-key regex (advanced) → (5) <Code>key: value</Code> lines → (6) an LLM fallback that pulls the fields out. Set <Code>output_format: json</Code> to make the agent return clean JSON and skip the guessing.</p>
            </Section>

            <Section id="templating" n={12} title="Templating">
              <p>Prompts and several fields are templates rendered against the run state:</p>
              <ul className="space-y-1.5">
                <Field name="{{var}}">Insert an input or an upstream output.</Field>
                <Field name="{{nodes.x.status}}">Dotted paths into structured state.</Field>
                <Field name="{{#if retry_context}}…{{/if}}">Conditionally include a block (e.g. retry feedback).</Field>
                <Field name='{{default x "fallback"}}'>Use a fallback when a value is missing.</Field>
                <Field name="{{human.<node>.latest.decision}}">Read a human node's latest decision / feedback.</Field>
              </ul>
            </Section>

            <Section id="edges" n={13} title="Edges">
              <p>Drag between node dots to connect them, then select an edge to configure it. An edge carries:</p>
              <ul className="space-y-1.5">
                <Field name="from / to">Source / target node. Either can be a <em>list</em> for fan-out / fan-in.</Field>
                <Field name="condition">Filtrex expression — edge is only taken when truthy (see Conditions).</Field>
                <Field name="parallel">Fork into concurrent branches (see Parallel).</Field>
                <Field name="join">How parallel branches reconverge.</Field>
                <Field name="merge">Per-output-key merge strategy at the join.</Field>
                <Field name="max_retries">Bound for a backward (retry) edge.</Field>
                <Field name="retry_context">Templated feedback injected into the re-run.</Field>
              </ul>
              <p>Edges colour-code on the canvas: grey = plain, purple = conditional, dashed amber = retry, animated = parallel.</p>
              <Figure caption="A conditional branch: two edges with conditions leaving one node"><FigBranch /></Figure>
            </Section>

            <Section id="conditions" n={14} title="Conditions (filtrex)">
              <p>Conditions are <strong className="text-theme-primary">filtrex</strong> expressions that must evaluate truthy. They support:</p>
              <ul className="space-y-1.5">
                <Field name="logic">and · or · not</Field>
                <Field name="compare">== · != · &gt; · &gt;= · &lt; · &lt;=</Field>
                <Field name="membership">value in (a, b, c)</Field>
                <Field name="paths">dotted state — e.g. nodes.review.status, human.gate.latest.decision</Field>
              </ul>
              <Block>{`severity == "high"
valid == false and attempts < 3
human.approval.latest.decision in ("approve", "override")`}</Block>
            </Section>

            <Section id="parallel" n={15} title="Parallel & join / merge">
              <p>To run steps concurrently, mark the edges leaving a node <strong className="text-theme-primary">Parallel</strong> (or use a list <Code>to</Code>). When branches reconverge into one node, set:</p>
              <Figure caption="Fan out into parallel branches, then join"><FigParallel /></Figure>
              <ul className="space-y-1.5">
                <Field name="join">wait-all (all branches finish) · wait-any (first finish) · fail-fast (abort if any fails).</Field>
                <Field name="merge">per output key: last · concat · min · max · all · any — how to combine the branches' values.</Field>
              </ul>
              <Block>{`- from: plan
  to: [build, document]
  parallel: true
  join: wait-all
  merge: { changed_files: concat }`}</Block>
            </Section>

            <Section id="retries" n={16} title="Retries & loops">
              <p>To re-run a step until it passes, draw an edge from a later node <em>back</em> to an earlier one and enable <strong className="text-theme-primary">Retry loop</strong>:</p>
              <Figure caption="A bounded retry loop (dashed amber back-edge)"><FigRetry /></Figure>
              <ul className="space-y-1.5">
                <Field name="max_retries">Bounds the loop so it can't run forever.</Field>
                <Field name="retry_context">Feedback fed into the re-run — reference it in the prompt with <Code>{'{{#if retry_context}}…{{/if}}'}</Code>.</Field>
              </ul>
              <Block>{`- from: validate
  to: implement
  condition: 'valid == false'
  max_retries: 3
  retry_context: '{{validate.report}}'`}</Block>
              <p>When retries are exhausted the engine can route to a recovery / escalation human node. Code nodes have their own retry / backoff / on-failure settings instead.</p>
            </Section>

            <Section id="gates" n={17} title="Auto-gates">
              <p>Any agent node can short-circuit the graph by returning a control action in its output, without you wiring an edge for it:</p>
              <ul className="space-y-1.5">
                <Field name="continue">Normal — follow the edges (default).</Field>
                <Field name="stop">Task already done — exit the graph gracefully.</Field>
                <Field name="skip">Skip the rest — exit gracefully.</Field>
                <Field name="clarify">Pause and ask the human for more information.</Field>
              </ul>
            </Section>

            <Section id="sessions" n={18} title="Sessions & loops">
              <p>By default the engine keeps one agent session per node name, so a looping node sees its prior iterations on resume. Set <Code>session_key</Code> to a template to isolate sessions per iteration:</p>
              <Block>{`session_key: "implementer:{{current_milestone_id}}"`}</Block>
              <p>Each distinct rendered value gets its own fresh session — useful for per-item loops where iterations shouldn't share context.</p>
            </Section>

            <Section id="overrides" n={19} title="Model & MCP overrides">
              <p>On an agent node, <strong className="text-theme-primary">Model &amp; MCP servers</strong> overrides the agent's defaults <em>for this node only</em> (the agent doc is never modified):</p>
              <ul className="space-y-1.5">
                <Field name="provider / model">Run on a specific model — provider and model are saved together so the engine dispatches to the matching provider.</Field>
                <Field name="reasoningEffort">off · low · medium · high · xhigh · max · ultra (model-dependent).</Field>
                <Field name="planMode">Read-and-plan only (Claude only).</Field>
                <Field name="MCP access">Which external MCP servers and which Allen tools this node may use.</Field>
              </ul>
            </Section>

            <Section id="validate" n={20} title="Validate, Save, Run">
              <p><strong className="text-theme-primary">Validate</strong> checks the graph: INPUT/END reachability, orphan nodes, valid condition expressions, retry-edge bounds, and parallel/join sanity — surfacing errors and warnings. <strong className="text-theme-primary">Save</strong> persists the definition. <strong className="text-theme-primary">Run</strong> opens the input form and starts an execution you can watch. The <strong className="text-theme-primary">YAML</strong> tab shows the full definition and a live diagram; you can hand-edit there and switch back.</p>
            </Section>

            <Section id="example" n={21} title="Full YAML example">
              <p>A minimal but complete workflow showing inputs, an agent node with outputs, a conditional branch, a retry loop, and an approval gate:</p>
              <Block>{`name: fix-and-review
version: 1
context:
  requires: [my-repo]

input:
  task: { type: string, required: true, widget: textarea }
  severity: { type: string, enum: [low, high], default: low }

nodes:
  implement:
    agent: engineer
    prompt: |
      Implement: {{task}} (severity {{severity}})
      {{#if retry_context}}Fix this feedback: {{retry_context}}{{/if}}
    outputs:
      patch: "Unified diff of the change."
      done: "true | false"

  review:
    type: human
    human:
      kind: review
      title: "Approve the change?"
      actions:
        - { id: approve, intent: approve, route: { type: continue } }
        - { id: rework,  intent: request_changes, feedbackRequired: true,
            route: { type: retry, targetNode: implement } }

edges:
  - { from: START, to: implement }
  - { from: implement, to: review, condition: 'done == true' }
  - { from: review, to: implement, max_retries: 3,
      retry_context: '{{human.review.latest.feedback.value}}' }
  - { from: review, to: END, condition: 'human.review.latest.decision == "approve"' }`}</Block>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
