import type { Metadata } from 'next';
import { Instrument_Sans } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

// The theme sets --font-sans: var(--font-instrument-sans), so expose the font
// under that exact CSS variable on <html>.
const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Agent Swarm',
  description: 'Dashboard for managing a fleet of autonomous coding agents.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={instrumentSans.variable}>
      <body className="bg-background text-foreground font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
