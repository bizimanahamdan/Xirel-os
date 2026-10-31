import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Xirel — AI Operating System',
  description: 'What do you want your AI team to do?',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-white antialiased">{children}</body>
    </html>
  );
}
