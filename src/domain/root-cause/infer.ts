import { invariant } from '../errors.ts';
import type { CausalEdge, CausalObservation, RootCauseResult } from '../types.ts';

function findPaths(start: string, edges: CausalEdge[], seen: string[] = []): { path: string[]; score: number }[] {
  if (seen.includes(start)) return [];
  const nextSeen = [...seen, start];
  const outgoing = edges.filter((edge) => edge.from === start);
  if (!outgoing.length) return [{ path: nextSeen, score: 1 }];
  return outgoing.flatMap((edge) => findPaths(edge.to, edges, nextSeen).map((item) => ({ path: item.path, score: item.score * edge.weight })));
}

export function inferRootCauses(observations: CausalObservation[], edges: CausalEdge[]): RootCauseResult {
  for (const observation of observations) invariant(observation.score >= 0 && observation.score <= 1, 'INVALID_OBSERVATION_SCORE', 'Observation score must be in [0, 1]', { id: observation.id });
  for (const edge of edges) invariant(edge.weight > 0 && edge.weight <= 1 && edge.delayMs >= 0, 'INVALID_CAUSAL_EDGE', 'Causal edge has invalid weight or delay', { edge });
  const rejectedCycles: string[][] = [];
  const scores = new Map<string, { score: number; paths: string[][] }>();
  for (const observation of observations) {
    const paths = findPaths(observation.node, edges);
    for (const path of paths) {
      if (new Set(path.path).size !== path.path.length) { rejectedCycles.push(path.path); continue; }
      const root = path.path[0];
      const current = scores.get(root) ?? { score: 0, paths: [] };
      current.score += observation.score * path.score;
      current.paths.push(path.path);
      scores.set(root, current);
    }
  }
  return { ranking: [...scores.entries()].map(([node, value]) => ({ node, score: value.score, paths: value.paths })).sort((a, b) => b.score - a.score || a.node.localeCompare(b.node)), observations, rejectedCycles };
}
