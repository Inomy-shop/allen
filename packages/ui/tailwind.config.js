/** @type {import('tailwindcss').Config} */
// =====================================================================
// ALLEN UI · V8 reusable foundation
// ---------------------------------------------------------------------
// - darkMode: 'class' is preserved so the .dark theme works.
// - Legacy v1 glow box-shadows kept as no-ops so existing JSX with
//   className="shadow-glow-blue" doesn't break the build.
// - accent-blue / accent-cyan aliased to the prototype blue so existing JSX
//   keeps compiling (525+ usages).
// =====================================================================
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        heading: ['var(--font-heading)'],
        body:    ['var(--font-body)'],
        mono:    ['var(--font-mono)'],
        label:   ['var(--font-label)'],
      },
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
          50:  'rgb(var(--color-surface) / 0.5)',
          100: 'rgb(var(--color-surface-100) / <alpha-value>)',
          200: 'rgb(var(--color-surface-200) / <alpha-value>)',
          300: 'rgb(var(--color-surface-300) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--color-border) / <alpha-value>)',
          strong:  'rgb(var(--color-border-strong) / <alpha-value>)',
          light:   'rgb(var(--color-border) / 0.6)',
        },
        accent: {
          // v1 names kept so existing className strings still resolve.
          // Every alias now points at the prototype blue.
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          blue:    'rgb(var(--color-accent) / <alpha-value>)',   // legacy alias
          cyan:    'rgb(var(--color-accent) / <alpha-value>)',   // legacy alias
          violet:  'rgb(var(--color-accent) / <alpha-value>)',
          soft:    'rgb(var(--color-accent-soft) / <alpha-value>)',
          hover:   'rgb(var(--color-accent-hover) / <alpha-value>)',
          green:   'rgb(var(--color-accent-green) / <alpha-value>)',
          red:     'rgb(var(--color-accent-red) / <alpha-value>)',
          yellow:  'rgb(var(--color-accent-yellow) / <alpha-value>)',
          purple:  'rgb(var(--color-accent-purple) / <alpha-value>)',
          orange:  'rgb(var(--color-accent-orange) / <alpha-value>)',
        },
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--radius-sm)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        sm:       'var(--shadow-sm)',
        popover:  'var(--shadow-popover)',
        // Legacy v1 glow names kept as no-ops so any straggling JSX
        // className="shadow-glow-blue" doesn't break the build.
        'glow-blue':   'none',
        'glow-green':  'none',
        'glow-red':    'none',
        'glow-yellow': 'none',
        'glow-purple': 'none',
        'glow-cyan':   'none',
      },
      fontSize: {
        'micro':  ['9.5px', { lineHeight: '1.4' }],
        'meta':   ['10.5px', { lineHeight: '1.45', letterSpacing: '0' }],
        '2xs':    ['11.5px', { lineHeight: '1.5' }],
        'caption':['12.5px', { lineHeight: '1.5' }],
        'body':   ['14px', { lineHeight: '1.55' }],
        'title':  ['15px', { lineHeight: '1.35', letterSpacing: '0' }],
        'h2':     ['17px', { lineHeight: '1.3', letterSpacing: '0' }],
        'h1':     ['19px', { lineHeight: '1.25', letterSpacing: '0' }],
        'display':['24px', { lineHeight: '1.2', letterSpacing: '-0.015em' }],
      },
      animation: {
        'pulse-running': 'pulse-running 2s ease-in-out infinite',
        'msg-enter':     'al-msg-enter 0.3s ease-out',
        'agent-pulse':   'al-agent-pulse 1.6s ease-in-out infinite',
        'onboarding-fade-in': 'onboarding-fade-in 180ms ease-out both',
        'onboarding-fade-out': 'onboarding-fade-out 180ms ease-in both',
        'onboarding-modal-enter': 'onboarding-modal-enter 260ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'onboarding-modal-exit': 'onboarding-modal-exit 180ms cubic-bezier(0.4, 0, 1, 1) both',
        // Legacy aliases (no-op visual but keep className compiling)
        'pulse-glow':    'pulse-glow 2s ease-in-out infinite',
        'scan-line':     'scan-line 4s linear infinite',
      },
      keyframes: {
        'pulse-running': {
          '0%,100%': { boxShadow: '0 0 0 0 rgb(var(--color-accent-cyan) / 0.45)' },
          '50%':     { boxShadow: '0 0 0 5px rgb(var(--color-accent-cyan) / 0)' },
        },
        'al-msg-enter': {
          from: { opacity: '0', transform: 'translateY(0.5rem)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'al-agent-pulse': {
          '0%,100%': { opacity: '0.55' },
          '50%':     { opacity: '1' },
        },
        'onboarding-fade-in': {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        'onboarding-fade-out': {
          from: { opacity: '1' },
          to:   { opacity: '0' },
        },
        'onboarding-modal-enter': {
          from: { opacity: '0', transform: 'translateY(12px) scale(0.98)' },
          to:   { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'onboarding-modal-exit': {
          from: { opacity: '1', transform: 'translateY(0) scale(1)' },
          to:   { opacity: '0', transform: 'translateY(10px) scale(0.985)' },
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.6' },
        },
        'scan-line': {
          '0%':   { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
      },
    },
  },
  plugins: [],
};
