import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Mocks — applied before every fresh module import ─────────────────────────

const mockSet = vi.fn();
const mockGet = vi.fn(() => [] as { path: string; target: string; auth: boolean }[]);

vi.mock('../../src/config/index.js', () => ({
  config: {
    configRepo: {
      url: 'https://raw.githubusercontent.com/test/config/main/routes.yaml',
      token: 'test-token',
      pollIntervalMs: 30000,
    },
  },
}));

vi.mock('../../src/utils/routeTable.js', () => ({
  routeTable: {
    set: mockSet,
    get: mockGet,
    match: vi.fn(),
  },
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const validYaml = `
routes:
  - path: /api/v1/auth
    target: http://katisha-user-service:3001
    auth: false
  - path: /api/v1/users
    target: http://katisha-user-service:3001
    auth: true
`;

const updatedYaml = `
routes:
  - path: /api/v1/auth
    target: http://katisha-user-service:3001
    auth: false
  - path: /api/v1/users
    target: http://katisha-user-service:3001
    auth: true
  - path: /api/v1/organizations
    target: http://katisha-user-service:3001
    auth: true
`;

function mockFetchOk(body: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => body,
  }));
}

function mockFetchStatus(status: number): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => '',
  }));
}

function mockFetchNetworkError(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
}

// ── Tests — each test gets a fresh configWatcher module (no lastHash carry-over)

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('configWatcher.init()', () => {
  it('first fetch succeeds → route table populated, init() resolves', async () => {
    mockFetchOk(validYaml);
    mockGet.mockReturnValue([{ path: '/api/v1/auth', target: 'http://x:3001', auth: false }]);

    const { configWatcher } = await import('../../src/loaders/configWatcher.js');
    await configWatcher.init();
    configWatcher.stop();

    expect(mockSet).toHaveBeenCalledOnce();
    const routes = mockSet.mock.calls[0][0] as unknown[];
    expect(routes).toHaveLength(2);
  });

  it('fetch returns same hash on second poll → routeTable.set not called again', async () => {
    mockFetchOk(validYaml);
    mockGet.mockReturnValue([{ path: '/api/v1/auth', target: 'http://x:3001', auth: false }]);

    const { configWatcher } = await import('../../src/loaders/configWatcher.js');
    await configWatcher.init();

    // Second poll — same content, same hash
    await configWatcher.init().catch(() => { /* ignore already-started error */ });
    configWatcher.stop();

    // set should still only have been called once for the initial load
    // (second init call would re-fetch but hash matches → no set)
    expect(mockSet).toHaveBeenCalledOnce();
  });

  it('fetch returns new hash → routeTable.set called with updated routes', async () => {
    // First call: validYaml
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => validYaml })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => updatedYaml });
    vi.stubGlobal('fetch', fetchMock);
    mockGet.mockReturnValue([{ path: '/api/v1/auth', target: 'http://x:3001', auth: false }]);

    const { configWatcher } = await import('../../src/loaders/configWatcher.js');
    await configWatcher.init();
    configWatcher.stop();

    // Simulate a second poll by calling init again (fresh module in a different test
    // would be cleaner, but here we just verify set is called twice if hash changes)
    // Re-init triggers another fetchAndApply; since module state has lastHash from first fetch,
    // second fetch with different content will call set again.
    // Re-stub fetch to only return updatedYaml
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => updatedYaml }));
    mockGet.mockReturnValue([{ path: '/api/v1/auth', target: 'http://x:3001', auth: false }, { path: '/api/v1/users', target: 'http://x:3001', auth: true }, { path: '/api/v1/organizations', target: 'http://x:3001', auth: true }]);

    // Manually trigger a poll by calling init (it creates a new interval, but init also calls fetchAndApply)
    // Note: since lastHash is set from first fetch, second call with updatedYaml triggers set
    await configWatcher.init().catch(() => { /* swallow — routes already loaded */ });
    configWatcher.stop();

    expect(mockSet).toHaveBeenCalledTimes(2);
    const secondCall = mockSet.mock.calls[1][0] as unknown[];
    expect(secondCall).toHaveLength(3);
  });

  it('fetch returns non-200 → error logged, previous routes kept (init resolves if routes exist)', async () => {
    // First: successful load so routes are set
    mockFetchOk(validYaml);
    mockGet.mockReturnValue([{ path: '/api/v1/auth', target: 'http://x:3001', auth: false }]);

    const { configWatcher } = await import('../../src/loaders/configWatcher.js');
    await configWatcher.init();
    configWatcher.stop();

    const setCallsBefore = mockSet.mock.calls.length;

    // Now simulate a non-200 on the next poll
    mockFetchStatus(503);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Trigger another init (which calls fetchAndApply) — should not throw
    await configWatcher.init().catch(() => { /* ignore */ });
    configWatcher.stop();

    expect(consoleSpy).toHaveBeenCalled();
    expect(mockSet.mock.calls.length).toBe(setCallsBefore); // no new set call
    consoleSpy.mockRestore();
  });

  it('fetch throws network error → error logged, previous routes kept', async () => {
    mockFetchOk(validYaml);
    mockGet.mockReturnValue([{ path: '/api/v1/auth', target: 'http://x:3001', auth: false }]);

    const { configWatcher } = await import('../../src/loaders/configWatcher.js');
    await configWatcher.init();
    configWatcher.stop();

    const setCallsBefore = mockSet.mock.calls.length;

    mockFetchNetworkError();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await configWatcher.init().catch(() => { /* ignore */ });
    configWatcher.stop();

    expect(consoleSpy).toHaveBeenCalled();
    expect(mockSet.mock.calls.length).toBe(setCallsBefore);
    consoleSpy.mockRestore();
  });

  it('initial fetch fails → init() throws (server should not start)', async () => {
    mockFetchNetworkError();
    mockGet.mockReturnValue([]); // no routes loaded

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { configWatcher } = await import('../../src/loaders/configWatcher.js');

    await expect(configWatcher.init()).rejects.toThrow();
    configWatcher.stop();
    consoleSpy.mockRestore();
  });
});
