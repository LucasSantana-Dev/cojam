import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileReport } from './report';
import { resolveConnectionToken } from './realtime';

vi.mock('./realtime', () => ({ resolveConnectionToken: vi.fn() }));

const input = {
  roomId: 'NEON42',
  kind: 'message' as const,
  subjectId: 'c1',
  content: 'linha do chat',
  reason: 'xingou',
  category: 'harassment' as const,
};

describe('fileReport', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.mocked(resolveConnectionToken).mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  it('POSTs /api/report with the input plus the connection token', async () => {
    vi.mocked(resolveConnectionToken).mockResolvedValue('tok-123');
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));

    await expect(fileReport(input)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/report');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(sentBody()).toEqual({ ...input, connToken: 'tok-123' });
  });

  it('still files the report with an empty token when token resolution rejects', async () => {
    vi.mocked(resolveConnectionToken).mockRejectedValue(new Error('no session'));
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    await expect(fileReport(input)).resolves.toBe(true);

    expect(sentBody()).toEqual({ ...input, connToken: '' });
  });

  it('returns false on a non-2xx response', async () => {
    vi.mocked(resolveConnectionToken).mockResolvedValue('tok-123');
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(fileReport(input)).resolves.toBe(false);
  });

  it('returns false on a network error', async () => {
    vi.mocked(resolveConnectionToken).mockResolvedValue('tok-123');
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(fileReport(input)).resolves.toBe(false);
  });
});
