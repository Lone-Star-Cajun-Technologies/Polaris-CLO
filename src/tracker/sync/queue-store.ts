
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { MutationRecord } from './index.js';

/**
 * Loads the mutation queue from a JSON file.
 * If the file does not exist, an empty array is returned.
 * @param filePath The path to the mutation queue JSON file. Defaults to .polaris/runs/mutation-queue.json.
 * @returns A promise that resolves to an array of MutationRecord.
 */
export async function loadMutationQueue(filePath: string = path.join(process.cwd(), '.polaris', 'runs', 'mutation-queue.json')): Promise<MutationRecord[]> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    const fileContent = await readFile(filePath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return [];
    }
    console.error('Error loading mutation queue:', error);
    throw error;
  }
}

/**
 * Saves the mutation queue to a JSON file.
 * @param queue The array of MutationRecord to save.
 * @param filePath The path to the mutation queue JSON file. Defaults to .polaris/runs/mutation-queue.json.
 * @returns A promise that resolves when the queue has been saved.
 */
export async function saveMutationQueue(queue: MutationRecord[], filePath: string = path.join(process.cwd(), '.polaris', 'runs', 'mutation-queue.json')): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(queue, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving mutation queue:', error);
    throw error;
  }
}
