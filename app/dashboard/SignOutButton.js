'use client';
import { useRouter } from 'next/navigation';
import { createClient } from '../../lib/supabase/browser';

export default function SignOutButton() {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <button
      onClick={handleSignOut}
      style={{
        padding: '6px 14px', background: 'white', border: '1px solid #d1d5db',
        borderRadius: '6px', cursor: 'pointer', fontSize: '0.875rem', color: '#374151',
        fontWeight: 500,
      }}
    >
      Sign out
    </button>
  );
}
