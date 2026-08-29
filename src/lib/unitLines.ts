/**
 * Unit upgrade lines: what a queued unit had actually become.
 *
 * A recording only ever names the base unit. Queuing a Champion still emits
 * "Militia", because the command carries the line's base id and the game
 * resolves it against what the owner has researched -- so the counts are right
 * but from the Feudal Age on the name is not. This table renames a line to
 * whatever its owner had researched by the end of the counted range.
 *
 * Only irregular lines are listed. Every "Elite X" upgrade follows from its
 * own unit's name, so `upgradeSteps()` derives those instead, covering the
 * fifty-odd unique units without a table entry each.
 *
 * Ages do not count here. Fire Galley -> Fire Ship and Demolition Raft ->
 * Demolition Ship happen on reaching the Castle Age rather than through a
 * research, and no command records them, so those two lines rename only at
 * their researched step.
 */

export interface UpgradeStep {
  /** The RESEARCH item that performs the upgrade. */
  tech: string;
  /** What the line is called once it lands. */
  unit: string;
}

/** Base unit as the recording names it -> its chain, weakest upgrade first. */
const LINES: Record<string, UpgradeStep[]> = {
  // Barracks. Legionary is the Romans' step past Champion.
  "Militia": [
    { tech: "Man-at-Arms", unit: "Man-at-Arms" },
    { tech: "Long Swordsman", unit: "Long Swordsman" },
    { tech: "Two-Handed Swordsman", unit: "Two-Handed Swordsman" },
    { tech: "Champion", unit: "Champion" },
    { tech: "Legionary", unit: "Legionary" },
  ],
  "Spearman": [
    { tech: "Pikeman", unit: "Pikeman" },
    { tech: "Halberdier", unit: "Halberdier" },
  ],
  // The only line whose base name is not a prefix of its elite step.
  "Eagle Scout": [
    { tech: "Eagle Warrior", unit: "Eagle Warrior" },
    { tech: "Elite Eagle Warrior", unit: "Elite Eagle Warrior" },
  ],

  // Archery Range.
  "Archer": [
    { tech: "Crossbowman", unit: "Crossbowman" },
    { tech: "Arbalester", unit: "Arbalester" },
  ],
  "Skirmisher": [
    { tech: "Elite Skirmisher", unit: "Elite Skirmisher" },
    { tech: "Imperial Skirmisher", unit: "Imperial Skirmisher" },
  ],
  "Cavalry Archer": [{ tech: "Heavy Cavalry Archer", unit: "Heavy Cavalry Archer" }],

  // Stable.
  "Scout Cavalry": [
    { tech: "Light Cavalry", unit: "Light Cavalry" },
    { tech: "Hussar", unit: "Hussar" },
    { tech: "Winged Hussar", unit: "Winged Hussar" },
  ],
  "Knight": [
    { tech: "Cavalier", unit: "Cavalier" },
    { tech: "Paladin", unit: "Paladin" },
  ],
  "Camel Rider": [
    { tech: "Heavy Camel Rider", unit: "Heavy Camel Rider" },
    { tech: "Imperial Camel Rider", unit: "Imperial Camel Rider" },
  ],
  "Hei Guang Cavalry": [{ tech: "Heavy Hei Guang Cavalry", unit: "Heavy Hei Guang Cavalry" }],

  // Siege Workshop.
  "Battering Ram": [
    { tech: "Capped Ram", unit: "Capped Ram" },
    { tech: "Siege Ram", unit: "Siege Ram" },
  ],
  "Mangonel": [
    { tech: "Onager", unit: "Onager" },
    { tech: "Siege Onager", unit: "Siege Onager" },
  ],
  "Scorpion": [{ tech: "Heavy Scorpion", unit: "Heavy Scorpion" }],
  "Bombard Cannon": [{ tech: "Houfnice", unit: "Houfnice" }],
  "Rocket Cart": [{ tech: "Heavy Rocket Cart", unit: "Heavy Rocket Cart" }],

  // Dock.
  "Galley": [
    { tech: "War Galley", unit: "War Galley" },
    { tech: "Galleon", unit: "Galleon" },
    { tech: "Dragon Ship", unit: "Dragon Ship" },
  ],
  "Fire Galley": [{ tech: "Fast Fire Ship", unit: "Fast Fire Ship" }],
  "Demolition Raft": [{ tech: "Heavy Demo Ship", unit: "Heavy Demolition Ship" }],
};

/** One upgrade, and when its owner started researching it. */
export interface AppliedUpgrade {
  name: string;
  t: number;
}

/**
 * The chain for a queued unit, weakest upgrade first.
 *
 * Anything not in the table gets the elite rule: a unique unit's only upgrade
 * is the tech named after it. The tech may well not exist -- there is no
 * "Elite Villager" -- which costs nothing, since a lookup for it simply misses.
 */
export function upgradeSteps(base: string): UpgradeStep[] {
  const listed = LINES[base];
  if (listed) return listed;
  if (base.startsWith("Elite ")) return [];
  return [{ tech: `Elite ${base}`, unit: `Elite ${base}` }];
}

/**
 * What a queued unit is called given the techs its owner holds.
 *
 * `held` maps a tech to the moment its research was ordered. Those are
 * commands, not completions -- the recording carries nothing else -- so a
 * rename lands when the upgrade was started, a minute or two before the units
 * really changed, and an upgrade that was cancelled renames the line anyway.
 *
 * The last matching step wins rather than the first, so a chain researched out
 * of order (or read at a moment when several are already held) still resolves
 * to its furthest step.
 */
export function currentUnit(base: string, held: Map<string, number> | undefined): {
  name: string;
  via: AppliedUpgrade[];
} {
  const via: AppliedUpgrade[] = [];
  let name = base;
  if (held) {
    for (const step of upgradeSteps(base)) {
      const t = held.get(step.tech);
      if (t === undefined) continue;
      name = step.unit;
      via.push({ name: step.unit, t });
    }
  }
  return { name, via };
}
