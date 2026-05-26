import type { Metadata } from 'next';
import { Hanken_Grotesk, Newsreader } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

// Open-source stand-ins for Anthropic's brand pair (which are licensed/
// proprietary): Hanken Grotesk ≈ Styrene (UI sans), Newsreader ≈ Galaxie
// Copernicus (editorial serif, used for chat/prose).
const sans = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--font-sans-brand',
  display: 'swap',
});
const serif = Newsreader({
  subsets: ['latin'],
  variable: '--font-serif-brand',
  display: 'swap',
  style: ['normal', 'italic'],
});

export const metadata: Metadata = {
  title: 'Agent Swarm',
  description: 'Dashboard for managing a fleet of autonomous coding agents.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${serif.variable}`}>
      <body className="bg-background text-foreground font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
