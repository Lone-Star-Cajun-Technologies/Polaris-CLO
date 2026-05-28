
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';

import { loadMutationQueue, saveMutationQueue } from './queue-store';
import { MutationRecord } from './index';

describe('queue-store', () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'queue-store-test-'));
    testFilePath = join(testDir, '.polaris', 'runs', 'mutation-queue.json');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should load an empty array if the queue file does not exist', async () => {
    const queue = await loadMutationQueue(testFilePath);
    expect(queue).toEqual([]);
  });

  it('should save and load a queue with multiple records', async () => {
    const mockQueue: MutationRecord[] = [
      {
        id: 'mut-1',
        operationId: 'op-1',
        type: 'create',
        entityType: 'issue',
        entityId: 'local-1',
        payload: { title: 'Test Issue 1' },
        status: 'pending',
        timestamp: new Date().toISOString(),
        retries: 0,
      },
      {
        id: 'mut-2',
        operationId: 'op-2',
        type: 'update',
        entityType: 'issue',
        entityId: 'local-2',
        payload: { description: 'Updated description' },
        status: 'failed',
        timestamp: new Date().toISOString(),
        retries: 1,
        error: 'Network error',
      },
    ];

    await saveMutationQueue(mockQueue, testFilePath);
    const loadedQueue = await loadMutationQueue(testFilePath);

    expect(loadedQueue).toEqual(mockQueue);
    // Verify file content directly
    const fileContent = await readFile(testFilePath, 'utf-8');
    expect(JSON.parse(fileContent)).toEqual(mockQueue);
  });

  it('should handle saving an empty queue', async () => {
    await saveMutationQueue([], testFilePath);
    const loadedQueue = await loadMutationQueue(testFilePath);
    expect(loadedQueue).toEqual([]);
  });

  it('should overwrite existing queue data', async () => {
    const initialQueue: MutationRecord[] = [
      {
        id: 'mut-initial',
        operationId: 'op-initial',
        type: 'create',
        entityType: 'project',
        entityId: 'proj-1',
        payload: { name: 'Initial Project' },
        status: 'succeeded',
        timestamp: new Date().toISOString(),
        retries: 0,
      },
    ];
    await saveMutationQueue(initialQueue, testFilePath);

    const newQueue: MutationRecord[] = [
      {
        id: 'mut-new',
        operationId: 'op-new',
        type: 'update',
        entityType: 'project',
        entityId: 'proj-1',
        payload: { name: 'Updated Project' },
        status: 'pending',
        timestamp: new Date().toISOString(),
        retries: 0,
      },
    ];
    await saveMutationQueue(newQueue, testFilePath);

    const loadedQueue = await loadMutationQueue(testFilePath);
    expect(loadedQueue).toEqual(newQueue);
  });

  it('should return an empty array if the file exists but is empty', async () => {
    await saveMutationQueue([], testFilePath); // create an empty file
    const queue = await loadMutationQueue(testFilePath);
    expect(queue).toEqual([]);
  });

  it('should throw an error for malformed JSON content', async () => {
    // Manually create a malformed JSON file
    await mkdtemp(join(testDir, '.polaris', 'runs'), { recursive: true });
    await writeFile(testFilePath, '{"id": "malformed",', 'utf-8');

    await expect(loadMutationQueue(testFilePath)).rejects.toThrow(SyntaxError);
  });
});
