/**
 * bt/framework.ts — Behavior Tree framework, Blackboard, and all condition/action nodes.
 *
 * Core:  Selector, Sequence
 * State: Blackboard (game state + memory + map)
 * Nodes: Condition (pure checks) and Action (set pendingAction)
 */

// ─── Game Types ──────────────────────────────────────────────────────────────

export interface You {
  name: string;
  role: string;
  faction: string;
  is_alive: boolean;
  x: number;
  y: number;
  room: string;
  // WS 推送包含这些字段，HTTP /game/current 不返回。
  // 服务器允许中途打断，无需据此等待。
  currently_moving?: boolean;
  doing_task?: boolean;
  remaining_secs?: number;
  kill_cooldown_secs?: number;
}

export interface TaskInfo    { name: string; x: number; y: number; room: string; status?: string; }
export interface PlayerInfo  { name: string; x: number; y: number; room: string; distance?: number; fromSpotted?: boolean; }
export interface CorpseInfo  { name: string; x: number; y: number; room: string; }

export interface GameState {
  phase: string;
  you: You;
  your_tasks: TaskInfo[];
  players: PlayerInfo[];
  corpses: CorpseInfo[];
  emergency?: TaskInfo & { remaining_secs: number };
  task_progress?: { completed: number; goal: number };
}

// ─── Blackboard & Memory ─────────────────────────────────────────────────────

export interface RoomCenter { id: string; x: number; y: number; }

export interface SightingRecord { x: number; y: number; room: string; tick: number; }

export interface Memory {
  /** Recent positions per player (last 5 records). For movement-direction analysis. */
  playerSightings: Map<string, SightingRecord[]>;
  /** First discovery of each corpse. */
  corpseSightings: Map<string, SightingRecord>;
  /** Social encounter cooldowns (player name → tick of last encounter). */
  encounters: Map<string, number>;
  /** Active socialization state. null = not socializing. */
  socializing: { targetPlayer: string; startTick: number } | null;
  /** Per-corpse report decision cache. Cleared when corpse leaves vision. */
  corpseDecisions: Map<string, boolean>;
  /** Crab teammates (known allies to avoid killing). */
  teammates: Set<string>;
  /** Timestamp (ms) when last saw another player. */
  lastPlayerSeenTs: number;
  /** Whether crab has completed a sabotage task and can trigger alarm. */
  canTriggerAlarm: boolean;
  /** Task names assigned at role_assigned (used to identify sabotage tasks). */
  assignedTaskNames: Set<string>;
  /** Count of times a player was seen NOT near any task location. Reset to 0 when seen near a task. */
  playerIdleCount: Map<string, number>;
  /** Stalking state for samurai shrimp — tracking an idle player before killing. */
  stalking: { targetPlayer: string; startTick: number } | null;
  /** Whether the one-time kill ability has been used (gun shrimp). */
  hasUsedOneTimeKill: boolean;
  /** Tick of last kill action (for post-kill flee). -Infinity initially. */
  lastKillTick: number;
  /** Room where the last sabotage task was completed (for delayed alarm trigger). */
  sabotageRoom: string | null;
  /** Hunting state for crab — tracking a lone enemy while on kill cooldown. */
  hunting: { targetPlayer: string; startTick: number } | null;
  /** Tick of last alarm trigger (for sabotage cooldown). -Infinity initially. */
  lastAlarmTick: number;
  /** Paradise fish loitering state — waiting near a corpse to be caught. */
  loitering: { corpseName: string; startTick: number } | null;
}

export interface Blackboard {
  state: GameState;
  pendingAction: object | null;
  /** Reasoning or intent to attach as thinking_content on the next action. */
  thinkingContent: string | null;
  mapRooms: RoomCenter[];
  memory: Memory;
  currentTick: number;
  /** All task locations on the map (from /game/map all_task_locations). */
  allTaskLocations: { x: number; y: number }[];
}

export function createBlackboard(state: GameState, mapRooms: RoomCenter[] = []): Blackboard {
  return {
    state,
    pendingAction: null,
    thinkingContent: null,
    mapRooms,
    memory: {
      playerSightings: new Map(),
      corpseSightings: new Map(),
      encounters: new Map(),
      socializing: null,
      corpseDecisions: new Map(),
      teammates: new Set(),
      lastPlayerSeenTs: Date.now(),
      canTriggerAlarm: false,
      assignedTaskNames: new Set(),
      playerIdleCount: new Map(),
      stalking: null,
      hasUsedOneTimeKill: false,
      lastKillTick: -Infinity,
      sabotageRoom: null,
      hunting: null,
      lastAlarmTick: -Infinity,
      loitering: null,
    },
    currentTick: 0,
    allTaskLocations: [],
  };
}

// ─── Core BT ─────────────────────────────────────────────────────────────────

export enum NodeStatus { SUCCESS, FAILURE, RUNNING }

export abstract class BtNode {
  abstract tick(bb: Blackboard): NodeStatus;
}

/** Try children in order; return first non-FAILURE result. */
export class Selector extends BtNode {
  constructor(private children: BtNode[]) { super(); }
  tick(bb: Blackboard): NodeStatus {
    for (const c of this.children) {
      const s = c.tick(bb);
      if (s !== NodeStatus.FAILURE) return s;
    }
    return NodeStatus.FAILURE;
  }
}

/** Run children in order; stop on first non-SUCCESS result. */
export class Sequence extends BtNode {
  constructor(private children: BtNode[]) { super(); }
  tick(bb: Blackboard): NodeStatus {
    for (const c of this.children) {
      const s = c.tick(bb);
      if (s !== NodeStatus.SUCCESS) return s;
    }
    return NodeStatus.SUCCESS;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
}

export function nearest<T extends { x: number; y: number }>(from: { x: number; y: number }, items: T[]): T | null {
  if (!items.length) return null;
  return items.reduce((a, b) =>
    dist(from.x, from.y, a.x, a.y) <= dist(from.x, from.y, b.x, b.y) ? a : b
  );
}

/** Map room id to display name. Handles the one English outlier. */
function roomName(room: string | null | undefined): string {
  if (!room) return "未知区域";
  return room === "hallway" ? "走廊" : room;
}

// ─── Condition Nodes ─────────────────────────────────────────────────────────

export class HasEmergency extends BtNode {
  tick(bb: Blackboard) { return bb.state.emergency ? NodeStatus.SUCCESS : NodeStatus.FAILURE; }
}

export class NearEmergency extends BtNode {
  tick(bb: Blackboard) {
    const { you } = bb.state; const e = bb.state.emergency;
    if (!e || e.x == null || e.y == null) return NodeStatus.FAILURE;
    return dist(you.x, you.y, e.x, e.y) <= 100 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

export class NearCorpse extends BtNode {
  tick(bb: Blackboard) {
    return bb.state.corpses.length > 0 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

export class HasTasks extends BtNode {
  tick(bb: Blackboard) { return bb.state.your_tasks.length > 0 ? NodeStatus.SUCCESS : NodeStatus.FAILURE; }
}

export class NearTask extends BtNode {
  tick(bb: Blackboard) {
    const { you, your_tasks } = bb.state;
    const t = nearest(you, your_tasks);
    return t && dist(you.x, you.y, t.x, t.y) <= 100 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

export class CanKill extends BtNode {
  tick(bb: Blackboard) { return (bb.state.you.kill_cooldown_secs ?? 0) <= 0 ? NodeStatus.SUCCESS : NodeStatus.FAILURE; }
}

export class HasNearbyEnemy extends BtNode {
  tick(bb: Blackboard) {
    const { you, players } = bb.state;
    return players.some(p =>
      p.name !== you.name
      && !bb.memory.teammates.has(p.name)
      && !p.fromSpotted
      && dist(you.x, you.y, p.x, p.y) <= 100
    ) ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when at least one other player is visible. */
export class HasVisiblePlayer extends BtNode {
  tick(bb: Blackboard) {
    return bb.state.players.some(p => p.name !== bb.state.you.name) ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

export class PlayerTooFar extends BtNode {
  tick(bb: Blackboard) {
    const { you, players } = bb.state;
    const t = players.find(p => p.name !== you.name);
    return t && dist(you.x, you.y, t.x, t.y) > 50 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

export class IsRole extends BtNode {
  constructor(private roleName: string) { super(); }
  tick(bb: Blackboard) { return bb.state.you.role === this.roleName ? NodeStatus.SUCCESS : NodeStatus.FAILURE; }
}

/**
 * Smart report decision (per-corpse, evaluated once per sighting):
 *   A) Witness present (other visible player) → report
 *   B) Suspect fleeing (within 500u of corpse in last 5 ticks, moving away) → report
 *   C) Otherwise → 30% chance
 */
export class ShouldReport extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, corpses, players } = bb.state;
    const corpse = nearest(you, corpses);
    if (!corpse) return NodeStatus.FAILURE;

    const cached = bb.memory.corpseDecisions.get(corpse.name);
    if (cached !== undefined) return cached ? NodeStatus.SUCCESS : NodeStatus.FAILURE;

    // A: witness
    if (players.some(p => p.name !== you.name)) {
      bb.memory.corpseDecisions.set(corpse.name, true);
      return NodeStatus.SUCCESS;
    }

    // B: suspect fleeing
    const cx = corpse.x ?? 0, cy = corpse.y ?? 0;
    if (cx !== 0 || cy !== 0) {
      for (const [, records] of bb.memory.playerSightings) {
        const recent = records.filter(r => bb.currentTick - r.tick <= 5);
        if (!recent.length || !recent.some(r => dist(r.x, r.y, cx, cy) <= 500)) continue;
        if (recent.length >= 2) {
          const prev = recent[recent.length - 2], last = recent[recent.length - 1];
          if (dist(last.x, last.y, cx, cy) > dist(prev.x, prev.y, cx, cy)) {
            bb.memory.corpseDecisions.set(corpse.name, true);
            return NodeStatus.SUCCESS;
          }
        } else {
          bb.memory.corpseDecisions.set(corpse.name, true);
          return NodeStatus.SUCCESS;
        }
      }
    }

    // C: random 30%
    const decision = Math.random() < 0.3;
    bb.memory.corpseDecisions.set(corpse.name, decision);
    return decision ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when player is NOT near any task (> 30 units). Used to prevent socializing near task locations. */
export class NotNearTask extends BtNode {
  tick(bb: Blackboard) {
    const { you, your_tasks } = bb.state;
    const t = nearest(you, your_tasks);
    if (!t) return NodeStatus.SUCCESS; // no tasks, free to socialize
    return dist(you.x, you.y, t.x, t.y) > 30 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

export class IsSocializing extends BtNode {
  tick(bb: Blackboard) { return bb.memory.socializing ? NodeStatus.SUCCESS : NodeStatus.FAILURE; }
}

export class NotSocializing extends BtNode {
  tick(bb: Blackboard) { return bb.memory.socializing ? NodeStatus.FAILURE : NodeStatus.SUCCESS; }
}

export class SocializationNotExpired extends BtNode {
  tick(bb: Blackboard) {
    const s = bb.memory.socializing;
    if (!s) return NodeStatus.FAILURE;
    if (bb.currentTick - s.startTick >= 5) {
      bb.memory.socializing = null;
      return NodeStatus.FAILURE;
    }
    return NodeStatus.SUCCESS;
  }
}

export class NotRecentlyEncountered extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, players } = bb.state;
    const target = nearest(you, players.filter(p => p.name !== you.name));
    if (!target) return NodeStatus.FAILURE;
    const last = bb.memory.encounters.get(target.name);
    return (last === undefined || bb.currentTick - last >= 10) ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

// ─── Action Nodes ────────────────────────────────────────────────────────────

export class MoveToEmergency extends BtNode {
  tick(bb: Blackboard) {
    const e = bb.state.emergency;
    if (!e || e.x == null || e.y == null) return NodeStatus.FAILURE;
    bb.pendingAction = { action: "move", target_x: e.x, target_y: e.y };
    bb.thinkingContent = `紧急任务！前往 ${roomName(e.room)} 处理 ${(e as any).task_name ?? e.name ?? "emergency"}，剩余 ${Math.round(e.remaining_secs)}s`;
    return NodeStatus.SUCCESS;
  }
}

export class DoEmergencyTask extends BtNode {
  tick(bb: Blackboard) {
    const e = bb.state.emergency;
    if (!e) return NodeStatus.FAILURE;
    const taskName = e.name ?? (e as any).task_name;
    if (!taskName) return NodeStatus.FAILURE;
    bb.pendingAction = { action: "task", task_name: taskName };
    bb.thinkingContent = `执行紧急任务 ${taskName}，剩余 ${Math.round(e.remaining_secs)}s，必须完成`;
    return NodeStatus.SUCCESS;
  }
}

export class Report extends BtNode {
  tick(bb: Blackboard) {
    const corpse = nearest(bb.state.you, bb.state.corpses);
    bb.pendingAction = { action: "report" };
    bb.thinkingContent = `发现尸体${corpse ? `（${corpse.name} 在 ${roomName(corpse.room)}）` : ""}，报告召开会议`;
    return NodeStatus.SUCCESS;
  }
}

export class MoveToNearestTask extends BtNode {
  tick(bb: Blackboard) {
    const t = nearest(bb.state.you, bb.state.your_tasks);
    if (!t) return NodeStatus.FAILURE;
    bb.pendingAction = { action: "move", target_x: t.x, target_y: t.y };
    return NodeStatus.SUCCESS;
  }
}

export class DoNearestTask extends BtNode {
  tick(bb: Blackboard) {
    const t = nearest(bb.state.you, bb.state.your_tasks);
    if (!t) return NodeStatus.FAILURE;
    bb.pendingAction = { action: "task", task_name: t.name };
    bb.thinkingContent = `执行任务 ${t.name}`;
    return NodeStatus.SUCCESS;
  }
}

export class KillNearbyEnemy extends BtNode {
  tick(bb: Blackboard) {
    const { you, players } = bb.state;
    const t = players.find(p =>
      p.name !== you.name
      && !bb.memory.teammates.has(p.name)
      && !p.fromSpotted
      && dist(you.x, you.y, p.x, p.y) <= 100
    );
    if (!t) return NodeStatus.FAILURE;
    const enemies = players.filter(p => p.name !== you.name && !bb.memory.teammates.has(p.name));
    const reason = enemies.length >= 4 ? "混战局面趁乱" : "单独在场，安全击杀";
    bb.pendingAction = { action: "kill", target: t.name };
    bb.thinkingContent = `${reason}，击杀 ${t.name}（距离 ${dist(you.x, you.y, t.x, t.y).toFixed(0)}u）`;
    bb.memory.lastKillTick = bb.currentTick;
    return NodeStatus.SUCCESS;
  }
}

/** True when only 1 enemy visible (safe kill) or >= 4 enemies (chaos kill). */
export class SafeToKill extends BtNode {
  tick(bb: Blackboard) {
    const { you, players } = bb.state;
    const enemies = players.filter(p =>
      p.name !== you.name && !bb.memory.teammates.has(p.name)
    );
    return (enemies.length === 1 || enemies.length >= 4)
      ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when no other player has been seen for > 20 seconds. */
export class NoPlayerSeenRecently extends BtNode {
  tick(bb: Blackboard) {
    return (Date.now() - bb.memory.lastPlayerSeenTs > 20000)
      ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when crab has completed a sabotage task and can trigger alarm. */
export class CanTriggerAlarm extends BtNode {
  tick(bb: Blackboard) {
    return bb.memory.canTriggerAlarm ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** Trigger emergency alarm (crab only, after sabotage). Reset flag after use. */
export class TriggerAlarm extends BtNode {
  tick(bb: Blackboard) {
    bb.pendingAction = { action: "trigger_alarm" };
    bb.thinkingContent = `触发紧急警报！破坏任务已完成，现在激活倒计时给龙虾施压`;
    bb.memory.canTriggerAlarm = false;
    bb.memory.lastAlarmTick = bb.currentTick;
    return NodeStatus.SUCCESS;
  }
}

/** Move toward the nearest visible player. */
export class ChaseNearestPlayer extends BtNode {
  tick(bb: Blackboard) {
    const { you, players } = bb.state;
    const t = nearest(you, players.filter(p => p.name !== you.name));
    if (!t) return NodeStatus.FAILURE;
    bb.pendingAction = { action: "move", target_x: t.x, target_y: t.y };
    bb.thinkingContent = `追踪玩家 ${t.name}（${roomName(t.room)}）`;
    return NodeStatus.SUCCESS;
  }
}

export class Skip extends BtNode {
  tick(bb: Blackboard) {
    bb.pendingAction = { action: "skip" };
    bb.thinkingContent = "等待，无可执行操作";
    return NodeStatus.SUCCESS;
  }
}

/** Wander near the nearest corpse (stay within 30~80 units). */
export class WanderNearCorpse extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, corpses } = bb.state;
    const c = nearest(you, corpses);
    if (!c) return NodeStatus.FAILURE;
    const angle = Math.random() * Math.PI * 2;
    const radius = 30 + Math.random() * 50;
    bb.pendingAction = {
      action: "move",
      target_x: c.x + Math.cos(angle) * radius,
      target_y: c.y + Math.sin(angle) * radius,
    };
    bb.thinkingContent = `在尸体 ${c.name} 附近徘徊（${roomName(c.room)}）`;
    return NodeStatus.SUCCESS;
  }
}

/** Wander to a nearby room (prefers close rooms, avoids current + last visited). */
export class Wander extends BtNode {
  private lastRoomId: string | null = null;
  private currentRoomId: string | null = null;

  tick(bb: Blackboard): NodeStatus {
    const { you } = bb.state;
    const rooms = bb.mapRooms;
    if (!rooms?.length) {
      bb.pendingAction = { action: "skip" };
      return NodeStatus.SUCCESS;
    }

    // Track room transitions: when bot enters a new room, record the previous room as lastRoomId
    if (this.currentRoomId !== null && this.currentRoomId !== you.room) {
      this.lastRoomId = this.currentRoomId;
    }
    this.currentRoomId = you.room;

    const sorted = rooms
      .filter(r => r.id !== you.room && r.id !== this.lastRoomId)
      .sort((a, b) => dist(you.x, you.y, a.x, a.y) - dist(you.x, you.y, b.x, b.y));

    if (!sorted.length) {
      const fallback = rooms.filter(r => r.id !== you.room);
      const t = fallback.length ? fallback[Math.floor(Math.random() * fallback.length)] : rooms[0];
      bb.pendingAction = { action: "move", target_x: t.x, target_y: t.y };
      return NodeStatus.SUCCESS;
    }

    const t = sorted[Math.floor(Math.random() * sorted.length)];
    bb.pendingAction = { action: "move", target_x: t.x, target_y: t.y };
    return NodeStatus.SUCCESS;
  }
}

/** Start socialization (70% chance). Always records encounter to prevent re-trigger. */
export class StartSocialization extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, players } = bb.state;
    const target = nearest(you, players.filter(p => p.name !== you.name));
    if (!target) return NodeStatus.FAILURE;

    bb.memory.encounters.set(target.name, bb.currentTick);

    if (Math.random() >= 0.7) return NodeStatus.FAILURE; // 30% skip

    bb.memory.socializing = { targetPlayer: target.name, startTick: bb.currentTick };
    bb.pendingAction = {
      action: "move",
      target_x: target.x,
      target_y: target.y,
    };
    bb.thinkingContent = `开始接触 ${target.name}（${roomName(target.room)}），建立存在感`;
    return NodeStatus.SUCCESS;
  }
}

/** Follow socialization target. Ends if target leaves vision. */
export class FollowSocialTarget extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const s = bb.memory.socializing;
    if (!s) return NodeStatus.FAILURE;

    const target = bb.state.players.find(p => p.name === s.targetPlayer && !p.fromSpotted);
    if (!target) { bb.memory.socializing = null; return NodeStatus.FAILURE; }

    bb.pendingAction = {
      action: "move",
      target_x: target.x,
      target_y: target.y,
    };
    return NodeStatus.SUCCESS;
  }
}

// ─── Samurai Shrimp Nodes ────────────────────────────────────────────────────

/** True when there is a corpse nearby and exactly 1 other living player within 120u of that corpse. */
export class HasPlayerNearCorpseAlone extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, corpses, players } = bb.state;
    const corpse = nearest(you, corpses);
    if (!corpse) return NodeStatus.FAILURE;
    const nearby = players.filter(p =>
      p.name !== you.name && dist(corpse.x, corpse.y, p.x, p.y) <= 120
    );
    return nearby.length === 1 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** Kill the single player standing near the nearest corpse. */
export class KillPlayerNearCorpse extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, corpses, players } = bb.state;
    const corpse = nearest(you, corpses);
    if (!corpse) return NodeStatus.FAILURE;
    const target = players.find(p =>
      p.name !== you.name && dist(corpse.x, corpse.y, p.x, p.y) <= 120
    );
    if (!target) return NodeStatus.FAILURE;
    bb.pendingAction = { action: "kill", target: target.name };
    bb.thinkingContent = `现行抓获：${target.name} 在尸体 ${corpse.name} 旁边（${roomName(corpse.room)}），击杀`;
    return NodeStatus.SUCCESS;
  }
}

/** True when task_progress.completed / task_progress.goal >= 0.7. */
export class TaskProgressNearGoal extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const tp = bb.state.task_progress;
    if (!tp || !tp.goal) return NodeStatus.FAILURE;
    return (tp.completed / tp.goal) >= 0.7 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when a player with idleCount >= 5 is visible and within kill range (100u). */
export class HasIdlePlayerInRange extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, players } = bb.state;
    for (const p of players) {
      if (p.name === you.name) continue;
      const idle = bb.memory.playerIdleCount.get(p.name) ?? 0;
      if (idle >= 5 && dist(you.x, you.y, p.x, p.y) <= 100) return NodeStatus.SUCCESS;
    }
    return NodeStatus.FAILURE;
  }
}

/** Kill the idle player (highest idleCount) within range. */
export class KillIdlePlayer extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, players } = bb.state;
    let best: PlayerInfo | null = null;
    let bestIdle = 0;
    for (const p of players) {
      if (p.name === you.name) continue;
      const idle = bb.memory.playerIdleCount.get(p.name) ?? 0;
      if (idle >= 5 && dist(you.x, you.y, p.x, p.y) <= 100 && idle > bestIdle) {
        best = p;
        bestIdle = idle;
      }
    }
    if (!best) return NodeStatus.FAILURE;
    bb.pendingAction = { action: "kill", target: best.name };
    bb.thinkingContent = `击杀长期游荡的可疑玩家 ${best.name}（idle=${bestIdle}）`;
    bb.memory.stalking = null;
    return NodeStatus.SUCCESS;
  }
}

/** True when the player's current room has one of their own tasks. */
export class InRoomWithOwnTask extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, your_tasks } = bb.state;
    return your_tasks.some(t => t.room === you.room) ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when the one-time kill ability has NOT been used yet (gun shrimp). */
export class HasOneTimeKill extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    return bb.memory.hasUsedOneTimeKill ? NodeStatus.FAILURE : NodeStatus.SUCCESS;
  }
}

// ─── Stalking Nodes (Samurai Shrimp pre-kill observation) ────────────────────

export class IsStalking extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    return bb.memory.stalking ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when stalking has lasted >= 3 ticks. */
export class StalkingExpired extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const s = bb.memory.stalking;
    if (!s) return NodeStatus.FAILURE;
    return (bb.currentTick - s.startTick >= 3) ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** Start stalking the highest-idle player in range. */
export class StartStalking extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, players } = bb.state;
    let best: PlayerInfo | null = null;
    let bestIdle = 0;
    for (const p of players) {
      if (p.name === you.name) continue;
      const idle = bb.memory.playerIdleCount.get(p.name) ?? 0;
      if (idle >= 5 && dist(you.x, you.y, p.x, p.y) <= 100 && idle > bestIdle) {
        best = p;
        bestIdle = idle;
      }
    }
    if (!best) return NodeStatus.FAILURE;
    bb.memory.stalking = { targetPlayer: best.name, startTick: bb.currentTick };
    const angle = Math.random() * Math.PI * 2;
    bb.pendingAction = {
      action: "move",
      target_x: best.x + Math.cos(angle) * 50,
      target_y: best.y + Math.sin(angle) * 50,
    };
    bb.thinkingContent = `开始跟踪可疑玩家 ${best.name}（idle=${bestIdle}），观察后择机击杀`;
    return NodeStatus.SUCCESS;
  }
}

/** Follow the stalking target. Cancels if target leaves vision. */
export class FollowStalkTarget extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const s = bb.memory.stalking;
    if (!s) return NodeStatus.FAILURE;
    const target = bb.state.players.find(p => p.name === s.targetPlayer && !p.fromSpotted);
    if (!target) { bb.memory.stalking = null; return NodeStatus.FAILURE; }
    const angle = Math.random() * Math.PI * 2;
    bb.pendingAction = {
      action: "move",
      target_x: target.x + Math.cos(angle) * 50,
      target_y: target.y + Math.sin(angle) * 50,
    };
    return NodeStatus.SUCCESS;
  }
}

// ─── Crab Nodes ──────────────────────────────────────────────────────────────

/** True when the crab just killed someone within the last 3 ticks. */
export class JustKilled extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    return (bb.currentTick - bb.memory.lastKillTick < 3)
      ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** Flee to a random room different from the current one after a kill. */
export class FleeFromKillSite extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you } = bb.state;
    const rooms = bb.mapRooms;
    if (!rooms?.length) {
      bb.pendingAction = { action: "skip" };
      bb.thinkingContent = "刚刚完成击杀，无路可逃，原地等待";
      return NodeStatus.SUCCESS;
    }
    const cands = rooms.filter(r => r.id !== you.room);
    if (!cands.length) {
      bb.pendingAction = { action: "skip" };
      bb.thinkingContent = "刚刚完成击杀，无其他房间可逃";
      return NodeStatus.SUCCESS;
    }
    const t = cands[Math.floor(Math.random() * cands.length)];
    bb.pendingAction = { action: "move", target_x: t.x, target_y: t.y };
    bb.thinkingContent = `刚击杀完毕，迅速撤离到 ${roomName(t.id)} 制造不在场证明`;
    return NodeStatus.SUCCESS;
  }
}

/** True when crab is NOT in the room where the last sabotage was done. */
export class NotInSabotageRoom extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const sr = bb.memory.sabotageRoom;
    if (!sr) return NodeStatus.SUCCESS; // no sabotage yet, safe to trigger
    return bb.state.you.room !== sr ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when kill is on cooldown (kill_cooldown_secs > 0). */
export class OnKillCooldown extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    return (bb.state.you.kill_cooldown_secs ?? 0) > 0
      ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when exactly 1 non-teammate enemy is visible (lone target for hunting). */
export class HasLoneEnemy extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, players } = bb.state;
    const enemies = players.filter(p =>
      p.name !== you.name && !bb.memory.teammates.has(p.name)
    );
    return enemies.length === 1 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when crab is actively hunting a target. */
export class IsHunting extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    return bb.memory.hunting ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** Start hunting the lone visible enemy. Records target and follows. */
export class StartHunting extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, players } = bb.state;
    const target = players.find(p =>
      p.name !== you.name && !bb.memory.teammates.has(p.name)
    );
    if (!target) return NodeStatus.FAILURE;
    bb.memory.hunting = { targetPlayer: target.name, startTick: bb.currentTick };
    bb.pendingAction = {
      action: "move",
      target_x: target.x,
      target_y: target.y,
    };
    bb.thinkingContent = `锁定猎物 ${target.name}（${roomName(target.room)}），CD 好了立刻击杀`;
    return NodeStatus.SUCCESS;
  }
}

/** Follow the hunt target. Cancels hunting if target leaves vision. */
export class FollowHuntTarget extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const h = bb.memory.hunting;
    if (!h) return NodeStatus.FAILURE;
    const target = bb.state.players.find(p => p.name === h.targetPlayer && !p.fromSpotted);
    if (!target) { bb.memory.hunting = null; return NodeStatus.FAILURE; }
    bb.pendingAction = {
      action: "move",
      target_x: target.x,
      target_y: target.y,
    };
    return NodeStatus.SUCCESS;
  }
}

/** Kill the hunt target. Clears hunting state and records kill tick. */
export class KillHuntTarget extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const h = bb.memory.hunting;
    if (!h) return NodeStatus.FAILURE;
    const target = bb.state.players.find(p =>
      p.name === h.targetPlayer && !p.fromSpotted && dist(bb.state.you.x, bb.state.you.y, p.x, p.y) <= 100
    );
    if (!target) { bb.memory.hunting = null; return NodeStatus.FAILURE; }
    bb.pendingAction = { action: "kill", target: target.name };
    bb.thinkingContent = `CD 已就绪，击杀猎物 ${target.name}`;
    bb.memory.hunting = null;
    bb.memory.lastKillTick = bb.currentTick;
    return NodeStatus.SUCCESS;
  }
}

/** Crab report decision: 40% chance per corpse (cached per corpse name). */
export class CrabShouldReport extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, corpses } = bb.state;
    const corpse = nearest(you, corpses);
    if (!corpse) return NodeStatus.FAILURE;
    const cached = bb.memory.corpseDecisions.get(corpse.name);
    if (cached !== undefined) return cached ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    const decision = Math.random() < 0.4;
    bb.memory.corpseDecisions.set(corpse.name, decision);
    return decision ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when >= 30 ticks have passed since last alarm trigger (sabotage cooldown). */
export class SabotageCooldownReady extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    return (bb.currentTick - bb.memory.lastAlarmTick >= 30)
      ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

// ─── Paradise Fish Nodes ─────────────────────────────────────────────────────

/** True when paradise fish is loitering near a corpse. */
export class IsLoitering extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    return bb.memory.loitering ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when loitering has NOT expired (< 8 ticks). */
export class LoiteringNotExpired extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const l = bb.memory.loitering;
    if (!l) return NodeStatus.FAILURE;
    return (bb.currentTick - l.startTick < 8) ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** True when no other player is visible. */
export class NoVisiblePlayer extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    return bb.state.players.every(p => p.name === bb.state.you.name)
      ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
  }
}

/** Start loitering near the nearest corpse. Move to 30~80u from it. */
export class StartLoitering extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, corpses } = bb.state;
    const c = nearest(you, corpses);
    if (!c) return NodeStatus.FAILURE;
    bb.memory.loitering = { corpseName: c.name, startTick: bb.currentTick };
    const angle = Math.random() * Math.PI * 2;
    const radius = 30 + Math.random() * 50;
    bb.pendingAction = {
      action: "move",
      target_x: c.x + Math.cos(angle) * radius,
      target_y: c.y + Math.sin(angle) * radius,
    };
    bb.thinkingContent = `开始在尸体 ${c.name} 旁徘徊，制造嫌疑，等待有人看见我`;
    return NodeStatus.SUCCESS;
  }
}

/** Continue loitering: random move within 30~80u of the corpse. Cancels if corpse gone. */
export class ContinueLoitering extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const l = bb.memory.loitering;
    if (!l) return NodeStatus.FAILURE;
    const corpse = bb.state.corpses.find(c => c.name === l.corpseName);
    if (!corpse) { bb.memory.loitering = null; return NodeStatus.FAILURE; }
    const angle = Math.random() * Math.PI * 2;
    const radius = 30 + Math.random() * 50;
    bb.pendingAction = {
      action: "move",
      target_x: corpse.x + Math.cos(angle) * radius,
      target_y: corpse.y + Math.sin(angle) * radius,
    };
    return NodeStatus.SUCCESS;
  }
}

/** Flee from corpse to a nearby room (same as Wander — pick from closest 3). Clears loitering. */
export class FleeFromCorpse extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    bb.memory.loitering = null;
    const { you } = bb.state;
    const rooms = bb.mapRooms;
    if (!rooms?.length) {
      bb.pendingAction = { action: "skip" };
      bb.thinkingContent = "有人来了！想逃但没有路";
      return NodeStatus.SUCCESS;
    }
    const sorted = rooms
      .filter(r => r.id !== you.room)
      .sort((a, b) => dist(you.x, you.y, a.x, a.y) - dist(you.x, you.y, b.x, b.y));
    if (!sorted.length) {
      bb.pendingAction = { action: "skip" };
      bb.thinkingContent = "有人来了！无处可逃";
      return NodeStatus.SUCCESS;
    }
    const topN = sorted.slice(0, Math.min(3, sorted.length));
    const t = topN[Math.floor(Math.random() * topN.length)];
    bb.pendingAction = { action: "move", target_x: t.x, target_y: t.y };
    bb.thinkingContent = `有目击者出现！迅速从尸体旁逃往 ${roomName(t.id)}，制造逃跑嫌疑`;
    return NodeStatus.SUCCESS;
  }
}

/** Clear loitering state (used when loitering expires). Always succeeds. */
export class ClearLoitering extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    bb.memory.loitering = null;
    return NodeStatus.SUCCESS;
  }
}

/** Paradise fish socialization: 100% trigger (more aggressive than shrimp's 70%). */
export class ParadiseFishSocialize extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const { you, players } = bb.state;
    const target = nearest(you, players.filter(p => p.name !== you.name));
    if (!target) return NodeStatus.FAILURE;
    bb.memory.encounters.set(target.name, bb.currentTick);
    bb.memory.socializing = { targetPlayer: target.name, startTick: bb.currentTick };
    const angle = Math.random() * Math.PI * 2;
    bb.pendingAction = {
      action: "move",
      target_x: target.x + Math.cos(angle) * 50,
      target_y: target.y + Math.sin(angle) * 50,
    };
    bb.thinkingContent = `接近 ${target.name}，制造可疑互动，增加被投票出局的机会`;
    return NodeStatus.SUCCESS;
  }
}

/** Paradise fish socialization expiry: 8 ticks (longer than shrimp's 5). */
export class ParadiseFishSocNotExpired extends BtNode {
  tick(bb: Blackboard): NodeStatus {
    const s = bb.memory.socializing;
    if (!s) return NodeStatus.FAILURE;
    if (bb.currentTick - s.startTick >= 8) {
      bb.memory.socializing = null;
      return NodeStatus.FAILURE;
    }
    return NodeStatus.SUCCESS;
  }
}
