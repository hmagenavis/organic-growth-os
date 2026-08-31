import { publicEnv } from '@organic-os/config/client';
import type { Metadata } from 'next';
import type { ReactElement, ReactNode } from 'react';

import './globals.css';

const { NEXT_PUBLIC_APP_NAME: appName } = publicEnv();

export const metadata: Metadata = {
  title: appName,
  description: 'Organic Growth OS — autonomous SEO, AEO and GEO platform.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
