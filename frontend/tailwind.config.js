/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/pages/Track.jsx',
    './src/components/ui/**/*.{js,jsx}',
    './src/lib/**/*.{js,jsx}',
  ],
  corePlugins: {
    preflight: false, // Don't reset existing CSS — other pages depend on it
  },
  theme: {
    extend: {
      colors: {
        'primary-bg':    '#0f1117',
        'secondary-bg':  '#1a1d24',
        'card-bg':       '#22262f',
        'border-col':    '#2d3139',
        'primary-text':  '#ffffff',
        'secondary-text':'#a1a7b4',
        'muted-text':    '#6b7280',
        'accent':        '#22c55e',
        'accent-hover':  '#16a34a',
        'danger':        '#ef4444',
        'danger-hover':  '#dc2626',
        'warning':       '#f59e0b',
        'score-bg':      '#1e1e1e',
        'score-border':  '#333333',
        'score-cur':     '#3498db',
        'point-from':    '#34495e',
        'point-to':      '#2c3e50',
      },
    },
  },
  plugins: [],
}
