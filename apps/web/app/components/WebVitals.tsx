'use client';

import { useReportWebVitals } from 'next/web-vitals';
import { trackVital } from '@/lib/telemetry';

// Only the three Core Web Vitals the server allowlists. Reporting anything
// else would be rejected with 400 and counted as a misbehaving client.
const REPORTED = new Set(['LCP', 'INP', 'CLS']);

export function WebVitals() {
  useReportWebVitals((metric) => {
    if (REPORTED.has(metric.name)) trackVital(metric.name, metric.value);
  });
  return null;
}
