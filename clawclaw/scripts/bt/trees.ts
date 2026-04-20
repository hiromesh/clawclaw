/**
 * bt/trees.ts — Assemble behavior trees for each faction/role.
 */

import {
  BtNode, Selector, Sequence,
  // Conditions
  HasEmergency, NearEmergency, NearCorpse, HasTasks, NearTask,
  CanKill, HasNearbyEnemy, HasVisiblePlayer, PlayerTooFar, IsRole,
  ShouldReport, IsSocializing, SocializationNotExpired, NotRecentlyEncountered, NotNearTask, NotSocializing,
  SafeToKill, NoPlayerSeenRecently, CanTriggerAlarm,
  HasPlayerNearCorpseAlone, TaskProgressNearGoal, HasIdlePlayerInRange,
  InRoomWithOwnTask, IsStalking, StalkingExpired, HasOneTimeKill,
  JustKilled, NotInSabotageRoom, OnKillCooldown, HasLoneEnemy, IsHunting, CrabShouldReport,
  SabotageCooldownReady,
  IsLoitering, LoiteringNotExpired, NoVisiblePlayer,
  // Actions
  MoveToEmergency, DoEmergencyTask, Report,
  MoveToNearestTask, DoNearestTask,
  KillNearbyEnemy, ChaseNearestPlayer, Skip, Wander, WanderNearCorpse, TriggerAlarm,
  StartSocialization, FollowSocialTarget,
  KillPlayerNearCorpse, KillIdlePlayer,
  StartStalking, FollowStalkTarget,
  FleeFromKillSite, StartHunting, FollowHuntTarget, KillHuntTarget,
  StartLoitering, ContinueLoitering, FleeFromCorpse, ClearLoitering,
  ParadiseFishSocialize, ParadiseFishSocNotExpired,
} from "./framework";

// ─── Shrimp Generic (普通虾) ─────────────────────────────────────────────────
//
// P0. Emergency task (highest)
// P1. Smart report (witness / suspect fleeing / 30% random)
// P2. Social (70% chance, walk together ~2s)
// P3. Do tasks (any room, as long as tasks remain)
// P4. Patrol (fallback when no tasks)

function createShrimpGenericTree(): BtNode {
  return new Selector([
    // P0: Emergency
    new Sequence([
      new HasEmergency(),
      new Selector([
        new Sequence([new NearEmergency(), new DoEmergencyTask()]),
        new MoveToEmergency(),
      ]),
    ]),
    // P1: Smart report
    new Sequence([new NearCorpse(), new ShouldReport(), new Report()]),
    // P2: Social (only when not near a task point to avoid drifting away)
    new Selector([
      new Sequence([new IsSocializing(), new SocializationNotExpired(), new FollowSocialTarget()]),
      new Sequence([new HasVisiblePlayer(), new NotNearTask(), new NotRecentlyEncountered(), new StartSocialization()]),
    ]),
    // P3: Do tasks (no progress restriction, cross-room)
    new Sequence([
      new NotSocializing(),
      new HasTasks(),
      new Selector([
        new Sequence([new NearTask(), new DoNearestTask()]),
        new MoveToNearestTask(),
      ]),
    ]),
    // P4: Patrol (no tasks left)
    new Wander(),
  ]);
}

// ─── Samurai Shrimp (武士虾) ─────────────────────────────────────────────────
//
// P0. Emergency task (highest)
// P1. Catch red-handed: corpse nearby + exactly 1 other player near corpse
//     → CanKill? kill that player : report
// P2. Report corpse (unconditional, fallback when P1 doesn't apply)
// P3. Kill idle player (seen 5+ times not near any task, in range, off cooldown)
// P4. Social (same as shrimp_generic)
// P5. High task progress (>=70%): prioritize doing tasks
// P6. Patrol (low progress: wander first, but do task if in same room)
// P7. Do tasks (fallback)

function createSamuraiShrimpTree(): BtNode {
  return new Selector([
    // P0: Emergency
    new Sequence([
      new HasEmergency(),
      new Selector([
        new Sequence([new NearEmergency(), new DoEmergencyTask()]),
        new MoveToEmergency(),
      ]),
    ]),
    // P1: Catch red-handed — corpse + exactly 1 player near it
    new Sequence([
      new NearCorpse(),
      new HasPlayerNearCorpseAlone(),
      new Selector([
        new Sequence([new CanKill(), new KillPlayerNearCorpse()]),
        new Report(),
      ]),
    ]),
    // P2: Report corpse (unconditional, no one suspicious nearby)
    new Sequence([new NearCorpse(), new Report()]),
    // P3: Stalk then kill idle player (seen 5+ times not near any task)
    new Selector([
      new Sequence([new IsStalking(), new StalkingExpired(), new CanKill(), new KillIdlePlayer()]),
      new Sequence([new IsStalking(), new FollowStalkTarget()]),
      new Sequence([new HasIdlePlayerInRange(), new StartStalking()]),
    ]),
    // P4: Social
    new Selector([
      new Sequence([new IsSocializing(), new SocializationNotExpired(), new FollowSocialTarget()]),
      new Sequence([new HasVisiblePlayer(), new NotNearTask(), new NotRecentlyEncountered(), new StartSocialization()]),
    ]),
    // P5: High progress (>=70%) → prioritize tasks over patrol
    new Sequence([
      new TaskProgressNearGoal(),
      new NotSocializing(),
      new HasTasks(),
      new Selector([
        new Sequence([new NearTask(), new DoNearestTask()]),
        new MoveToNearestTask(),
      ]),
    ]),
    // P6: Patrol (low progress), but do task first if current room has one
    new Selector([
      new Sequence([new InRoomWithOwnTask(), new NotSocializing(), new HasTasks(), new Selector([
        new Sequence([new NearTask(), new DoNearestTask()]),
        new MoveToNearestTask(),
      ])]),
      new Wander(),
    ]),
  ]);
}

// ─── Gun Shrimp (枪虾) ──────────────────────────────────────────────────────
//
// Two modes based on whether the one-time kill has been used:
//
// Skill available:
//   P0. Emergency
//   P1. Catch red-handed (corpse + 1 player near it → kill or report)
//   P2. Report corpse (unconditional)
//   P3. Social
//   P4. High progress (>=70%) → do tasks
//   P5. Patrol (wander first, do task if in same room)
//
// Skill used → same as shrimp_generic:
//   P0. Emergency
//   P2. Smart report (ShouldReport)
//   P3. Social
//   P6. Do tasks
//   P7. Patrol

function createGunShrimpTree(): BtNode {
  return new Selector([
    // P0: Emergency [shared]
    new Sequence([
      new HasEmergency(),
      new Selector([
        new Sequence([new NearEmergency(), new DoEmergencyTask()]),
        new MoveToEmergency(),
      ]),
    ]),
    // P1: Catch red-handed [skill available only]
    new Sequence([
      new HasOneTimeKill(),
      new NearCorpse(),
      new HasPlayerNearCorpseAlone(),
      new Selector([
        new Sequence([new CanKill(), new KillPlayerNearCorpse()]),
        new Report(),
      ]),
    ]),
    // P2: Report corpse
    new Selector([
      new Sequence([new HasOneTimeKill(), new NearCorpse(), new Report()]),         // skill available: unconditional
      new Sequence([new NearCorpse(), new ShouldReport(), new Report()]),           // skill used: smart report
    ]),
    // P3: Social [shared]
    new Selector([
      new Sequence([new IsSocializing(), new SocializationNotExpired(), new FollowSocialTarget()]),
      new Sequence([new HasVisiblePlayer(), new NotNearTask(), new NotRecentlyEncountered(), new StartSocialization()]),
    ]),
    // P4: High progress tasks [skill available only]
    new Sequence([
      new HasOneTimeKill(),
      new TaskProgressNearGoal(),
      new NotSocializing(),
      new HasTasks(),
      new Selector([
        new Sequence([new NearTask(), new DoNearestTask()]),
        new MoveToNearestTask(),
      ]),
    ]),
    // P5: Patrol + do task if in same room [skill available only]
    new Sequence([
      new HasOneTimeKill(),
      new Selector([
        new Sequence([new InRoomWithOwnTask(), new NotSocializing(), new HasTasks(), new Selector([
          new Sequence([new NearTask(), new DoNearestTask()]),
          new MoveToNearestTask(),
        ])]),
        new Wander(),
      ]),
    ]),
    // P6: High progress tasks [skill used / fallback]
    new Sequence([
      new TaskProgressNearGoal(),
      new NotSocializing(),
      new HasTasks(),
      new Selector([
        new Sequence([new NearTask(), new DoNearestTask()]),
        new MoveToNearestTask(),
      ]),
    ]),
    // P7: Patrol + do task if in same room [skill used / fallback]
    new Selector([
      new Sequence([new InRoomWithOwnTask(), new NotSocializing(), new HasTasks(), new Selector([
        new Sequence([new NearTask(), new DoNearestTask()]),
        new MoveToNearestTask(),
      ])]),
      new Wander(),
    ]),
  ]);
}

// ─── Crab (普通蟹) ──────────────────────────────────────────────────────────
//
// P1. Flee after kill (< 3 ticks since last kill → move to different room)
// P2. Safe kill (CanKill + SafeToKill → kill, same as before)
// P3. Delayed alarm (canTriggerAlarm + left sabotage room → trigger)
// P4. Hunt while on cooldown (CD中找落单敌人跟踪, CD好了+安全→杀, 否则继续跟)
// P5. Social camouflage (blend in with shrimps)
// P6. Do sabotage tasks
// P7. Camouflage report (40% chance report corpse to look innocent)
// P8. Patrol

function createCrabTree(): BtNode {
  return new Selector([
    // P1: Flee after kill — run to a different room
    new Sequence([new JustKilled(), new FleeFromKillSite()]),
    // P2: Safe kill (alone with 1 enemy, or chaos >=4)
    new Sequence([new CanKill(), new HasNearbyEnemy(), new SafeToKill(), new KillNearbyEnemy()]),
    // P3: Delayed alarm — only trigger after leaving sabotage room
    new Sequence([new CanTriggerAlarm(), new NotInSabotageRoom(), new TriggerAlarm()]),
    // P4: Hunt lone enemy when CD ready; social camouflage when on cooldown
    new Selector([
      // Hunting + CD ready + safe → kill
      new Sequence([new IsHunting(), new CanKill(), new SafeToKill(), new KillHuntTarget()]),
      // Hunting → keep following
      new Sequence([new IsHunting(), new FollowHuntTarget()]),
      // CD ready + lone enemy visible → start hunting
      new Sequence([new CanKill(), new HasLoneEnemy(), new StartHunting()]),
    ]),
    // P5: Social camouflage
    new Selector([
      new Sequence([new IsSocializing(), new SocializationNotExpired(), new FollowSocialTarget()]),
      new Sequence([new HasVisiblePlayer(), new NotRecentlyEncountered(), new StartSocialization()]),
    ]),
    // P6: Do sabotage tasks (only after cooldown, only if current room has one)
    new Sequence([
      new SabotageCooldownReady(),
      new InRoomWithOwnTask(),
      new HasTasks(),
      new Selector([
        new Sequence([new NearTask(), new DoNearestTask()]),
        new MoveToNearestTask(),
      ]),
    ]),
    // P7: Camouflage report (40% chance)
    new Sequence([new NearCorpse(), new CrabShouldReport(), new Report()]),
    // P8: Patrol
    new Wander(),
  ]);
}

// ─── Paradise Fish (天堂鱼) ──────────────────────────────────────────────────
//
// Goal: get voted out → win. Create suspicion by faking "caught at corpse then fleeing".
//
// P1. Loitering + witness appears → flee to nearby room (looks like fleeing a kill)
// P2. Loitering + no witness + not expired → keep wandering near corpse
// P3. Loitering + expired (8 ticks, no one came) → give up, patrol
// P4. Corpse found + no one around → start loitering near corpse
// P5. Corpse found + someone around → start tracking that person (be suspicious near corpse)
// P6. Socializing + not expired (8 ticks) → keep following target
// P7. Visible player + not recently encountered → 100% start tracking
// P8. Patrol (neighbor rooms, looking for corpses)

function createParadiseFishTree(): BtNode {
  return new Selector([
    // P0: Emergency task
    new Sequence([
      new HasEmergency(),
      new Selector([
        new Sequence([new NearEmergency(), new DoEmergencyTask()]),
        new MoveToEmergency(),
      ]),
    ]),
    // P1: Loitering + witness → flee
    new Sequence([new IsLoitering(), new HasVisiblePlayer(), new FleeFromCorpse()]),
    // P2: Loitering + no witness + not expired → keep loitering
    new Sequence([new IsLoitering(), new NoVisiblePlayer(), new LoiteringNotExpired(), new ContinueLoitering()]),
    // P3: Loitering + expired → clear and patrol
    new Sequence([new IsLoitering(), new ClearLoitering(), new Wander()]),
    // P4: Corpse + no one → start loitering
    new Sequence([new NearCorpse(), new NoVisiblePlayer(), new StartLoitering()]),
    // P5: Corpse + someone → track them (suspicious presence near corpse)
    new Sequence([new NearCorpse(), new HasVisiblePlayer(), new ParadiseFishSocialize()]),
    // P6: Socializing + not expired → keep following
    new Sequence([new IsSocializing(), new ParadiseFishSocNotExpired(), new FollowSocialTarget()]),
    // P7: See someone → 100% start tracking
    new Sequence([new HasVisiblePlayer(), new NotRecentlyEncountered(), new ParadiseFishSocialize()]),
    // P8: Patrol
    new Wander(),
  ]);
}

// ─── Octopus (章鱼) ──────────────────────────────────────────────────
//
// Goal: survive 60s once only 3 players remain (Octopus Time).
// Strategy mirrors Crab but without sabotage/alarm logic.
//
// P0. Emergency task (highest — assigned to all non-Crab roles)
// P1. Flee after kill (< 3 ticks since last kill)
// P2. Safe kill (CanKill + SafeToKill → kill)
// P3. Hunt while on cooldown (track lone target, kill when CD ready + safe)
// P4. Social camouflage (blend in to avoid suspicion)
// P5. Camouflage report (40% chance, look innocent)
// P6. Patrol

function createOctopusTree(): BtNode {
  return new Selector([
    // P0: Emergency task
    new Sequence([
      new HasEmergency(),
      new Selector([
        new Sequence([new NearEmergency(), new DoEmergencyTask()]),
        new MoveToEmergency(),
      ]),
    ]),
    // P1: Flee after kill
    new Sequence([new JustKilled(), new FleeFromKillSite()]),
    // P2: Safe kill
    new Sequence([new CanKill(), new HasNearbyEnemy(), new SafeToKill(), new KillNearbyEnemy()]),
    // P3: Hunt lone enemy when CD ready; social camouflage when on cooldown
    new Selector([
      new Sequence([new IsHunting(), new CanKill(), new SafeToKill(), new KillHuntTarget()]),
      new Sequence([new IsHunting(), new FollowHuntTarget()]),
      // CD ready + lone enemy visible → start hunting
      new Sequence([new CanKill(), new HasLoneEnemy(), new StartHunting()]),
    ]),
    // P4: Social camouflage
    new Selector([
      new Sequence([new IsSocializing(), new SocializationNotExpired(), new FollowSocialTarget()]),
      new Sequence([new HasVisiblePlayer(), new NotRecentlyEncountered(), new StartSocialization()]),
    ]),
    // P5: Camouflage report (40% chance)
    new Sequence([new NearCorpse(), new CrabShouldReport(), new Report()]),
    // P6: Patrol
    new Wander(),
  ]);
}

// ─── Neutral ─────────────────────────────────────────────────────────────────

function createNeutralTree(role: string): BtNode {
  if (role === "neutral_paradise_fish") return createParadiseFishTree();
  return createOctopusTree();
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createTree(faction: string, role: string): BtNode {
  if (faction === "lobster") {
    if (role === "shrimp_generic") return createShrimpGenericTree();
    if (role === "shrimp_warrior") return createSamuraiShrimpTree();
    if (role === "shrimp_pistol") return createGunShrimpTree();
    return createSamuraiShrimpTree(); // fallback
  }
  if (faction === "crab") return createCrabTree();
  return createNeutralTree(role);
}
