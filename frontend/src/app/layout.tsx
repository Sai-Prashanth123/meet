import './globals.css'
import 'sonner/dist/styles.css'
import type { Metadata } from 'next'
import { Source_Sans_3 } from 'next/font/google'
import ClientLayout from './_components/ClientLayout'

const sourceSans3 = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-source-sans-3',
})

export const metadata: Metadata = {
  title: 'Meetily',
  description: 'Privacy-first AI meeting assistant',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`${sourceSans3.variable} font-sans antialiased`}>
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  )
}
