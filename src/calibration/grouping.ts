/**
 * Work out which players are in the same Music Assistant sync group.
 *
 * MA describes grouping in several overlapping ways (synced_to on members,
 * group_members on leaders, active_group pointing at a group player), and
 * which ones are filled in varies by provider. So treat every relationship as
 * an edge and take connected components, instead of trusting one field.
 */

import type { Player } from '../types';

function related(p: Player): string[] {
  const ids: Array<string | null | undefined> = [
    p.synced_to,
    p.active_group,
    ...(p.group_members ?? []),
    ...(p.group_childs ?? []),
    ...(p.static_group_members ?? []),
  ];
  return ids.filter((id): id is string => !!id && id !== p.player_id);
}

export interface GroupAnalysis {
  /** One entry per distinct group among the given player ids: the id to play the track on */
  targets: string[];
  /** Which group (index into targets) each given player belongs to */
  groupIndex: Record<string, number>;
}

export function analyzeGroups(allPlayers: Player[], selectedIds: string[]): GroupAnalysis {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  for (const p of allPlayers) {
    find(p.player_id);
    for (const other of related(p)) union(p.player_id, other);
  }

  const targets: string[] = [];
  const rootToIndex = new Map<string, number>();
  const groupIndex: Record<string, number> = {};

  for (const id of selectedIds) {
    const root = find(id);
    if (!rootToIndex.has(root)) {
      rootToIndex.set(root, targets.length);
      targets.push(pickTarget(allPlayers, root, find, selectedIds));
    }
    groupIndex[id] = rootToIndex.get(root)!;
  }
  return { targets, groupIndex };
}

/** The player the whole group can be driven through */
function pickTarget(
  allPlayers: Player[],
  root: string,
  find: (id: string) => string,
  selectedIds: string[]
): string {
  const members = allPlayers.filter((p) => find(p.player_id) === root);
  const ids = new Set(members.map((p) => p.player_id));

  // A group player (the thing members' active_group points at) is the best target
  const group = members.find((p) => p.type === 'group');
  if (group) return group.player_id;
  const activeGroup = members.map((p) => p.active_group).find((id): id is string => !!id && ids.has(id));
  if (activeGroup) return activeGroup;

  // Otherwise the sync leader: what others are synced to, or whoever lists members
  const syncedTo = members.map((p) => p.synced_to).find((id): id is string => !!id && ids.has(id));
  if (syncedTo) return syncedTo;
  const lister = members.find((p) => (p.group_members ?? p.group_childs ?? []).length > 1);
  if (lister) return lister.player_id;

  return selectedIds.find((id) => ids.has(id)) ?? members[0]?.player_id ?? root;
}
