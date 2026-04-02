/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#0f1117',
          50: '#141620',
          100: '#1a1d2b',
          200: '#222536',
          300: '#2a2e42',
        },
        border: {
          DEFAULT: '#2a2e42',
          light: '#363b52',
        },
        accent: {
          blue: '#3b82f6',
          green: '#22c55e',
          red: '#ef4444',
          yellow: '#eab308',
          purple: '#a855f7',
          orange: '#f97316',
          cyan: '#06b6d4',
        },
      },
    },
  },
  plugins: [],
};
