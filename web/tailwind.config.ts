import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Palantir-style dark palette: near-black bg, blue accents, alert red/amber.
        bg: {
          base: '#0a0c10',
          panel: '#11151c',
          raised: '#161b24',
          border: '#1f2632',
        },
        ink: {
          primary: '#e6edf3',
          muted: '#8b95a5',
          dim: '#5a6473',
        },
        accent: {
          blue: '#4a9eff',
          cyan: '#52d1ff',
          green: '#3fb950',
          amber: '#f0883e',
          red: '#f85149',
        },
      },
      // System stacks only — the ground laptop has no internet over Herelink, so a
      // webfont CDN would just stall and fall back to these anyway.
      fontFamily: {
        sans: [
          'system-ui', '-apple-system', 'Segoe UI', 'Roboto',
          'Helvetica Neue', 'sans-serif',
        ],
        mono: [
          'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas',
          'DejaVu Sans Mono', 'monospace',
        ],
      },
    },
  },
  plugins: [],
};

export default config;
