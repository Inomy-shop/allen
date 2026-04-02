/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        heading: ['Audiowide', 'sans-serif'],
        body: ['Chakra Petch', 'sans-serif'],
        mono: ['Space Mono', 'monospace'],
        label: ['Michroma', 'sans-serif'],
      },
      colors: {
        surface: {
          DEFAULT: '#0a0e1a',
          50: '#0d1224',
          100: '#111730',
          200: '#181e38',
          300: '#212845',
        },
        border: {
          DEFAULT: '#1e2740',
          light: '#2a3558',
        },
        accent: {
          blue: '#00d4ff',
          green: '#00ff88',
          red: '#ff3366',
          yellow: '#ffaa00',
          purple: '#a855f7',
          orange: '#f97316',
          cyan: '#00d4ff',
        },
      },
      boxShadow: {
        'glow-blue': '0 0 15px rgba(0, 212, 255, 0.3), 0 0 40px rgba(0, 212, 255, 0.1)',
        'glow-green': '0 0 15px rgba(0, 255, 136, 0.3), 0 0 40px rgba(0, 255, 136, 0.1)',
        'glow-red': '0 0 15px rgba(255, 51, 102, 0.3), 0 0 40px rgba(255, 51, 102, 0.1)',
        'glow-yellow': '0 0 15px rgba(255, 170, 0, 0.3), 0 0 40px rgba(255, 170, 0, 0.1)',
        'glow-purple': '0 0 15px rgba(168, 85, 247, 0.3), 0 0 40px rgba(168, 85, 247, 0.1)',
        'glow-cyan': '0 0 15px rgba(0, 212, 255, 0.3), 0 0 40px rgba(0, 212, 255, 0.1)',
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
