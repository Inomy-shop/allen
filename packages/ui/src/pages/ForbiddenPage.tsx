import { Link } from 'react-router-dom';

export default function ForbiddenPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-app p-4 text-theme-primary">
      <div className="text-center">
        <h1 className="text-3xl font-heading text-theme-primary mb-2">403</h1>
        <p className="text-sm text-theme-muted mb-6">You don't have access to this page.</p>
        <Link to="/" className="text-sm text-accent hover:underline">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
