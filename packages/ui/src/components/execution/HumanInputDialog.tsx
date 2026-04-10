import { useState } from 'react';
import { MessageSquare } from 'lucide-react';

interface Field {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  options?: string[];
  default?: any;
}

interface Props {
  node: string;
  prompt: string;
  fields: Field[];
  onSubmit: (data: Record<string, unknown>) => void;
  onCancel: () => void;
}

export default function HumanInputDialog({ node, prompt, fields, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, any>>(() => {
    const initial: Record<string, any> = {};
    for (const f of fields) {
      if (f.type === 'boolean') initial[f.name] = f.default ?? false;
      else if (f.type === 'select') initial[f.name] = f.default ?? f.options?.[0] ?? '';
      else initial[f.name] = f.default ?? '';
    }
    return initial;
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
          <MessageSquare className="w-5 h-5 text-orange-400" />
          <div>
            <h2 className="text-sm font-semibold text-theme-primary">Input Required</h2>
            <p className="text-xs text-theme-secondary">Node: {node}</p>
          </div>
        </div>

        {prompt && (
          <div className="px-5 py-3 border-b border-border">
            <p className="text-sm text-theme-secondary">{prompt}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {fields.map(field => (
            <div key={field.name}>
              <label className="block text-xs font-medium text-theme-secondary mb-1">
                {field.label ?? field.name}
                {field.required && <span className="text-red-400 ml-0.5">*</span>}
              </label>

              {field.type === 'boolean' ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!values[field.name]}
                    onChange={e => setValues(v => ({ ...v, [field.name]: e.target.checked }))}
                    className="w-4 h-4 rounded bg-surface-200 border-border text-accent-blue focus:ring-accent-blue"
                  />
                  <span className="text-sm text-theme-secondary">Yes</span>
                </label>
              ) : field.type === 'select' ? (
                <select
                  value={values[field.name]}
                  onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))}
                  className="input w-full"
                >
                  {field.options?.map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : field.type === 'text' ? (
                <textarea
                  value={values[field.name]}
                  onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))}
                  className="input w-full h-20 resize-none"
                  required={field.required}
                />
              ) : (
                <input
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={values[field.name]}
                  onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))}
                  className="input w-full"
                  required={field.required}
                />
              )}
            </div>
          ))}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onCancel} className="btn-ghost">
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              Submit
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
