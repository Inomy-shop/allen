/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        heading: ['var(--font-heading)'],
        body: ['var(--font-body)'],
        mono: ['var(--font-mono)'],
        label: ['var(--font-label)'],
      },
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
          50: 'rgb(var(--color-surface) / 0.9)',
          100: 'rgb(var(--color-surface-100) / <alpha-value>)',
          200: 'rgb(var(--color-surface-200) / <alpha-value>)',
          300: 'rgb(var(--color-surface-200) / 0.8)',
        },
        border: {
          DEFAULT: 'rgb(var(--color-border) / <alpha-value>)',
          light: 'rgb(var(--color-border) / 0.7)',
        },
        accent: {
          blue: 'rgb(var(--color-accent) / <alpha-value>)',
          green: 'rgb(var(--color-accent-green) / <alpha-value>)',
          red: 'rgb(var(--color-accent-red) / <alpha-value>)',
          yellow: 'rgb(var(--color-accent-yellow) / <alpha-value>)',
          purple: 'rgb(var(--color-accent-purple) / <alpha-value>)',
          orange: '#f97316',
          cyan: 'rgb(var(--color-accent) / <alpha-value>)',
        },
      },
      boxShadow: {
        'glow-blue': '0 0 15px rgb(var(--color-accent) / 0.3), 0 0 40px rgb(var(--color-accent) / 0.1)',
        'glow-green': '0 0 15px rgb(var(--color-accent-green) / 0.3), 0 0 40px rgb(var(--color-accent-green) / 0.1)',
        'glow-red': '0 0 15px rgb(var(--color-accent-red) / 0.3), 0 0 40px rgb(var(--color-accent-red) / 0.1)',
        'glow-yellow': '0 0 15px rgb(var(--color-accent-yellow) / 0.3), 0 0 40px rgb(var(--color-accent-yellow) / 0.1)',
        'glow-purple': '0 0 15px rgb(var(--color-accent-purple) / 0.3), 0 0 40px rgb(var(--color-accent-purple) / 0.1)',
        'glow-cyan': '0 0 15px rgb(var(--color-accent) / 0.3), 0 0 40px rgb(var(--color-accent) / 0.1)',
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'scan-line': 'scan-line 4s linear infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        'scan-line': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
      },
    },
  },
  plugins: [],
};
