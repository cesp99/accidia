import type { Metadata } from 'next'
import { Inter, Space_Mono } from 'next/font/google'
import './globals.css'

const _inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const _spaceMono = Space_Mono({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-space-mono" });

export const metadata: Metadata = {
  title: 'Infinite Jukebox',
  description: 'Songs that play forever. Analyze any audio to find beat patterns and create infinite loops.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${_inter.variable} ${_spaceMono.variable} dark`}>
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
