// Tailwind CSS v4 is wired in as a PostCSS plugin (no tailwind.config needed —
// theme lives in globals.css via @import "tailwindcss" + @heroui/styles).
const config = {
  plugins: ['@tailwindcss/postcss'],
};

export default config;
