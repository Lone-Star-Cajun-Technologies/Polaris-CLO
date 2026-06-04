import { LocalGraph } from "../../local-graph.js";

export class LocalAdapter {
  async syncIn(clusterId: string, repoRoot: string = process.cwd()): Promise<LocalGraph> {
    return LocalGraph.load(clusterId, repoRoot);
  }
}
