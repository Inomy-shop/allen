import { useState, useEffect, useCallback } from 'react';
import { learnings as api } from '../services/api';
import {
  RefreshCw, Plus, BarChart2, Check, X, Pencil, Trash2,
  Brain, ChevronDown, Sparkles, Eye, Zap, Loader2, Search,
} from 'lucide-react';
import Select from '../components/common/Select';

// ── Type/Scope badge colors ───────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  fact: 'bg-accent-blue/10 text-accent-blue border-accent-blue/20',
  pattern: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  mistake: 'bg-accent-red/10 text-accent-red border-accent-red/20',
  preference: 'bg-accent-green/10 text-accent-green border-accent-green/20',
  skill: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  optimization: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
};

const SCOPE_COLORS: Record<string, string> = {
  global: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
  workflow: 'bg-accent-blue/10 text-accent-blue border-accent-blue/20',
  context: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  role: 'bg-accent-green/10 text-accent-green border-accent-green/20',
  node_pattern: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
};

const TYPES = ['fact', 'pattern', 'mistake', 'preference', 'skill', 'optimization'];
const SCOPES = ['global', 'workflow', 'context', 'role', 'node_pattern'];
const STATUSES = ['active', 'archived', 'superseded', 'evolved'];

// ── Component ─────────────────────────────────────────────────────────────

export default function LearningsPage() {
  const [activeTab, setActiveTab] = useState<'learnings' | 'evolution'>('learnings');
  const [items, setItems] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  // Evolution state
  const [evolutionCandidates, setEvolutionCandidates] = useState<any[]>([]);
  const [evolutionLoading, setEvolutionLoading] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [evolving, setEvolving] = useState(false);

  // Filters
  const [filterScope, setFilterScope] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('active');
  const [search, setSearch] = useState('');

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editType, setEditType] = useState('');
  const [editTags, setEditTags] = useState('');

  // Add form
  const [addContent, setAddContent] = useState('');
  const [addType, setAddType] = useState('fact');
  const [addScope, setAddScope] = useState('global');
  const [addWorkflow, setAddWorkflow] = useState('');
  const [addContextTags, setAddContextTags] = useState('');
  const [addRoleName, setAddRoleName] = useState('');
  const [addTags, setAddTags] = useState('');

  const fetchLearnings = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (filterScope) params.scope = filterScope;
      if (filterType) params.type = filterType;
      if (filterStatus) params.status = filterStatus;
      if (search) params.search = search;
      const data = await api.list(params);
      setItems(data);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [filterScope, filterType, filterStatus, search]);

  const fetchStats = useCallback(async () => {
    try {
      const data = await api.stats();
      setStats(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { fetchLearnings(); }, [fetchLearnings]);

  const handleApprove = async (id: string) => {
    await api.approve(id);
    fetchLearnings();
  };

  const handleReject = async (id: string) => {
    await api.reject(id);
    fetchLearnings();
  };

  const handleDelete = async (id: string) => {
    await api.delete(id);
    fetchLearnings();
  };

  const startEdit = (item: any) => {
    setEditingId(item._id);
    setEditContent(item.content);
    setEditType(item.type);
    setEditTags((item.tags ?? []).join(', '));
  };

  const saveEdit = async () => {
    if (!editingId) return;
    await api.update(editingId, {
      content: editContent,
      type: editType,
      tags: editTags.split(',').map(t => t.trim()).filter(Boolean),
    });
    setEditingId(null);
    fetchLearnings();
  };

  const cancelEdit = () => { setEditingId(null); };

  const handleAdd = async () => {
    const scope: any = { level: addScope };
    if (addScope === 'workflow' && addWorkflow) scope.workflowName = addWorkflow;
    if (addScope === 'context' && addContextTags) {
      scope.contextTags = addContextTags.split(',').map(t => t.trim()).filter(Boolean);
    }
    if (addScope === 'role' && addRoleName) scope.roleName = addRoleName;

    await api.create({
      content: addContent,
      type: addType,
      scope,
      tags: addTags.split(',').map(t => t.trim()).filter(Boolean),
    });

    setShowAdd(false);
    setAddContent('');
    setAddType('fact');
    setAddScope('global');
    setAddWorkflow('');
    setAddContextTags('');
    setAddRoleName('');
    setAddTags('');
    fetchLearnings();
  };

  const toggleStats = () => {
    if (!showStats) fetchStats();
    setShowStats(!showStats);
  };

  const fetchEvolutionCandidates = useCallback(async () => {
    setEvolutionLoading(true);
    try {
      const data = await api.evolutionCandidates();
      setEvolutionCandidates(data.roles ?? []);
    } catch {
      // ignore
    }
    setEvolutionLoading(false);
  }, []);

  const handlePreview = async (roleName: string) => {
    setPreviewLoading(true);
    setPreviewData(null);
    try {
      const data = await api.evolutionPreview(roleName);
      setPreviewData(data);
    } catch {
      // ignore
    }
    setPreviewLoading(false);
  };

  const handleEvolve = async () => {
    if (!previewData?.roleName || !previewData?.newPrompt) return;
    setEvolving(true);
    try {
      await api.evolve(previewData.roleName, previewData.newPrompt);
      setPreviewData(null);
      fetchEvolutionCandidates();
    } catch {
      // ignore
    }
    setEvolving(false);
  };

  useEffect(() => {
    if (activeTab === 'evolution') fetchEvolutionCandidates();
  }, [activeTab, fetchEvolutionCandidates]);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Brain className="w-6 h-6 text-accent-blue" />
          <h1 className="font-heading text-xl font-bold text-white tracking-widest uppercase">Learnings</h1>
        </div>
        <div className="flex items-center gap-2">
          <button title="Add learning" onClick={() => setShowAdd(!showAdd)} className="btn-primary text-xs inline-flex items-center gap-1.5 whitespace-nowrap">
            <Plus className="w-3.5 h-3.5" /> Add Learning
          </button>
          <button title="Toggle statistics" onClick={toggleStats} className="btn-ghost text-xs">
            <BarChart2 className="w-3.5 h-3.5" />
          </button>
          <button title="Refresh learnings" onClick={fetchLearnings} className="btn-ghost text-xs">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tab toggle */}
      <div className="flex items-center gap-1 mb-6 border-b border-border/30 pb-2">
        <button
          onClick={() => setActiveTab('learnings')}
          title="View learnings"
          className={`px-4 py-1.5 text-xs font-heading uppercase tracking-wider rounded-t-sm transition-colors ${
            activeTab === 'learnings'
              ? 'text-accent-blue border-b-2 border-accent-blue'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Learnings
        </button>
        <button
          onClick={() => setActiveTab('evolution')}
          title="Role evolution candidates"
          className={`px-4 py-1.5 text-xs font-heading uppercase tracking-wider rounded-t-sm transition-colors flex items-center gap-1.5 ${
            activeTab === 'evolution'
              ? 'text-accent-blue border-b-2 border-accent-blue'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <Sparkles className="w-3 h-3" /> Evolution
        </button>
      </div>

      {/* Evolution tab */}
      {activeTab === 'evolution' && (
        <div className="space-y-4">
          {/* Preview modal */}
          {previewData && (
            <div className="card p-5 border border-accent-blue/30 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-heading text-sm text-white tracking-wider uppercase">
                  Evolution Preview: {previewData.roleName}
                </h3>
                <button onClick={() => setPreviewData(null)} className="btn-ghost text-xs">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              <div>
                <div className="text-[10px] text-gray-500 font-label uppercase tracking-wider mb-1">Current Prompt</div>
                <div className="bg-surface-200 border border-border/30 rounded-sm p-3 text-xs text-gray-300 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {previewData.currentPrompt || '(empty)'}
                </div>
              </div>

              <div>
                <div className="text-[10px] text-gray-500 font-label uppercase tracking-wider mb-1">Evolved Prompt</div>
                <div className="bg-surface-200 border border-accent-green/20 rounded-sm p-3 text-xs text-gray-200 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {previewData.newPrompt || '(LLM returned empty — try again)'}
                </div>
              </div>

              <div className="text-[10px] text-gray-500 font-mono">
                {previewData.learnings?.length ?? 0} learnings will be marked as "evolved"
              </div>

              <div className="flex justify-end gap-2">
                <button onClick={() => setPreviewData(null)} className="btn-ghost text-xs">Cancel</button>
                <button
                  onClick={handleEvolve}
                  disabled={evolving || !previewData.newPrompt}
                  className="btn-primary text-xs flex items-center gap-1.5"
                >
                  {evolving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                  Apply Evolution
                </button>
              </div>
            </div>
          )}

          {/* Candidates list */}
          {evolutionLoading ? (
            <div className="text-center text-gray-500 font-mono text-sm py-12">LOADING...</div>
          ) : evolutionCandidates.length === 0 ? (
            <div className="text-center text-gray-500 font-mono text-sm py-12">
              NO EVOLUTION CANDIDATES FOUND
              <div className="text-[10px] mt-1 text-gray-600">
                Learnings need confidence &ge; 0.8 and 3+ confirmations
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {evolutionCandidates.filter(c => c.roleName !== '__global__').map((candidate: any) => (
                <div key={candidate.roleName} className="card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="font-heading text-sm text-white tracking-wider">{candidate.roleName}</span>
                      <span className="badge text-[10px] border bg-accent-green/10 text-accent-green border-accent-green/20">
                        {candidate.learningCount} ready
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handlePreview(candidate.roleName)}
                        disabled={previewLoading}
                        className="btn-ghost text-xs flex items-center gap-1"
                      >
                        {previewLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                        Preview
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {candidate.learnings.slice(0, 5).map((l: any, i: number) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-gray-300">
                        <Check className="w-3 h-3 text-accent-green mt-0.5 flex-shrink-0" />
                        <span className="font-body">{l.content}</span>
                      </div>
                    ))}
                    {candidate.learnings.length > 5 && (
                      <div className="text-[10px] text-gray-500 font-mono pl-5">
                        +{candidate.learnings.length - 5} more
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Show global learnings info */}
              {evolutionCandidates.find(c => c.roleName === '__global__') && (
                <div className="card p-4 border-dashed">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-heading text-sm text-gray-400 tracking-wider">Global Learnings</span>
                    <span className="badge text-[10px] border bg-gray-500/10 text-gray-400 border-gray-500/20">
                      {evolutionCandidates.find(c => c.roleName === '__global__')?.learningCount ?? 0} available
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-500 font-body">
                    Global learnings are included when evolving any role.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Learnings tab content */}
      {activeTab === 'learnings' && <>
      {/* Stats panel */}
      {showStats && stats && (
        <div className="card p-4 mb-4 grid grid-cols-4 gap-4 text-xs">
          <div>
            <div className="text-gray-500 font-label uppercase tracking-wider mb-1">Total</div>
            <div className="text-lg font-mono text-white">{stats.total}</div>
          </div>
          <div>
            <div className="text-gray-500 font-label uppercase tracking-wider mb-1">Active</div>
            <div className="text-lg font-mono text-accent-green">{stats.active}</div>
          </div>
          <div>
            <div className="text-gray-500 font-label uppercase tracking-wider mb-1">Archived</div>
            <div className="text-lg font-mono text-gray-400">{stats.archived}</div>
          </div>
          <div>
            <div className="text-gray-500 font-label uppercase tracking-wider mb-1">Superseded</div>
            <div className="text-lg font-mono text-accent-orange">{stats.superseded}</div>
          </div>
          {stats.byType && (
            <div className="col-span-4 flex gap-3 flex-wrap">
              {Object.entries(stats.byType).map(([type, count]) => (
                <span key={type} className={`badge text-[10px] border ${TYPE_COLORS[type] ?? 'bg-gray-500/10 text-gray-400'}`}>
                  {type}: {String(count)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add Learning popup */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-surface-100 border border-border rounded-sm w-full max-w-lg shadow-lg">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
              <h3 className="font-heading text-sm text-white tracking-wider uppercase">Add Learning</h3>
              <button onClick={() => setShowAdd(false)} className="text-gray-400 hover:text-white" title="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-auto">
              <div>
                <label className="block text-[11px] text-gray-500 font-label uppercase tracking-wider mb-1">Content *</label>
                <textarea
                  value={addContent}
                  onChange={e => setAddContent(e.target.value)}
                  placeholder="Learning content..."
                  className="w-full bg-surface-200 border border-accent-blue/30 rounded-sm px-3 py-2 text-sm text-gray-200 font-body focus:outline-none focus:border-accent-blue focus:shadow-glow-blue transition-all resize-y"
                  rows={3}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-gray-500 font-label uppercase tracking-wider mb-1">Type</label>
                  <select value={addType} onChange={e => setAddType(e.target.value)} className="input text-xs w-full">
                    {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-gray-500 font-label uppercase tracking-wider mb-1">Scope</label>
                  <select value={addScope} onChange={e => setAddScope(e.target.value)} className="input text-xs w-full">
                    {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-gray-500 font-label uppercase tracking-wider mb-1">Tags</label>
                  <input
                    value={addTags}
                    onChange={e => setAddTags(e.target.value)}
                    placeholder="tag1, tag2"
                    className="input text-xs w-full"
                  />
                </div>
              </div>
              {addScope === 'workflow' && (
                <div>
                  <label className="block text-[11px] text-gray-500 font-label uppercase tracking-wider mb-1">Workflow Name</label>
                  <input value={addWorkflow} onChange={e => setAddWorkflow(e.target.value)} placeholder="e.g., sdlc" className="input text-xs w-full" />
                </div>
              )}
              {addScope === 'context' && (
                <div>
                  <label className="block text-[11px] text-gray-500 font-label uppercase tracking-wider mb-1">Context Tags</label>
                  <input value={addContextTags} onChange={e => setAddContextTags(e.target.value)} placeholder="repo:/path, language:typescript" className="input text-xs w-full" />
                </div>
              )}
              {addScope === 'role' && (
                <div>
                  <label className="block text-[11px] text-gray-500 font-label uppercase tracking-wider mb-1">Role Name</label>
                  <input value={addRoleName} onChange={e => setAddRoleName(e.target.value)} placeholder="e.g., codex-researcher" className="input text-xs w-full" />
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-border/50">
              <button onClick={() => setShowAdd(false)} className="btn-ghost text-xs inline-flex items-center whitespace-nowrap">Cancel</button>
              <button onClick={handleAdd} disabled={!addContent.trim()} className="btn-primary text-xs inline-flex items-center whitespace-nowrap">Save Learning</button>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Select
          value={filterScope || '__all__'}
          onChange={v => setFilterScope(v === '__all__' ? '' : v)}
          options={[{ value: '__all__', label: 'All Scopes' }, ...SCOPES.map(s => ({ value: s, label: s }))]}
          className="w-36"
        />
        <Select
          value={filterType || '__all__'}
          onChange={v => setFilterType(v === '__all__' ? '' : v)}
          options={[{ value: '__all__', label: 'All Types' }, ...TYPES.map(t => ({ value: t, label: t }))]}
          className="w-36"
        />
        <Select
          value={filterStatus || '__all__'}
          onChange={v => setFilterStatus(v === '__all__' ? '' : v)}
          options={[{ value: '__all__', label: 'All Status' }, ...STATUSES.map(s => ({ value: s, label: s }))]}
          className="w-36"
        />
        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search learnings..."
            className="input text-xs w-full pl-8"
          />
        </div>
      </div>

      {/* Learning cards */}
      {loading ? (
        <div className="text-center text-gray-500 font-mono text-sm py-12">LOADING...</div>
      ) : items.length === 0 ? (
        <div className="text-center text-gray-500 font-mono text-sm py-12">NO LEARNINGS FOUND</div>
      ) : (
        <div className="space-y-3">
          {items.map((item: any) => (
            <LearningCard
              key={item._id}
              item={item}
              isEditing={editingId === item._id}
              editContent={editContent}
              editType={editType}
              editTags={editTags}
              onEditContent={setEditContent}
              onEditType={setEditType}
              onEditTags={setEditTags}
              onStartEdit={() => startEdit(item)}
              onSaveEdit={saveEdit}
              onCancelEdit={cancelEdit}
              onApprove={() => handleApprove(item._id)}
              onReject={() => handleReject(item._id)}
              onDelete={() => handleDelete(item._id)}
            />
          ))}
        </div>
      )}
      </>}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────


function LearningCard({ item, isEditing, editContent, editType, editTags, onEditContent, onEditType, onEditTags, onStartEdit, onSaveEdit, onCancelEdit, onApprove, onReject, onDelete }: {
  item: any;
  isEditing: boolean;
  editContent: string;
  editType: string;
  editTags: string;
  onEditContent: (v: string) => void;
  onEditType: (v: string) => void;
  onEditTags: (v: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onApprove: () => void;
  onReject: () => void;
  onDelete: () => void;
}) {
  const typeBadge = TYPE_COLORS[item.type] ?? 'bg-gray-500/10 text-gray-400';
  const scopeBadge = SCOPE_COLORS[item.scope?.level] ?? 'bg-gray-500/10 text-gray-400';

  return (
    <div className="card p-4 hover:shadow-glow-blue/5 transition-shadow">
      {/* Header: badges + confidence */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`badge text-[10px] border ${typeBadge}`}>{item.type}</span>
          <span className={`badge text-[10px] border ${scopeBadge}`}>{item.scope?.level}</span>
          {item.status !== 'active' && (
            <span className="badge text-[10px] bg-gray-600/10 text-gray-500 border border-gray-600/20">{item.status}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-16 h-1.5 bg-surface-200 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${(item.confidence ?? 0) * 100}%`,
                backgroundColor: item.confidence >= 0.8 ? 'rgb(var(--color-green))'
                  : item.confidence >= 0.5 ? 'rgb(var(--color-accent))'
                  : 'rgb(var(--color-orange))',
              }}
            />
          </div>
          <span className="text-[10px] font-mono text-gray-400">{(item.confidence ?? 0).toFixed(2)}</span>
        </div>
      </div>

      {/* Content */}
      {isEditing ? (
        <div className="space-y-2 mb-3">
          <textarea
            value={editContent}
            onChange={e => onEditContent(e.target.value)}
            className="w-full bg-surface-200 border border-accent-blue/30 rounded-sm px-3 py-2 text-sm text-gray-200 font-body focus:outline-none focus:border-accent-blue focus:shadow-glow-blue transition-all resize-y"
            rows={2}
          />
          <div className="flex gap-2">
            <select value={editType} onChange={e => onEditType(e.target.value)} className="input text-xs">
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input
              value={editTags}
              onChange={e => onEditTags(e.target.value)}
              placeholder="Tags (comma-separated)"
              className="input text-xs flex-1"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={onCancelEdit} className="btn-ghost text-xs">Cancel</button>
            <button onClick={onSaveEdit} className="btn-primary text-xs">Save</button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-200 mb-2 font-body">{item.content}</p>
      )}

      {/* Tags */}
      {item.tags?.length > 0 && !isEditing && (
        <div className="flex flex-wrap gap-1 mb-2">
          {item.tags.map((tag: string, i: number) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-sm bg-surface-200 text-gray-500 font-mono">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Source info + actions */}
      {!isEditing && (
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/30">
          <div className="text-[10px] text-gray-600 font-mono flex items-center gap-2 flex-wrap">
            <span>{item.source?.sourceType}</span>
            {item.source?.workflowName && <span>{item.source.workflowName} run</span>}
            <span>{item.confirmations ?? 0} confirms</span>
            <span>{item.contradictions ?? 0} contradictions</span>
          </div>
          <div className="flex items-center gap-1">
            {item.status === 'active' && (
              <>
                <button onClick={onApprove} className="btn-ghost text-[10px] text-accent-green px-1.5 py-0.5" title="Approve">
                  <Check className="w-3 h-3" />
                </button>
                <button onClick={onReject} className="btn-ghost text-[10px] text-accent-red px-1.5 py-0.5" title="Reject">
                  <X className="w-3 h-3" />
                </button>
              </>
            )}
            <button onClick={onStartEdit} className="btn-ghost text-[10px] text-gray-400 px-1.5 py-0.5" title="Edit">
              <Pencil className="w-3 h-3" />
            </button>
            <button onClick={onDelete} className="btn-ghost text-[10px] text-gray-500 px-1.5 py-0.5" title="Archive">
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
