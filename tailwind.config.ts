import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Command-center dark palette. Adjust once real brand tokens exist.
        background: '#0B0D12',
        surface: '#12151C',
        border: '#1F232D',
        primary: '#5B8CFF',
        'primary-foreground': '#0B0D12',
        muted: '#7A8296',
      },
    },
  },
  plugins: [],
};

export default config;
