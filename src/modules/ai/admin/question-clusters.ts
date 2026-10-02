import { normalize, tokens } from '../../search/captain/captain-text';

export interface ClusterItem {
  id: string;
  text: string;
  createdAt: Date;
}

export interface Cluster<T extends ClusterItem> {
  /** The most recent member, shown as the cluster's title. */
  sample: T;
  items: T[];
}

/**
 * Two questions are about the same thing when most of their words agree, or at
 * least two key words agree and they are not otherwise far apart — Egyptian
 * Arabic inflects the verb ("شغال" / "بيشتغل") but keeps the nouns ("المايك", "اللوبي").
 */
function similar(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  const jaccard = shared / (a.size + b.size - shared);
  return jaccard >= 0.5 || (shared >= 2 && jaccard >= 0.3);
}

/**
 * Groups near-identical questions ("المايك مش شغال" / "المايك مبيشتغلش ليه")
 * so the admin answers a topic once, not forty times. Word overlap is crude on
 * purpose — it is predictable, free and good enough for a worklist; the admin
 * can always open the members.
 */
export function clusterQuestions<T extends ClusterItem>(items: T[]): Cluster<T>[] {
  const sorted = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const clusters: { key: Set<string>; norm: string; cluster: Cluster<T> }[] = [];
  for (const item of sorted) {
    const key = new Set(tokens(item.text));
    const norm = normalize(item.text);
    const home = clusters.find((c) => c.norm === norm || similar(c.key, key));
    if (home) home.cluster.items.push(item);
    else clusters.push({ key, norm, cluster: { sample: item, items: [item] } });
  }
  return clusters
    .map((c) => c.cluster)
    .sort((a, b) => b.items.length - a.items.length || b.sample.createdAt.getTime() - a.sample.createdAt.getTime());
}
