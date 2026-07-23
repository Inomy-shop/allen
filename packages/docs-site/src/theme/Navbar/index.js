import React from 'react';

const SITE_URL = 'https://askallen.build';
const GITHUB_URL = 'https://github.com/Inomy-shop/allen';

function GitHubIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

export default function Navbar() {
  return (
    <header className="navbar nav" data-docs-nav="allen-site-header">
      <div className="container nav-inner">
        <a href={SITE_URL} className="brand" aria-label="Allen home">
          <span className="brand-mark">[a]</span>
          <span className="brand-name">allen</span>
          <span className="brand-tag">open source</span>
        </a>
        <nav className="nav-links" aria-label="Primary">
          <a href={`${SITE_URL}/#demo`}>Demo</a>
          <a href={`${SITE_URL}/#how`}>How</a>
          <a href={`${SITE_URL}/#stack`}>Integrations</a>
          <a href={`${SITE_URL}/#start`}>Quickstart</a>
          <a className="is-active" href="/docs/" aria-current="page">Docs</a>
        </nav>
        <div className="nav-actions">
          <a className="btn primary sm" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            <GitHubIcon />
            <span className="github-label"><span className="github-label-full">Star on </span>GitHub</span>
          </a>
        </div>
      </div>
    </header>
  );
}
