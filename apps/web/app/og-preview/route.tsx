// Brand axes preview (#325): the share card for any axis combination, e.g.
// /og-preview?fx=flat&ground=black&presence=key&wordmark=lockup-a.
// The shipped /opengraph-image is this card at the defaults.
import { parseAxes } from '@/lib/brandAxesConfig';
import { renderOg } from '../og/ogCard';

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return renderOg(parseAxes(new URL(request.url).searchParams));
}
