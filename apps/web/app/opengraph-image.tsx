import { renderOg, OG_SIZE } from './og/ogCard';

export const alt = 'CoJam · ouçam juntos, entre serviços';
export const size = OG_SIZE;
export const contentType = 'image/png';

// The card itself lives in og/ogCard.tsx so the brand-axes preview route
// (og-preview) can render the same card per axis combination. This file is the
// shipped default: every axis at its default value.
export default function OpengraphImage() {
  return renderOg();
}
