export const metadata = {
  title: 'WhatsApp LOS Admin',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif', background: '#f1f5f9' }}>
        {children}
      </body>
    </html>
  );
}
