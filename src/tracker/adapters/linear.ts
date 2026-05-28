
import { TrackerAdapter, TrackerSyncInput, MutationRecord } from '../sync'; // Adjust path as needed

/**
 * Placeholder Linear Adapter for demonstration and testing purposes.
 * This adapter simulates interactions with Linear.
 */
export class LinearAdapter implements TrackerAdapter {
  /**
   * Simulates fetching data from Linear.
   * @param input - The sync input parameters.
   * @returns A promise resolving to mock data.
   */
  async fetchData(input: TrackerSyncInput): Promise<any[]> {
    console.log(`LinearAdapter: Simulating fetchData for trackerId: ${input.trackerId}`);
    // Return some mock data for demonstration
    return [
      { id: 'LIN-1', title: 'Mock Issue 1', description: 'This is a mock issue.' },
      { id: 'LIN-2', title: 'Mock Issue 2', description: 'Another mock issue.' },
    ];
  }

  /**
   * Simulates applying a mutation to Linear.
   * @param mutation - The mutation record to apply.
   * @returns A promise resolving to the updated mutation record.
   */
  async applyMutation(mutation: MutationRecord): Promise<MutationRecord> {
    console.log(`LinearAdapter: Simulating applyMutation for mutation ID: ${mutation.id}`);
    // Simulate success
    return { ...mutation, status: 'succeeded', remoteId: `remote-${mutation.entityId}` };
  }

  /**
   * Simulates conflict detection. Always returns false for now.
   * @returns Always returns false.
   */
  detectConflict(localEntity: any, remoteEntity: any): boolean {
    console.log('LinearAdapter: Simulating conflict detection (always false)');
    return false; // No conflicts for now
  }

  /**
   * Simulates remote fingerprint generation.
   * @param entity - The entity to generate a fingerprint for.
   * @returns A simple mock fingerprint string.
   */
  generateRemoteFingerprint(entity: any): string {
    console.log('LinearAdapter: Simulating remote fingerprint generation');
    return `mock-fingerprint-${entity.id || 'unknown'}`;
  }
}
