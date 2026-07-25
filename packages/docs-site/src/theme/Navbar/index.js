import React from 'react';
import Link from '@docusaurus/Link';
import NavbarLayout from '@theme/Navbar/Layout';
import NavbarColorModeToggle from '@theme/Navbar/ColorModeToggle';
import NavbarMobileSidebarToggle from '@theme/Navbar/MobileSidebar/Toggle';

const SITE_URL = 'https://askallen.build';
const GITHUB_URL = 'https://github.com/Inomy-shop/allen';

function AllenMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" fill="currentColor" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.5 5.5 0 0 0 19.3 3.7 5.1 5.1 0 0 0 19.2 0S18 .4 15 2a13.4 13.4 0 0 0-7 0C5 .4 3.8 0 3.8 0a5.1 5.1 0 0 0-.1 3.7 5.5 5.5 0 0 0-1.5 3.8c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 8 18v4" />
      <path d="M8 19c-3 .9-3-1.5-4.2-2" />
    </svg>
  );
}

export default function Navbar() {
  return (
    <NavbarLayout>
      <div className="nav-shell">
        <div className="container nav-inner">
          <div className="nav-brand-group">
            <NavbarMobileSidebarToggle />
            <a href={SITE_URL} className="brand" aria-label="Allen home">
              <span className="brand-mark">
                <AllenMark />
              </span>
              <span className="brand-copy">
                <span className="brand-name">allen</span>
                <span className="brand-context">docs</span>
              </span>
            </a>
          </div>

          <nav className="nav-links" aria-label="Primary">
            <a href={`${SITE_URL}/#demo`}>Demo</a>
            <a href={`${SITE_URL}/#how`}>How it works</a>
            <a href={`${SITE_URL}/#stack`}>Integrations</a>
            <a href={`${SITE_URL}/#start`}>Quickstart</a>
            <Link className="is-active" to="/" aria-current="page">Docs</Link>
          </nav>

          <div className="nav-actions">
            <NavbarColorModeToggle className="docs-theme-toggle" />
            <a className="btn primary sm" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              <GitHubIcon />
              <span className="github-label">Star on GitHub</span>
            </a>
          </div>
        </div>
      </div>
    </NavbarLayout>
  );
}
