/**
 * Reducing-balance EMI: P × r × (1+r)^n / ((1+r)^n − 1)
 * annualRoi is the reducing-balance annual percentage (e.g. 14.00 = 14 % p.a.)
 * Confirm ROI convention with credit team before go-live (§6.4).
 */
export function calculateEmi(principal, tenureMonths, annualRoi) {
  const r = annualRoi / 12 / 100;
  if (r === 0) return principal / tenureMonths;
  const pow = Math.pow(1 + r, tenureMonths);
  return (principal * r * pow) / (pow - 1);
}

export function inrFormat(amount) {
  return '₹' + Math.round(Number(amount)).toLocaleString('en-IN');
}

export function maskPan(pan) {
  if (!pan) return '—';
  // Show first 2 and last 1 character; mask the middle 7.
  return pan.slice(0, 2) + 'X'.repeat(pan.length - 3) + pan.slice(-1);
}

export function firstEmiDate() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
  });
}
