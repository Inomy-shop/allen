import { Link } from 'react-router-dom';

export default function ForbiddenPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-50 p-4">
      <div className="text-center">
        <h1 className="text-3xl font-heading text-theme-primary mb-2">403</h1>
        <p className="text-sm text-theme-muted mb-6">You don't have access to this page.</p>
        <Link to="/" className="text-sm text-accent-blue hover:underline">
          ← Back to dashboard
        </Link>
      </div>
    </div>
  );
}
