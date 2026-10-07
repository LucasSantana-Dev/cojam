import { describe, expect, it } from 'vitest';
import { jsonLdScript } from './jsonLd';

describe('jsonLdScript', () => {
  it('escapes < so the payload cannot close the script element', () => {
    const out = jsonLdScript({ url: 'https://x.test/</script><b>' });
    expect(out).not.toContain('<');
    expect(out).toContain('\\u003c/script>');
  });

  it('round-trips to the original value', () => {
    const data = { a: '</script>', b: 'x\u2028y\u2029z', c: [1, 'é'] };
    expect(JSON.parse(jsonLdScript(data))).toEqual(data);
  });
});
