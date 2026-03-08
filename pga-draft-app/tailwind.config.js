/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          950: '#030912',
          900: '#060E1C',
          800: '#0A1628',
          700: '#0D1F38',
          600: '#122748',
        },
        royal: {
          700: '#004F8C',
          600: '#005FA8',
          500: '#006BB6',
          400: '#1A7EC0',
          300: '#3D95CC',
        },
        gold: {
          700: '#8C6A10',
          600: '#A07A14',
          500: '#C9A227',
          400: '#D4B040',
          300: '#E0C468',
          200: '#EDD98A',
        },
      },
      fontFamily: {
        bebas: ['Bebas Neue', 'sans-serif'],
        sans:  ['Inter', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'warriors-gradient': 'linear-gradient(160deg,#030912 0%,#0A1628 45%,#0D1F38 100%)',
        'royal-gradient':    'linear-gradient(135deg,#004F8C 0%,#006BB6 100%)',
        'gold-gradient':     'linear-gradient(135deg,#A07A14 0%,#C9A227 50%,#D4B040 100%)',
      },
      boxShadow: {
        'gold-glow': '0 0 40px rgba(201,162,39,0.25), 0 4px 24px rgba(0,0,0,0.5)',
        'royal-glow': '0 0 24px rgba(0,107,182,0.35), 0 2px 12px rgba(0,0,0,0.4)',
        'card': '0 4px 24px rgba(0,0,0,0.4)',
      },
    },
  },
  plugins: [],
};
