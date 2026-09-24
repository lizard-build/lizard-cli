import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerVolume } from '../../src/commands/volume.js';
import { api } from '../../src/lib/api.js';

vi.mock('../../src/lib/api.js', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  withScope: (path: string, scope: { workspaceId: string }) => `${path}?workspaceId=${scope.workspaceId}`,
}));
vi.mock('../../src/lib/resolve.js', () => ({ resolveProjectScope: async () => ({ projectId: 'p1', scope: { workspaceId: 'w1' } }) }));
vi.mock('../../src/lib/format.js', () => ({ isJSONMode: () => true, printJSON: vi.fn(), table: vi.fn(), isTTY: () => false, success: vi.fn(), info: vi.fn() }));

async function create(size?: string) {
  const program = new Command();
  registerVolume(program);
  await program.parseAsync(['volume', 'create', 'cache', ...(size === undefined ? [] : ['--size', size])], { from: 'user' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockResolvedValue({ minSizeGb: 1, maxSizeGb: 50, defaultSizeGb: 5 });
  vi.mocked(api.post).mockResolvedValue({ name: 'cache', sizeGb: 5 });
});

describe('volume create size', () => {
  it.each(['1.5', '5oops', '0', '-1', 'Infinity'])('rejects %s before any request', async (size) => {
    await expect(create(size)).rejects.toThrow(/whole number/);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
  it('rejects a size above server policy before creating anything', async () => {
    await expect(create('51')).rejects.toThrow(/1 and 50/);
    expect(api.post).not.toHaveBeenCalled();
  });
  it('uses server defaults and workspace scope', async () => {
    await create();
    expect(api.get).toHaveBeenCalledWith('/api/projects/p1/volume-limits?workspaceId=w1');
    expect(api.post).toHaveBeenCalledWith('/api/projects/p1/volumes?workspaceId=w1', { name: 'cache', sizeGb: 5, region: undefined });
  });
  it('accepts the boundary and follows a changed limit', async () => {
    await create('50');
    vi.mocked(api.get).mockResolvedValue({ minSizeGb: 1, maxSizeGb: 20, defaultSizeGb: 5 });
    await expect(create('21')).rejects.toThrow(/1 and 20/);
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});
