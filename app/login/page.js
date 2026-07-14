'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '../../lib/supabase/browser';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      setError(authError.message);
      setLoading(false);
    } else {
      router.push('/dashboard');
      router.refresh();
    }
  }

  return (
    <main style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
      <div style={{
        background: 'white',
        padding: '2.5rem',
        borderRadius: '10px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
        width: '100%',
        maxWidth: '380px',
      }}>
        <h1 style={{ marginTop: 0, marginBottom: '0.25rem', fontSize: '1.3rem', fontWeight: 700 }}>Admin Login</h1>
        <p style={{ marginTop: 0, marginBottom: '1.75rem', fontSize: '0.875rem', color: '#64748b' }}>
          WhatsApp LOS dashboard
        </p>
        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', marginBottom: '1rem' }}>
            <span style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '5px', color: '#374151' }}>
              Email
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              style={{
                width: '100%', padding: '9px 11px', border: '1px solid #d1d5db',
                borderRadius: '6px', fontSize: '0.95rem', boxSizing: 'border-box',
                outline: 'none',
              }}
            />
          </label>
          <label style={{ display: 'block', marginBottom: '1.5rem' }}>
            <span style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '5px', color: '#374151' }}>
              Password
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              style={{
                width: '100%', padding: '9px 11px', border: '1px solid #d1d5db',
                borderRadius: '6px', fontSize: '0.95rem', boxSizing: 'border-box',
                outline: 'none',
              }}
            />
          </label>
          {error && (
            <p style={{ margin: '0 0 1rem', fontSize: '0.875rem', color: '#dc2626', background: '#fef2f2', padding: '8px 12px', borderRadius: '6px' }}>
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '10px', background: '#2563eb', color: 'white',
              border: 'none', borderRadius: '6px', fontSize: '0.95rem', fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
