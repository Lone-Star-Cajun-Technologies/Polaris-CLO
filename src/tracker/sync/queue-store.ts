
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { MutationRecord } from './index';

/**
 * Ensures the necessary directories exist for storing the mutation queue.
 * @param baseDir The base directory where .polaris/runs will be created. Defaults to process.cwd().
 */
async function ensureQueueDirs(baseDir: string = process.cwd()): Promise<void> {
  const polarisDir = path.join(baseDir, '.polaris');
  const runsDir = path.join(polarisDir, 'runs');
  await mkdir(polarisDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });
}

/**
 * Loads the mutation queue from a JSON file.
 * If the file does not exist, an empty array is returned.
 * @param filePath The path to the mutation queue JSON file. Defaults to .polaris/runs/mutation-queue.json.
 * @returns A promise that resolves to an array of MutationRecord.
 */
export async function loadMutationQueue(filePath: string = path.join(process.cwd(), '.polaris', 'runs', 'mutation-queue.json')): Promise<MutationRecord[]> {
  try {
    await ensureQueueDirs(path.dirname(path.dirname(filePath))); // Ensure based on the file path provided
    const fileContent = await readFile(filePath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // console.log('Mutation queue file not found, starting with empty queue.'); // Commented for cleaner test output
      return []; // Return empty array if file does not exist
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
    await ensureQueueDirs(path.dirname(path.dirname(filePath))); // Ensure based on the file path provided
    await writeFile(filePath, JSON.stringify(queue, null, 2), 'utf-8');
    // console.log(`Mutation queue saved to ${filePath}`); // Commented for cleaner test output
  } catch (error) {
    console.error('Error saving mutation queue:', error);
    throw error;
  }
}
