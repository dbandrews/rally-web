/**
 * src/game/ghosts/session.ts — GHOSTS BUILDER. The ghost manager of a race (the original's FUN_004a7390 ghost part): one
 * recorder (the run being driven), one playback slot (the ghost being raced), the session best (slot 0x278, FUN_004db290)
 * and the saved/shipped ghosts that can fill the playback slot. RaceController's ghost region is a thin shell around it.
 *
 * Per race: begin() picks the playback ghost (best run / team / saved / none), start() is GO, tick() is called once per
 * 120 Hz physics step while the race runs (record the player's state, advance the ghost), finishRun() decides the session
 * best. Everything is driven by the step count from GO, never by wall time.
 *
 * Playback ghost sources:
 *   best : the stored best run of (stage, seed, car) in localStorage (BestTimes), written when a run beats it
 *   team : a shipped team ghost (global/ghosts/<file>.bin), raced with the FILE's car
 *   user : a ghost the player saved with SAVE GHOST (IndexedDB), raced with the FILE's car
 * A team/user ghost that is not loaded when the race begins (prepare() was not awaited) attaches when it arrives and
 * catches up to the current tick, so the race never waits for it.
 */
import { ARCHETYPES, isOrigCarId } from '../../core/constants';
import type { GhostSelection } from '../../core/ghosts';
import type { ArchetypeId, CarRenderState, CarTelemetry, GhostInfo, WheelTelemetry } from '../../core/types';
import { origCarArchetype } from '../../sim/presets';
import type { BestTimes } from '../bestTimes';
import { checkGhostName } from './names';
import { ghostCarOf, ghostTotalTime, type GhostFile } from './format';
import { copyPose, lerpPose, newGhostPose, poseFromState, stateFromTelemetry, stageWorldHeight, type GhostPose } from './frame';
import { GhostPlayer } from './player';
import { GhostRecorder15 } from './recorder';
import { cachedTeamGhost, loadTeamGhost, teamFileOfId, teamGhostId, teamGhostsOf } from './team';
import { UserGhostStore } from './store';
import type { GhostListEntry } from '../../core/ghosts';

export interface GhostRunInfo {
  stageId: string;
  seed: number;
  /** Best-time / ghost key: the original car, else the archetype id. */
  carKey: string;
  origCar?: string;
  archetype: ArchetypeId;
}

/** The car a ghost file is drawn with: its `<Car>Ghost` template minus "Ghost" (an original car, else an archetype id). */
export function ghostCarLook(file: GhostFile): { origCar?: string; archetype: ArchetypeId } {
  const car = ghostCarOf(file.carTemplate);
  if (isOrigCarId(car)) return { origCar: car, archetype: origCarArchetype(car) ?? 'awd_wrc' };
  if (car in ARCHETYPES) return { archetype: car as ArchetypeId };
  return { archetype: 'awd_wrc' };
}

const DEFAULT_NAME = 'Ghost'; // locale 862

interface Playing {
  source: 'best' | 'team' | 'user';
  id: string;
  name: string;
  file: GhostFile;
  player: GhostPlayer;
  look: { origCar?: string; archetype: ArchetypeId };
}

export class GhostSession {
  readonly users: UserGhostStore;
  private readonly best: BestTimes;
  private readonly enabled: boolean;
  private run: GhostRunInfo | null = null;
  private height = 0;
  private sel: GhostSelection = { source: 'best' };
  private readonly recorder = new GhostRecorder15();
  private readonly cur = new Float32Array(9);
  private readonly out = new Float32Array(9);
  private playing: Playing | null = null;
  /** Step count of this race (tick() calls since start()). */
  private ticks = 0;
  private running = false;
  private runToken = 0;
  private readonly pa = newGhostPose();
  private readonly pb = newGhostPose();
  private readonly pr = newGhostPose();
  private havePose = false;
  /** Saved ghosts loaded by prepare() (id -> file), so begin() can attach them synchronously. */
  private readonly userCache = new Map<string, GhostFile>();
  /** The session best (FUN_004db290 slot 0x278): the fastest valid finished run of this stage + car. */
  private sessionBest: { key: string; stageId: string; car: string; file: GhostFile; time: number } | null = null;
  private rs: CarRenderState | null = null;

  constructor(opts: { enabled: boolean; best: BestTimes; users: UserGhostStore }) {
    this.enabled = opts.enabled;
    this.best = opts.best;
    this.users = opts.users;
  }

  // ------------------------------------------------------------------------------------------------- lifecycle

  /** Pick the playback ghost for a new race (synchronous; a ghost still loading attaches later). */
  begin(run: GhostRunInfo, sel: GhostSelection | undefined): void {
    this.run = run;
    this.height = stageWorldHeight(run.stageId);
    this.sel = sel ?? { source: 'best' };
    this.runToken++;
    this.recorder.stop();
    this.playing = null;
    this.ticks = 0;
    this.running = false;
    this.havePose = false;
    this.rs = null;
    if (!this.enabled || this.sel.source === 'off') return;
    const token = this.runToken;
    if (this.sel.source === 'best') {
      const f = this.best.loadGhost(run.stageId, run.seed, run.carKey);
      if (f) this.attach({ source: 'best', id: 'best', name: DEFAULT_NAME, file: f }, token);
    } else if (this.sel.source === 'team') {
      const file = teamFileOfId(this.sel.id);
      if (!file) return;
      const f = cachedTeamGhost(file);
      if (f) this.attach({ source: 'team', id: this.sel.id, name: f.ghostName, file: f }, token);
      else void loadTeamGhost(file).then((g) => g && this.attach({ source: 'team', id: (this.sel as { id: string }).id, name: g.ghostName, file: g }, token));
    } else {
      const id = this.sel.id;
      const f = this.userCache.get(id);
      if (f) this.attach({ source: 'user', id, name: f.ghostName, file: f }, token);
      else void this.users.load(id).then((g) => g && this.attach({ source: 'user', id, name: g.ghostName, file: g }, token));
    }
  }

  /** Load the selected team / saved ghost ahead of begin() (so the race starts with it in place). Never rejects. */
  async prepare(sel: GhostSelection | undefined): Promise<void> {
    if (!this.enabled || !sel) return;
    try {
      if (sel.source === 'team') {
        const file = teamFileOfId(sel.id);
        if (file) await loadTeamGhost(file);
      } else if (sel.source === 'user') {
        const f = await this.users.load(sel.id);
        if (f) this.userCache.set(sel.id, f);
      }
    } catch {
      /* the race starts without it */
    }
  }

  private attach(p: Omit<Playing, 'player' | 'look'>, token: number): void {
    if (token !== this.runToken || p.file.frameCount < 2) return;
    const player = new GhostPlayer(p.file);
    const look = p.source === 'best' && this.run ? { origCar: this.run.origCar, archetype: this.run.archetype } : ghostCarLook(p.file);
    this.playing = { ...p, player, look };
    this.havePose = false;
    this.rs = null;
    if (this.running && this.ticks > 0) this.catchUp();
  }

  /** A ghost that arrived after GO: run it to the current tick. */
  private catchUp(): void {
    const p = this.playing;
    if (!p) return;
    p.player.rewind();
    this.havePose = false;
    for (let i = 0; i < this.ticks; i++) this.advance(p);
  }

  /** One playback step: keep the previous and the current pose (render interpolation between them). */
  private advance(p: Playing): void {
    if (p.player.step(this.out)) {
      if (this.havePose) copyPose(this.pb, this.pa);
      if (poseFromState(this.out, this.height, this.pb)) {
        if (!this.havePose) copyPose(this.pb, this.pa);
        this.havePose = true;
      }
    } else if (this.havePose) copyPose(this.pb, this.pa); // frozen at the last pose
  }

  /** GO: the recorder and the playback start from tick 0. */
  start(): void {
    this.ticks = 0;
    this.running = true;
    this.havePose = false;
    if (this.enabled) this.recorder.start();
    this.playing?.player.rewind();
  }

  /** One physics step of the running race (after the player's car stepped). */
  tick(tel: Readonly<CarTelemetry>): void {
    if (!this.running) return;
    this.ticks++;
    if (this.recorder.recording) {
      stateFromTelemetry(tel, this.height, this.cur);
      this.recorder.sample(this.cur);
    }
    const p = this.playing;
    if (p) this.advance(p);
  }

  /** The player's run ended (finish) or the race was left: stop recording. */
  stopRecording(): void {
    this.recorder.stop();
    this.running = false;
  }

  /**
   * A run finished. `valid` = no debug teleport. Keeps the faster of this and the session best (slot 0x278, FUN_004db290);
   * `storeAsBest` additionally writes the run as the stored best-run ghost (it beat the stored best time).
   */
  finishRun(info: { time: number; splits: readonly number[]; valid: boolean; storeAsBest: boolean }): void {
    const run = this.run;
    this.recorder.stop();
    if (!run || !this.enabled || !info.valid) return;
    const splits = info.splits.filter((s) => Number.isFinite(s));
    if (!splits.length || splits[splits.length - 1] !== info.time) splits.push(info.time);
    const file = this.recorder.toFile({ car: run.carKey, name: DEFAULT_NAME, splits });
    if (file.frameCount < 2) return;
    const key = `${run.stageId}:${run.seed}:${run.carKey}`;
    const sb = this.sessionBest;
    if (!sb || sb.key !== key || Math.fround(info.time) < sb.time) {
      this.sessionBest = { key, stageId: run.stageId, car: run.carKey, file, time: ghostTotalTime(file) };
    }
    if (info.storeAsBest) {
      try {
        this.best.saveGhost(run.stageId, run.seed, run.carKey, file);
      } catch {
        /* storage full: keep the time, skip the ghost */
      }
    }
  }

  // ------------------------------------------------------------------------------------------------- queries

  get hasPlayback(): boolean {
    return this.playing !== null;
  }

  /** The playback ghost's pose at the render alpha (THREE space), or null before it has one. Reused object. */
  pose(alpha: number): GhostPose | null {
    if (!this.playing || !this.havePose) return null;
    lerpPose(this.pa, this.pb, Math.min(1, Math.max(0, alpha)), this.pr);
    return this.pr;
  }

  info(): GhostInfo[] {
    const p = this.playing;
    if (!p || !this.havePose) return [];
    return [
      {
        id: 'ghost',
        source: p.source,
        name: p.name,
        origCar: p.look.origCar ?? null,
        time: ghostTotalTime(p.file),
        frames: p.file.frameCount,
        tick: this.ticks,
        finished: p.player.finished,
        pos: { x: this.pb.pos.x, y: this.pb.pos.y, z: this.pb.pos.z },
      },
    ];
  }

  /** The ghost's CarRenderState for this frame (id 'ghost'), reusing one object; null before it has a pose. */
  renderState(playerTel: Readonly<CarTelemetry>, alpha: number): CarRenderState | null {
    const p = this.playing;
    const g = this.pose(alpha);
    if (!p || !g) return null;
    if (!this.rs) {
      const tel = structuredClone(playerTel) as CarTelemetry;
      tel.id = 'ghost';
      this.rs = {
        id: 'ghost',
        archetype: p.look.archetype,
        ...(p.look.origCar ? { origCar: p.look.origCar } : {}),
        ghost: true,
        player: false,
        pos: { x: 0, y: 0, z: 0 },
        quat: { w: 1, x: 0, y: 0, z: 0 },
        telemetry: tel,
        justReset: true,
      };
    } else this.rs.justReset = false;
    const rs = this.rs;
    const tel = rs.telemetry as CarTelemetry;
    rs.pos.x = tel.pos.x = g.pos.x;
    rs.pos.y = tel.pos.y = g.pos.y;
    rs.pos.z = tel.pos.z = g.pos.z;
    rs.quat.w = tel.quat.w = g.quat.w;
    rs.quat.x = tel.quat.x = g.quat.x;
    rs.quat.y = tel.quat.y = g.quat.y;
    rs.quat.z = tel.quat.z = g.quat.z;
    tel.steerAngle = g.steerAngle;
    tel.tyreType = playerTel.tyreType;
    for (let i = 0; i < 4; i++) {
      const w = tel.wheels[i] as WheelTelemetry;
      const src = playerTel.wheels[i];
      w.contact = false;
      w.surface = null;
      w.mode = 1;
      w.visual.centreLocal.x = src.visual.centreLocal.x;
      w.visual.centreLocal.y = src.visual.centreLocal.y;
      w.visual.centreLocal.z = src.visual.centreLocal.z;
      // FUN_0049bb90: the front wheels carry the steer, all four the recorded spin of wheel 0
      w.visual.steerAngle = i < 2 ? g.steerAngle : 0;
      w.visual.spinAngle = g.spinAngle;
      w.visual.suspensionOffset = 0;
    }
    return rs;
  }

  // ------------------------------------------------------------------------------------------------- SAVE GHOST

  /** A finished valid run of this session exists for the loaded stage + car (the session best). */
  canSave(): boolean {
    const r = this.run;
    const sb = this.sessionBest;
    return !!(this.enabled && r && sb && sb.key === `${r.stageId}:${r.seed}:${r.carKey}`);
  }

  /** Save the session best under `name` (SAVE GHOST). False: no run to save, invalid name, or storage refused. */
  async saveSessionBest(name: string): Promise<boolean> {
    const sb = this.sessionBest;
    const chk = checkGhostName(name);
    if (!this.canSave() || !sb || !chk.ok) return false;
    const res = await this.users.save(sb.stageId, { ...sb.file, ghostName: chk.name }, chk.name);
    return res.ok;
  }

  /** The stage's selectable ghosts: shipped team ghosts (fastest first) then the saved ones (newest first). */
  async list(stageId: string): Promise<GhostListEntry[]> {
    const out: GhostListEntry[] = [];
    try {
      for (const t of await teamGhostsOf(stageId)) {
        out.push({ id: teamGhostId(t.file), source: 'team', name: t.driver, origCar: t.car, stageId, time: t.time, date: null, deletable: false });
      }
    } catch {
      /* no index */
    }
    try {
      for (const r of await this.users.list(stageId)) {
        out.push({ id: r.id, source: 'user', name: r.name, origCar: r.car, stageId, time: r.time, date: r.date, deletable: true });
      }
    } catch {
      /* storage unavailable */
    }
    return out;
  }

  async deleteUser(id: string): Promise<void> {
    if (!id.startsWith('user:')) return;
    this.userCache.delete(id);
    await this.users.delete(id);
  }
}
