/**
 * auto_play.ts — ClawArena Shrimp-Crab Kill auto-play bot via WebSocket.
 *
 * Architecture:
 *   - WebSocket: send actions (move/task/kill/report/trigger_alarm), receive events
 *   - HTTP GET /game/current: poll authoritative state each decision cycle
 *   - HTTP GET /game/map: load map rooms & refresh task list
 *   - Behavior Tree: decide next action based on polled state
 *
 * Decision loop:
 *   1. Poll GET /game/current for fresh state
 *   2. Update memory from visible_players, corpses, new_events
 *   3. Tick behavior tree → get pendingAction
 *   4. Send action via WebSocket → wait debounce (500ms) → goto 1
 *
 * Usage:
 *   npx ts-node auto_play.ts --api-key arena_xxx --log-file game.log [--base-url wss://...]
 */

// errorBusyUntil is an error backoff timer — set only for target_unreachable/path errors
// to give path_recovery wander time to execute before the next BT decision.

/// <reference types="node" />

import * as fs from "fs";
import * as path from "path";
import WebSocket from "ws";
import * as https from "https";
import * as http from "http";

import { GameState, TaskInfo, RoomCenter, Memory, Blackboard, BtNode, createBlackboard } from "./bt/framework";
import { createTree } from "./bt/trees";

// ─── Config ───────────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15000;
const RECONNECT_DELAY_MS = 3000;
const TASK_REFRESH_INTERVAL_MS = 5000;
const POST_ACTION_DEBOUNCE_MS = 500;    // wait after sending action before next poll
const MIN_POLL_INTERVAL_MS = 500;       // never poll faster than this
const IDLE_POLL_INTERVAL_MS = 1000;     // poll interval when idle (no action to take)
const STUCK_TIMEOUT_MS = 15000;         // force wander if position unchanged for this long

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let apiKey = "";
  let logFile = "/tmp/claw_arena_game.log";
  let baseUrl = "wss://claw-arena.apps-sl.danlu.netease.com";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api-key")   apiKey  = args[++i];
    if (args[i] === "--log-file")  logFile = args[++i];
    if (args[i] === "--base-url")  baseUrl = args[++i];
  }

  if (!apiKey) {
    console.error("Usage: npx ts-node auto_play.ts --api-key <key> [--log-file <path>] [--base-url <url>]");
    process.exit(1);
  }
  return { apiKey, logFile, baseUrl };
}

// ─── Logger ───────────────────────────────────────────────────────────────────

class Logger {
  private fd: number;

  constructor(logFile: string) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this.fd = fs.openSync(logFile, "a");
  }

  private write(obj: object) {
    fs.writeSync(this.fd, JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
  }

  event(data: object)                          { this.write({ type: "event", data }); }
  action(action: string, payload: object)      { this.write({ type: "action", action, payload }); }
  status(status: string, message: string)      { this.write({ type: "status", status, message }); }
  error(message: string)                       { this.write({ type: "error", message }); }
  wsRaw(msg: unknown)                          { this.write({ type: "ws_raw", msg }); }
  httpRaw(url: string, response: unknown)      { this.write({ type: "http_raw", url, response }); }
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

class Bot {
  private ws!: WebSocket;
  private log: Logger;
  private wsUrl: string;
  private httpBaseUrl: string;

  // ─── Game state ───
  private gameOver = false;
  private lastPhase = "wandering";

  // ─── Map & tasks ───
  private mapRooms: RoomCenter[] = [];
  private cachedTasks: TaskInfo[] = [];
  private completedTaskNames: Set<string> = new Set();
  private lastAttemptedTask: string | null = null;
  private lastTaskRefreshTs = 0;
  /** Track last processed event tick from WebSocket state messages to deduplicate. */
  private lastWsStateTick = -1;
  private isRefreshing = false;
  /** All task locations on the map (for idle player detection). */
  private allTaskLocations: { x: number; y: number }[] = [];

  // ─── Memory ───
  private memory: Memory = {
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
  };

  // ─── Behavior tree ───
  private tree: BtNode | null = null;
  private blackboard: Blackboard | null = null;

  // ─── Timing ───
  private lastActionTs = 0;
  /** Set by WebSocket action_result errors (task_already_in_progress, on_cooldown, etc.)
   *  as a fallback busy signal when HTTP poll state is stale. */
  private errorBusyUntil = 0;
  /** Dedup: JSON of last sent action + timestamp to avoid spamming the same action. */
  private lastSentAction = "";
  private lastSentTs = 0;
  private lastThinkingTs = 0;
  /** When true, next decide() will call fetchMapInfo() to sync tasks from server. */
  private needsTaskRefresh = false;
  /** Last known room of this bot (for sabotageRoom tracking). */
  private lastRoom: string = "";
  /** Anti-stuck: last recorded position and the timestamp it was last updated. */
  private lastKnownPos: { x: number; y: number } | null = null;
  private lastPosMoveTs: number = Date.now();
  /** True while bot is executing an anti-stuck forced move. BT tick is suppressed until move completes or times out. */
  private antiStuckActive = false;
  /** Timestamp when anti-stuck was last triggered (for 10s expiry). */
  private antiStuckTs = 0;
  private readonly ANTI_STUCK_PROTECTION_MS = 10000;
  /** Track socializing state changes to emit social_start / social_end log events. */
  private lastSocialTarget: string | null = null;
  /** Recent player_spotted cache: name → {x, y, room, ts}. Merged into bb.state.players each decide(). */
  private recentSpotted: Map<string, { x: number; y: number; room: string; ts: number }> = new Map();

  constructor(private apiKey: string, logFile: string, baseUrl: string) {
    this.log = new Logger(logFile);
    this.wsUrl = `${baseUrl}/api/v1/game/stream?api_key=${apiKey}`;
    this.httpBaseUrl = baseUrl.replace(/^wss?:\/\//, "https://").replace(/^ws:\/\//, "http://");
  }

  start() {
    this.log.status("net.connecting", `Connecting to ${this.wsUrl}`);
    this.connect();
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  private httpGet(urlPath: string): Promise<any> {
    return new Promise((resolve) => {
      const url = `${this.httpBaseUrl}${urlPath}`;
      const lib = url.startsWith("https") ? https : http;
      const req = lib.get(url, { headers: { Authorization: `Bearer ${this.apiKey}` } }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => body += chunk.toString());
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            this.log.httpRaw(urlPath, json);
            resolve(json);
          }
          catch {
            this.log.error(`net.http_parse_error ${urlPath}: ${body.substring(0, 200)}`);
            resolve(null);
          }
        });
      });
      req.on("error", (err: Error) => {
        this.log.error(`net.http_request_error ${urlPath}: ${err.message}`);
        resolve(null);
      });
    });
  }

  // ─── Map & Task management ─────────────────────────────────────────────────

  private async fetchMapInfo(): Promise<void> {
    const json = await this.httpGet("/api/v1/game/map");
    if (!json?.success || !json.data) return;

    // Load walkable room targets (once)
    if (this.mapRooms.length === 0 && Array.isArray(json.data.rooms)) {
      for (const r of json.data.rooms) {
        const locs = r.task_locations;
        if (locs && typeof locs === "object") {
          const keys = Object.keys(locs);
          if (keys.length > 0) {
            const coord = locs[keys[0]];
            if (Array.isArray(coord) && coord.length === 2) {
              this.mapRooms.push({ id: r.id, x: coord[0], y: coord[1] });
            }
          }
        }
      }
      this.log.status("init.map_loaded", `Loaded ${this.mapRooms.length} walkable room targets`);
    }

    // Load all task locations (for idle player detection)
    if (this.allTaskLocations.length === 0) {
      // Try all_task_locations first
      if (Array.isArray(json.data.all_task_locations) && json.data.all_task_locations.length > 0) {
        for (const loc of json.data.all_task_locations) {
          if (loc.x != null && loc.y != null) {
            this.allTaskLocations.push({ x: loc.x, y: loc.y });
          }
        }
      }
      // Fallback: extract from rooms' task_locations
      if (this.allTaskLocations.length === 0 && Array.isArray(json.data.rooms)) {
        for (const r of json.data.rooms) {
          const locs = r.task_locations;
          if (locs && typeof locs === "object") {
            for (const key of Object.keys(locs)) {
              const coord = locs[key];
              if (Array.isArray(coord) && coord.length === 2) {
                this.allTaskLocations.push({ x: coord[0], y: coord[1] });
              }
            }
          }
        }
      }
      if (this.allTaskLocations.length > 0) {
        this.log.status("init.task_locations", `Loaded ${this.allTaskLocations.length} task locations for idle detection`);
      }
    }

    // Sync tasks with server (authoritative)
    if (Array.isArray(json.data.your_tasks)) {
      this.syncTasks(json.data.your_tasks);
    }
    this.lastTaskRefreshTs = Date.now();
  }

  /** Sync cached tasks with authoritative server list from /game/map.
   *  Tasks missing from server list are treated as completed and removed. */
  private syncTasks(serverTasks: TaskInfo[]) {
    const serverActive = serverTasks.filter(t => t.status !== "completed");
    const serverNames = new Set(serverActive.map(t => t.name));

    // Detect removed tasks (completed on server but still in cache)
    const removedTasks = this.cachedTasks.filter(t => !serverNames.has(t.name));
    for (const t of removedTasks) {
      const wasAlreadyCompleted = this.completedTaskNames.has(t.name);
      this.completedTaskNames.add(t.name);
      if (this.memory.assignedTaskNames.has(t.name) && !wasAlreadyCompleted) {
        this.memory.canTriggerAlarm = true;
      }
    }
    if (removedTasks.length > 0) {
      this.lastSentAction = "";
    }

    // Replace cache with server truth
    this.cachedTasks = serverActive.map(t => ({
      name: t.name, x: t.x, y: t.y, room: t.room, status: t.status ?? "normal"
    }));

    this.log.status("task.synced", `Synced: ${this.cachedTasks.length} active, ${removedTasks.length} removed`);
  }

  /** Mark a task as completed and remove from cache. */
  private markTaskCompleted(taskName: string) {
    this.completedTaskNames.add(taskName);
    this.cachedTasks = this.cachedTasks.filter(t => t.name !== taskName);
  }

  /** Poll /game/map when no cached tasks remain (fallback refresh). */
  private async maybeRefreshTasks(): Promise<void> {
    // All tasks done once — clear completed marks to allow repeating for task_progress
    if (this.getActiveTasks().length === 0 && this.cachedTasks.length > 0) {
      this.completedTaskNames.clear();
      return;
    }
    if (this.cachedTasks.length > 0) return;
    if (this.isRefreshing) return;
    if (Date.now() - this.lastTaskRefreshTs < TASK_REFRESH_INTERVAL_MS) return;
    this.isRefreshing = true;
    await this.fetchMapInfo();
    this.isRefreshing = false;
  }

  /** Build the active task list (excluding completed tasks). */
  private getActiveTasks(): TaskInfo[] {
    return this.cachedTasks.filter(t => !this.completedTaskNames.has(t.name));
  }

  // ─── Memory ────────────────────────────────────────────────────────────────

  /** Record a player sighting into memory (dedup by name+tick). */
  private recordPlayerSighting(name: string, x: number, y: number, room: string, tick: number) {
    const records = this.memory.playerSightings.get(name) ?? [];
    // Dedup: skip if same player same tick
    if (records.length > 0 && records[records.length - 1].tick === tick) return;
    records.push({ x, y, room, tick });
    if (records.length > 5) records.shift();
    this.memory.playerSightings.set(name, records);
  }

  /** Record a corpse discovery into memory (only first time). */
  private recordCorpse(name: string, x: number, y: number, room: string, tick: number) {
    if (this.memory.corpseSightings.has(name)) return;
    this.memory.corpseSightings.set(name, { x: x ?? 0, y: y ?? 0, room: room ?? "unknown", tick });
    this.log.status("game.corpse_found", `Discovered corpse of ${name} in ${room ?? "unknown"}`);
  }

  /** Update memory from polled state (visible_players, corpses, new_events). */
  private updateMemory(data: any, tick: number) {
    const myName = data.you?.name;

    // Visible players
    const players = data.players ?? data.visible_players ?? [];
    for (const p of players) {
      if (p.name !== myName) {
        this.recordPlayerSighting(p.name, p.x, p.y, p.room, tick);

        // Idle player detection: check if player is near any task location
        if (this.allTaskLocations.length > 0) {
          const nearTask = this.allTaskLocations.some(
            loc => Math.sqrt((loc.x - p.x) ** 2 + (loc.y - p.y) ** 2) <= 50
          );
          if (nearTask) {
            this.memory.playerIdleCount.set(p.name, 0);
          } else {
            const prev = this.memory.playerIdleCount.get(p.name) ?? 0;
            this.memory.playerIdleCount.set(p.name, prev + 1);
          }
        }
      }
    }
    if (players.some((p: any) => p.name !== myName)) {
      this.memory.lastPlayerSeenTs = Date.now();
    }

    // Nearby corpses
    const corpses = data.corpses ?? data.nearby_corpses ?? [];
    for (const c of corpses) {
      this.recordCorpse(c.name, c.x, c.y, c.room, tick);
    }

    // Clean up corpse decision cache for corpses no longer in view
    for (const name of this.memory.corpseDecisions.keys()) {
      if (!corpses.find((c: any) => c.name === name)) {
        this.memory.corpseDecisions.delete(name);
      }
    }

    // Process new_events for additional info
    if (Array.isArray(data.new_events)) {
      for (const evt of data.new_events) {
        this.onEvent(evt);
      }
    }
  }

  // ─── WebSocket ─────────────────────────────────────────────────────────────

  private connect() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on("open", () => {
      this.log.status("net.ws_connected", "WebSocket connected");
      setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send("ping");
      }, HEARTBEAT_INTERVAL_MS);
      this.fetchMapInfo().then(() => this.scheduleDecision(0));
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      const text = raw.toString();
      if (text === "pong") return;
      try {
        const msg = JSON.parse(text);
        this.log.wsRaw(msg);
        this.onWsMessage(msg);
      } catch {
        this.log.error(`net.ws_invalid_json: ${text}`);
      }
    });

    this.ws.on("close", () => {
      if (this.gameOver) return;
      this.log.error("net.ws_disconnected, reconnecting...");
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on("error", (err: Error) => this.log.error(`net.ws_error: ${err.message}`));
  }

  /** Handle WebSocket messages — only for events and logging. State comes from HTTP poll. */
  private onWsMessage(msg: { type: string; [k: string]: unknown }) {
    // Extract new_events from state snapshots (cumulative, needs dedup by tick)
    if (msg.type === "state") {
      const data = msg.data as any;
      if (data?.new_events?.length) {
        const threshold = this.lastWsStateTick;
        let maxTick = threshold;
        let skippedCount = 0;
        for (const evt of data.new_events) {
          const evtTick = (evt as any).tick ?? -1;
          if (evtTick <= threshold) { skippedCount++; continue; }
          if (evtTick > maxTick) maxTick = evtTick;
          this.log.event(evt);
          this.onEvent(evt);
        }
        this.lastWsStateTick = maxTick;
        if (skippedCount > 0) {
          this.log.status("ws.events_dedup", `Skipped ${skippedCount} events with tick <= ${threshold}`);
        }
      }
      return;
    }

    const events: { type: string; [k: string]: unknown }[] =
      msg.type === "event_batch" ? (msg.data as typeof events) : [msg];

    for (const evt of events) {
      this.log.event(evt);
      this.onEvent(evt);
    }
  }

  // ─── Event handling ────────────────────────────────────────────────────────

  private onEvent(evt: { type: string; [k: string]: unknown }) {
    switch (evt.type) {
      case "game_over":
        this.gameOver = true;
        this.log.status("game.over", `Winner: ${evt.winner} — ${evt.reason}`);
        process.exit(0);
        break;

      case "meeting_start":
        this.memory.socializing = null;
        this.log.status("game.meeting_start", "Meeting in progress (WS). Handle speech/vote via HTTP.");
        break;

      case "meeting_ended":
        this.log.status("game.meeting_end", "Meeting ended (WS).");
        break;

      case "task_completed":
        this.markTaskCompleted(evt.task_name as string);
        this.lastSentAction = "";
        if (this.memory.assignedTaskNames.has(evt.task_name as string)) {
          this.memory.canTriggerAlarm = true;
          this.memory.sabotageRoom = this.lastRoom || null;
        }
        break;

      case "task_sabotaged":
        this.markTaskCompleted(evt.task_name as string);
        this.lastSentAction = "";
        this.memory.canTriggerAlarm = true;
        this.memory.sabotageRoom = this.lastRoom || null;
        break;

      case "emergency_resolved":
        this.markTaskCompleted(evt.task_name as string);
        this.lastSentAction = "";
        break;

      case "action_result": {
        const error = (evt as any).error ?? (evt as any).data?.error;
        // On success: clear dedup when arrived (distance=0) or task done
        if (!error) {
          const d = (evt as any).data ?? {};
          const distance = d.distance ?? d.data?.distance;
          if (distance === 0 || distance === undefined) {
            this.lastSentAction = "";
          }
        }
        if (error === "task_already_completed" || error === "task_not_assigned_to_you") {
          if (this.lastAttemptedTask) this.markTaskCompleted(this.lastAttemptedTask);
          this.lastSentAction = "";
          this.needsTaskRefresh = true;
        }
        if (error === "task_already_in_progress") {
          this.needsTaskRefresh = true;
        }
        if (error === "no_sabotage_completed") {
          this.needsTaskRefresh = true;
          this.memory.canTriggerAlarm = false;
        }
        if (error === "role_cannot_kill") {
          this.memory.hasUsedOneTimeKill = true;
        }
        if (error === "emergency_already_active") {
          this.memory.canTriggerAlarm = false;
          this.lastSentAction = "";
        }
        if (error === "task_already_completed" && this.lastAttemptedTask) {
          this.markTaskCompleted(this.lastAttemptedTask);
        }
        if (error === "task_not_assigned_to_you" && this.lastAttemptedTask) {
          this.markTaskCompleted(this.lastAttemptedTask);
          this.lastSentAction = "";
        }
        if (error === "target_unreachable_or_too_far" || error === "path_not_found"
            || error === "invalid_position_blocked") {
          this.errorBusyUntil = Date.now() + 3000;
          if (this.mapRooms.length > 0) {
            const curRoom = this.blackboard?.state?.you?.room;
            const cands = this.mapRooms.filter(r => r.id !== curRoom);
            if (cands.length > 0) {
              const target = cands[Math.floor(Math.random() * cands.length)];
              this.sendAction({ action: "move", target_x: target.x, target_y: target.y });
              this.log.status("move.path_recovery", `Path blocked, wandering to ${target.id}`);
            }
          }
        }
        break;
      }

      case "role_assigned": {
        this.log.status("game.role_assigned",
          `Role: ${evt.role_display_name} (${evt.faction}). Goal: ${evt.role_target ?? "?"}`);
        const tasks = (evt as any).assigned_tasks ?? [];
        for (const t of tasks) {
          if (t.name) this.memory.assignedTaskNames.add(t.name);
        }
        break;
      }

      case "crab_teammates": {
        const mates = (evt as any).teammates ?? [];
        for (const name of mates) {
          this.memory.teammates.add(name);
        }
        this.log.status("game.teammates", `Teammates: ${mates.join(", ")}`);
        break;
      }

      case "player_spotted":
        if (evt.spotted_name) {
          this.recordPlayerSighting(
            evt.spotted_name as string,
            evt.spotted_x as number,
            evt.spotted_y as number,
            evt.spotted_room as string,
            evt.tick as number,
          );
          // Also cache for merging into bb.state.players at next decide()
          this.recentSpotted.set(evt.spotted_name as string, {
            x: evt.spotted_x as number,
            y: evt.spotted_y as number,
            room: evt.spotted_room as string,
            ts: Date.now(),
          });
        }
        break;

      case "bobbit_time_start":
        this.log.status("game.bobbit_time", "Bobbit Worm Time! Survive 60s to win.");
        break;

      case "win_blocked_by_bobbit":
        this.log.status("game.win_blocked", `${evt.blocked_winner} win blocked by Bobbit Worm.`);
        break;
    }
  }

  // ─── Decision loop ─────────────────────────────────────────────────────────

  private scheduleDecision(delayMs: number) {
    setTimeout(() => this.decide(), Math.max(delayMs, MIN_POLL_INTERVAL_MS));
  }

  private async decide() {
    try {
      if (this.gameOver) return;

      // Debounce: don't poll too soon after sending an action
      const sinceLast = Date.now() - this.lastActionTs;
      if (this.lastActionTs > 0 && sinceLast < POST_ACTION_DEBOUNCE_MS) {
        this.scheduleDecision(POST_ACTION_DEBOUNCE_MS - sinceLast);
        return;
      }

      // Poll fresh state from server
      const json = await this.httpGet("/api/v1/game/current");
      if (!json?.success || !json.data) {
        this.scheduleDecision(IDLE_POLL_INTERVAL_MS);
        return;
      }

      const data = json.data;
      const tick: number = data.tick ?? 0;

      // Phase transition detection (edge-triggered, HTTP as single source of truth)
      const phase = data.phase;
      if (phase === "meeting" && this.lastPhase !== "meeting") {
        this.memory.socializing = null;
        this.memory.stalking = null;
        this.memory.hunting = null;
        this.memory.loitering = null;
        this.errorBusyUntil = 0;
        this.log.status("game.meeting_start", "Meeting in progress (HTTP).");
      }
      if (phase === "wandering" && this.lastPhase === "meeting") {
        this.log.status("game.meeting_end", "Meeting ended (HTTP).");
      }
      if (phase === "game_over") {
        this.gameOver = true;
        this.log.status("game.over", "Game over (HTTP).");
        process.exit(0);
      }
      this.lastPhase = phase;

      if (phase !== "wandering") {
        // meeting / game_over → don't tick BT, reset stuck timer
        this.antiStuckActive = false;
        this.lastPosMoveTs = Date.now();
        this.lastKnownPos = null;
        this.scheduleDecision(IDLE_POLL_INTERVAL_MS);
        return;
      }

      // Sync tasks from /game/current response (authoritative complete list)
      if (Array.isArray(data.your_tasks)) {
        this.syncTasks(data.your_tasks);
      }

      // Update memory (players, corpses, events)
      this.updateMemory(data, tick);

      const you = data.you;

      // Track current room for sabotage room detection
      if (you?.room) this.lastRoom = you.room;

      // If dead, stop the bot
      if (!you?.is_alive) {
        this.log.status("game.dead", "Player is dead. Exiting.");
        process.exit(0);
      }

      // NOTE: currently_moving / doing_task / remaining_secs 虽然会通过 WS 推送下来
      // （HTTP /game/current 不返回这几个字段），但服务器允许在移动或任务执行中途
      // 发送新的 action 来打断当前操作，因此无需根据这些字段等待，直接决策即可。

      // Error backoff: give path_recovery wander time to execute before next BT tick.
      // Only set for target_unreachable / path_not_found / invalid_position_blocked.
      if (Date.now() < this.errorBusyUntil) {
        const waitMs = Math.max(this.errorBusyUntil - Date.now(), MIN_POLL_INTERVAL_MS);
        this.scheduleDecision(waitMs);
        return;
      }

      // Anti-stuck protection: suppress BT tick until forced move completes or 10s timeout
      if (this.antiStuckActive) {
        const timedOut = Date.now() - this.antiStuckTs > this.ANTI_STUCK_PROTECTION_MS;
        if (!timedOut) {
          // Still waiting for anti-stuck move — keep waiting
          this.scheduleDecision(IDLE_POLL_INTERVAL_MS);
          return;
        } else {
          // 10s timeout — lift the lock and resume BT
          this.antiStuckActive = false;
          this.lastPosMoveTs = Date.now();
          this.lastKnownPos = { x: you.x, y: you.y };
          this.log.status("move.stuck_resolved", `Anti-stuck ended (timed out), resuming BT`);
        }
      }

      // Anti-stuck: if position unchanged for STUCK_TIMEOUT_MS, force wander
      {
        const pos = { x: you.x, y: you.y };
        if (!this.lastKnownPos
          || this.lastKnownPos.x !== pos.x
          || this.lastKnownPos.y !== pos.y) {
          this.lastKnownPos = pos;
          this.lastPosMoveTs = Date.now();
        } else if (Date.now() - this.lastPosMoveTs > STUCK_TIMEOUT_MS) {
          const cands = this.mapRooms.filter(r => r.id !== you.room);
          if (cands.length > 0) {
            const t = cands[Math.floor(Math.random() * cands.length)];
            this.lastSentAction = ""; // bypass dedup so anti-stuck move always fires
            this.sendAction({ action: "move", target_x: t.x, target_y: t.y });
            this.log.status("move.stuck", `Stuck for ${STUCK_TIMEOUT_MS / 1000}s, forcing wander to ${t.id}`);
            this.antiStuckActive = true;
            this.antiStuckTs = Date.now();
          }
          this.lastPosMoveTs = Date.now();
          this.scheduleDecision(POST_ACTION_DEBOUNCE_MS);
          return;
        }
      }

      // Refresh tasks if none cached
      await this.maybeRefreshTasks();

      // Sync tasks from server when refresh is needed (e.g. after task_already_in_progress errors)
      if (this.needsTaskRefresh && Date.now() - this.lastTaskRefreshTs >= TASK_REFRESH_INTERVAL_MS) {
        await this.fetchMapInfo();
        this.needsTaskRefresh = false;
      }

      // If emergency active, ensure we have its coordinates by refreshing map
      if (data.emergency?.task_name) {
        const emergencyTaskName = (data.emergency as any).task_name as string;
        const hasEmergencyTask = this.cachedTasks.some(
          t => t.name === emergencyTaskName
        );
        if (!hasEmergencyTask) {
          await this.fetchMapInfo();
        }
      }

      // Build game state for behavior tree
      // Merge HTTP visible_players with recently spotted players (from WebSocket player_spotted events).
      // player_spotted events fire during movement but decide() only runs when idle, so without this
      // merge bb.state.players would be empty whenever visible_players is empty on the poll.
      const RECENT_SPOTTED_TTL_MS = 8000;
      const pollPlayers: { name: string; x: number; y: number; room: string; fromSpotted?: boolean }[] =
        data.players ?? data.visible_players ?? [];
      const pollPlayerNames = new Set(pollPlayers.map((p: any) => p.name));
      // Evict stale entries and merge non-duplicate spotted players
      for (const [name, entry] of this.recentSpotted) {
        if (Date.now() - entry.ts > RECENT_SPOTTED_TTL_MS) {
          this.recentSpotted.delete(name);
        } else if (!pollPlayerNames.has(name) && name !== (data.you?.name ?? "")) {
          pollPlayers.push({ name, x: entry.x, y: entry.y, room: entry.room, fromSpotted: true });
        }
      }
      const gameState: GameState = {
        phase: data.phase,
        you,
        your_tasks: this.getActiveTasks(),
        players: pollPlayers,
        corpses: data.corpses ?? data.nearby_corpses ?? [],
        emergency: data.emergency,
        task_progress: data.task_progress,
      };

      // Enrich emergency with coordinates from cached tasks
      if ((gameState.emergency as any)?.task_name) {
        const emergencyName = (gameState.emergency as any).task_name as string;
        const et = this.cachedTasks.find(t => t.name === emergencyName);
        if (et) {
          (gameState.emergency as any).name = et.name;
          (gameState.emergency as any).x = et.x;
          (gameState.emergency as any).y = et.y;
          (gameState.emergency as any).room = et.room;
        }
      }

      // Lazy-init behavior tree
      if (!this.tree) {
        this.tree = createTree(you.faction, you.role);
        this.log.status("init.tree_created", `Behavior tree: ${you.role} (${you.faction})`);
      }

      // Update blackboard
      if (!this.blackboard) {
        this.blackboard = createBlackboard(gameState, this.mapRooms);
      }
      this.blackboard.state = gameState;
      this.blackboard.pendingAction = null;
      this.blackboard.thinkingContent = null;
      this.blackboard.mapRooms = this.mapRooms;
      this.blackboard.memory = this.memory;
      this.blackboard.currentTick = tick;
      this.blackboard.allTaskLocations = this.allTaskLocations;

      // Tick behavior tree
      this.tree.tick(this.blackboard);

      // Attach thinking_content from blackboard to the pending action (if any)
      if (this.blackboard.pendingAction && this.blackboard.thinkingContent) {
        const now = Date.now();
        if (now - this.lastThinkingTs >= 10000) {
          (this.blackboard.pendingAction as any).thinking_content = this.blackboard.thinkingContent;
          this.lastThinkingTs = now;
        }
      }
      this.blackboard.thinkingContent = null;

      // Send decided action
      if (this.blackboard.pendingAction) {
        this.sendAction(this.blackboard.pendingAction);
        // After sending, wait debounce then re-poll to see new state
        this.scheduleDecision(POST_ACTION_DEBOUNCE_MS);
      } else {
        this.log.status("bt.idle", `tick=${tick} No action decided`);
        this.scheduleDecision(IDLE_POLL_INTERVAL_MS);
      }

      // Detect socializing state changes and emit log events for LLM speech generation
      const currentSocialTarget = this.memory.socializing?.targetPlayer ?? null;
      if (currentSocialTarget !== this.lastSocialTarget) {
        if (currentSocialTarget) {
          // Entered socializing state
          this.log.status("bt.social_start", JSON.stringify({
            target: currentSocialTarget,
            you: { name: you.name, role: you.role, faction: you.faction },
            task_progress: gameState.task_progress ?? null,
            alive_players: gameState.players.length + 1,
          }));
        } else {
          // Left socializing state
          this.log.status("bt.social_end", JSON.stringify({ target: this.lastSocialTarget }));
        }
        this.lastSocialTarget = currentSocialTarget;
      }
    } catch (err: any) {
      this.log.error(`bt.decide_error: ${err.message ?? err}`);
      this.scheduleDecision(IDLE_POLL_INTERVAL_MS);
    }
  }

  private sendAction(action: object) {
    if (this.ws.readyState !== WebSocket.OPEN) return;

    // Dedup: skip if same action sent within 10s
    const actionStr = JSON.stringify(action);
    if (actionStr === this.lastSentAction && Date.now() - this.lastSentTs < 10000) {
      // Same action repeated — likely stale state, request task refresh
      this.log.status("bt.action_dedup", `Skipped duplicate action: ${actionStr.substring(0, 100)}`);
      this.needsTaskRefresh = true;
      return;
    }

    const a = action as { action: string; task_name?: string };

    if (a.action === "task" && a.task_name) {
      this.lastAttemptedTask = a.task_name;
    }

    this.ws.send(JSON.stringify({ type: "action", data: action }));
    this.log.action(a.action, action);
    this.lastActionTs = Date.now();
    this.lastSentAction = actionStr;
    this.lastSentTs = Date.now();
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────

const { apiKey, logFile, baseUrl } = parseArgs();
new Bot(apiKey, logFile, baseUrl).start();
