import './globals.css';

export const metadata = {
  title: 'Bubble Text Generator',
  description: 'Procedural inflate of any font into bubble text — 2D SVG or 3D balloon mesh.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
