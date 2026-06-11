import { useState, useEffect } from 'react';
import { CheckCircle, XCircle } from 'lucide-react';
import type { DesignPreviewConfig } from '../../services/designService';

interface DesignPreviewConfigFormProps {
  repoId: string;
  config: DesignPreviewConfig | null;
  onSave: (config: DesignPreviewConfig) => Promise<void>;
  onTest: () => Promise<void>;
  disabled?: boolean;
}

const DEFAULT_CONFIG: DesignPreviewConfig = {
  enabled: false,
  workingDirectory: '.',
  installCommand: '',
  buildCommand: '',
  startCommand: '',
  portMode: 'auto',
  fixedPort: undefined,
  healthCheckPath: '',
};

export default function DesignPreviewConfigForm({
  config,
  onSave,
  onTest,
  disabled,
}: DesignPreviewConfigFormProps) {
  const [form, setForm] = useState<DesignPreviewConfig>(config ?? DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ status: 'passed' | 'failed'; logs: string[] } | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof DesignPreviewConfig, string>>>({});

  useEffect(() => {
    if (config) setForm(config);
  }, [config]);

  function validate(): boolean {
    const next: typeof errors = {};
    if (form.enabled && !form.startCommand.trim()) {
      next.startCommand = 'Start command is required when preview is enabled.';
    }
    if (form.enabled && !form.workingDirectory.trim()) {
      next.workingDirectory = 'Working directory is required.';
    }
    if (form.portMode === 'fixed' && (!form.fixedPort || form.fixedPort < 1 || form.fixedPort > 65535)) {
      next.fixedPort = 'Enter a valid port number (1–65535).';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!validate()) return;
    setTesting(true);
    setTestResult(null);
    try {
      await onTest();
    } catch (err: any) {
      setTestResult({ status: 'failed', logs: [err?.message ?? 'Test failed'] });
    } finally {
      setTesting(false);
    }
  }

  function field(id: keyof DesignPreviewConfig) {
    return {
      id,
      className: `h-8 w-full rounded-md border ${errors[id] ? 'border-red-400' : 'border-app'} bg-app px-2.5 text-[12.5px] text-theme-primary outline-none transition-colors focus:border-accent`,
    };
  }

  return (
    <div className="space-y-4">
      {/* Enabled */}
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          id="enabled"
          checked={form.enabled}
          disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          className="h-4 w-4 rounded border-app accent-accent"
        />
        <label htmlFor="enabled" className="text-[13px] font-medium text-theme-primary">
          Enable live preview
        </label>
      </div>

      {/* Working directory */}
      <div>
        <label htmlFor="workingDirectory" className="mb-1 block text-[11.5px] font-medium text-theme-secondary">
          Working directory
        </label>
        <input
          {...field('workingDirectory')}
          type="text"
          placeholder="app or ."
          value={form.workingDirectory}
          disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, workingDirectory: e.target.value }))}
        />
        {errors.workingDirectory && (
          <p className="mt-1 text-[11px] text-red-400">{errors.workingDirectory}</p>
        )}
      </div>

      {/* Install command */}
      <div>
        <label htmlFor="installCommand" className="mb-1 block text-[11.5px] font-medium text-theme-secondary">
          Install command <span className="text-theme-subtle">(optional)</span>
        </label>
        <input
          {...field('installCommand')}
          type="text"
          placeholder="npm ci"
          value={form.installCommand ?? ''}
          disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, installCommand: e.target.value }))}
        />
      </div>

      {/* Build command */}
      <div>
        <label htmlFor="buildCommand" className="mb-1 block text-[11.5px] font-medium text-theme-secondary">
          Build command <span className="text-theme-subtle">(optional)</span>
        </label>
        <input
          {...field('buildCommand')}
          type="text"
          placeholder="npm run build"
          value={form.buildCommand ?? ''}
          disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, buildCommand: e.target.value }))}
        />
      </div>

      {/* Start command */}
      <div>
        <label htmlFor="startCommand" className="mb-1 block text-[11.5px] font-medium text-theme-secondary">
          Start command {form.enabled && <span className="text-red-400">*</span>}
        </label>
        <input
          {...field('startCommand')}
          type="text"
          placeholder="npm run dev"
          value={form.startCommand}
          disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, startCommand: e.target.value }))}
        />
        {errors.startCommand && (
          <p className="mt-1 text-[11px] text-red-400">{errors.startCommand}</p>
        )}
      </div>

      {/* Port mode */}
      <div>
        <label htmlFor="portMode" className="mb-1 block text-[11.5px] font-medium text-theme-secondary">
          Port mode
        </label>
        <select
          id="portMode"
          value={form.portMode}
          disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, portMode: e.target.value as 'auto' | 'fixed' }))}
          className="h-8 w-full rounded-md border border-app bg-app px-2.5 text-[12.5px] text-theme-primary outline-none transition-colors focus:border-accent"
        >
          <option value="auto">Auto-detect</option>
          <option value="fixed">Fixed port</option>
        </select>
      </div>

      {/* Fixed port */}
      {form.portMode === 'fixed' && (
        <div>
          <label htmlFor="fixedPort" className="mb-1 block text-[11.5px] font-medium text-theme-secondary">
            Fixed port
          </label>
          <input
            {...field('fixedPort')}
            type="number"
            min={1}
            max={65535}
            placeholder="3000"
            value={form.fixedPort ?? ''}
            disabled={disabled}
            onChange={(e) => setForm((f) => ({ ...f, fixedPort: e.target.value ? Number(e.target.value) : undefined }))}
          />
          {errors.fixedPort && (
            <p className="mt-1 text-[11px] text-red-400">{errors.fixedPort}</p>
          )}
        </div>
      )}

      {/* Health check path */}
      <div>
        <label htmlFor="healthCheckPath" className="mb-1 block text-[11.5px] font-medium text-theme-secondary">
          Health check path <span className="text-theme-subtle">(optional)</span>
        </label>
        <input
          {...field('healthCheckPath')}
          type="text"
          placeholder="/"
          value={form.healthCheckPath ?? ''}
          disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, healthCheckPath: e.target.value }))}
        />
      </div>

      {/* Commands preview (REQ-036) */}
      {(form.installCommand || form.buildCommand || form.startCommand) && (
        <div className="rounded-md border border-app bg-app-muted px-3 py-2.5">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-theme-subtle">
            Commands that will run
          </p>
          <pre className="space-y-0.5 font-mono text-[11.5px] text-theme-secondary">
            {form.installCommand && <div>$ {form.installCommand}</div>}
            {form.buildCommand && <div>$ {form.buildCommand}</div>}
            {form.startCommand && <div>$ {form.startCommand}</div>}
          </pre>
        </div>
      )}

      {/* Test result */}
      {testResult && (
        <div className={`flex items-start gap-2 rounded-md border p-3 text-[12px] ${
          testResult.status === 'passed'
            ? 'border-green-500/30 bg-green-500/10 text-green-600'
            : 'border-red-400/30 bg-red-400/10 text-red-500'
        }`}>
          {testResult.status === 'passed'
            ? <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
            : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          }
          <div>
            <p className="font-medium">{testResult.status === 'passed' ? 'Preview passed' : 'Preview failed'}</p>
            {testResult.logs.length > 0 && (
              <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">
                {testResult.logs.join('\n')}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={disabled || saving}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-app bg-app-card px-3 text-[12.5px] font-medium text-theme-primary transition-colors hover:border-app-strong hover:bg-app-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save config'}
        </button>
        <button
          type="button"
          onClick={handleTest}
          disabled={disabled || testing || !form.enabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/30 bg-accent-soft px-3 text-[12.5px] font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {testing ? 'Testing…' : 'Test preview'}
        </button>
      </div>
    </div>
  );
}
