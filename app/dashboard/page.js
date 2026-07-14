import { redirect } from 'next/navigation';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '../../lib/supabase/server';
import SignOutButton from './SignOutButton';

const STAGE_LABELS = {
  interest:  'Interest check',
  pan:       'PAN entry',
  approval:  'Offer shown',
  aadhaar:   'Aadhaar entry',
  otp:       'OTP verification',
  offers:    'Selecting offer',
  confirm:   'Confirming offer',
  esign:     'eSign',
  bank:      'Bank details',
  mandate:   'e-Mandate',
  done:      'Complete',
  cancelled: 'Cancelled',
};

const STATUS_STYLES = {
  in_progress: { bg: '#fef9c3', color: '#854d0e' },
  completed:   { bg: '#dcfce7', color: '#15803d' },
  cancelled:   { bg: '#f1f5f9', color: '#475569' },
  no_offer:    { bg: '#fee2e2', color: '#991b1b' },
  declined:    { bg: '#fef3c7', color: '#92400e' },
};

function StageBadge({ stage }) {
  const label = STAGE_LABELS[stage] ?? stage;
  const isDone = stage === 'done';
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: '999px',
      fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.02em',
      background: isDone ? '#dcfce7' : '#fef9c3',
      color: isDone ? '#15803d' : '#854d0e',
    }}>
      {label}
    </span>
  );
}

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] ?? { bg: '#f1f5f9', color: '#475569' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: '999px',
      fontSize: '0.72rem', fontWeight: 700,
      background: style.bg, color: style.color,
    }}>
      {status ?? '—'}
    </span>
  );
}

/** Mask PAN: show first 2 + last 1 chars, rest as X. e.g. ABCDE1234F → ABXXX1234F */
function maskPan(pan) {
  if (!pan) return <span style={{ color: '#94a3b8' }}>—</span>;
  return pan.slice(0, 2) + 'X'.repeat(pan.length - 3) + pan.slice(-1);
}

function dash(value) {
  return value || <span style={{ color: '#94a3b8' }}>—</span>;
}

export default async function DashboardPage() {
  // Verify auth session via anon client (cookie set by middleware).
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect('/login');

  // Fetch applications with service-role key — bypasses RLS.
  const db = createServiceClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: applications, error } = await db
    .from('loan_applications')
    .select('id, mobile_number, stage, pan_number, status, updated_at')
    .order('updated_at', { ascending: false });

  return (
    <main style={{ padding: '2rem', maxWidth: '1100px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 700 }}>Loan Applications</h1>
          <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: '#64748b' }}>
            {applications?.length ?? 0} total · sorted by last updated
          </p>
        </div>
        <SignOutButton />
      </div>

      {error && (
        <p style={{ color: '#dc2626', background: '#fef2f2', padding: '10px 14px', borderRadius: '6px', fontSize: '0.875rem' }}>
          Error loading applications: {error.message}
        </p>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse', background: 'white',
          borderRadius: '10px', overflow: 'hidden', boxShadow: '0 1px 6px rgba(0,0,0,0.08)',
          fontSize: '0.875rem',
        }}>
          <thead>
            <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
              {['Phone', 'Stage', 'PAN', 'Status', 'Last Updated (IST)'].map(h => (
                <th key={h} style={{
                  padding: '10px 16px', textAlign: 'left', fontWeight: 600,
                  fontSize: '0.72rem', color: '#64748b',
                  textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!applications?.length && (
              <tr>
                <td colSpan={5} style={{ padding: '2.5rem', textAlign: 'center', color: '#94a3b8' }}>
                  No applications yet.
                </td>
              </tr>
            )}
            {applications?.map((app, i) => (
              <tr key={app.id} style={{ borderTop: i > 0 ? '1px solid #f1f5f9' : undefined }}>
                <td style={{ padding: '11px 16px', fontFamily: 'monospace', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
                  {app.mobile_number}
                </td>
                <td style={{ padding: '11px 16px' }}>
                  <StageBadge stage={app.stage} />
                </td>
                <td style={{ padding: '11px 16px', fontFamily: 'monospace', fontSize: '0.85rem', letterSpacing: '0.05em' }}>
                  {maskPan(app.pan_number)}
                </td>
                <td style={{ padding: '11px 16px' }}>
                  <StatusBadge status={app.status} />
                </td>
                <td style={{ padding: '11px 16px', color: '#475569', whiteSpace: 'nowrap' }}>
                  {new Date(app.updated_at).toLocaleString('en-IN', {
                    timeZone: 'Asia/Kolkata',
                    day: '2-digit', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
