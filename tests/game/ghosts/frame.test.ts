/**
 * Ghost coordinate frames (src/game/ghosts/frame.ts) against the original's own data: every shipped team ghost starts on its
 * stage's road, facing along it, and passes its split gates at its split times (the ghost files are the exe's recording of a
 * real race, so this checks the world offset H, the handedness / quaternion conversion and the tick-0-is-GO timing at once).
 */
import { describe, expect, it } from 'vitest';
import type { CarTelemetry } from '../../../src/core/types';
import { parseGhost } from '../../../src/game/ghosts/format';
import { WORLD_XZ, lerpPose, newGhostPose, poseFromState, stageWorldHeight, stateFromTelemetry, wrapDeg } from '../../../src/game/ghosts/frame';
import { GhostPlayer } from '../../../src/game/ghosts/player';
import { teamFileStage } from '../../../src/game/ghosts/team';
import { buildGates } from '../../../src/game/timing';
import { buildStage } from '../../../src/world/stages';
import { PORTED_ORDER } from '../../../src/world/ports';
import { TEAM_DIR, exists, listDir, readBytes } from './nodefs';

/** Game.createTrack's H per stage (tools/assets/lib/stages.py `height`, read from every Start.con). */
const HEIGHTS: Record<string, number> = {};
for (const id of PORTED_ORDER) HEIGHTS[id] = 424;
for (const id of ['iceracing-1-f', 'iceracing-1-r']) HEIGHTS[id] = 24;
for (const id of PORTED_ORDER.filter((s) => s.startsWith('kenya'))) HEIGHTS[id] = 124;
for (const id of ['newzealand-1-f', 'newzealand-1-r']) HEIGHTS[id] = 100;
for (const id of ['newzealand-2-f', 'newzealand-2-r', 'newzealand-3-f', 'newzealand-3-r']) HEIGHTS[id] = 200;
for (const id of ['rallycross-1-f', 'rallycross-1-r']) HEIGHTS[id] = 10;

const TEAM_FILES: Record<string, string> = {
  KikiW_Corsica1f: 'corsica-1-f', PeterE_Corsica1r: 'corsica-1-r', PatrickS_Corsica2f: 'corsica-2-f', MarcoH_Corsica2r: 'corsica-2-r',
  VidarN_Corsica3f: 'corsica-3-f', MarcusK_Corsica3r: 'corsica-3-r', JukkaT_Corsica3r: 'corsica-3-r', JoakimS_Hillclimb1Af: 'hillclimb-1a-f',
  Marcusf_Hillclimb1Br: 'hillclimb-1b-r', JoakimW_Hillclimb1Cf: 'hillclimb-1c-f', ChristopherB_Hillclimb2Ar: 'hillclimb-2a-r',
  PeterW_Hillclimb2Cf: 'hillclimb-2c-f', AndersC_Hillclimb2Cr: 'hillclimb-2c-r', FredrikU_HillClimb3Af: 'hillclimb-3a-f',
  MichaelC_Hillclimb3Af: 'hillclimb-3a-f', GregM_Hillclimb3Bf: 'hillclimb-3b-f', MattiasA_Hillclimb3cf: 'hillclimb-3c-f',
  MansB_Hillclimb3Cf: 'hillclimb-3c-f', JoelH_Iceracing2f: 'iceracing-2-f', JeffP_Kenya1f: 'kenya-1-f', KoreyK_Kenya1r: 'kenya-1-r',
  Olofg_Kenya2r: 'kenya-2-r', KarlMagnusT_Kenya3f: 'kenya-3-f', CarlL_NewZealand1f: 'newzealand-1-f', StefanE_NewZealand1r: 'newzealand-1-r',
  NadabG_NewZealand2f: 'newzealand-2-f', RandyP_Rallycross1f: 'rallycross-1-f', Erikp_Rallycross1f: 'rallycross-1-f',
  JohanA_Rallycross3f: 'rallycross-3-f', TobiasA_Rallycross3r: 'rallycross-3-r',
};

describe('ghost frames: tables', () => {
  it('stageWorldHeight is Game.createTrack H for all 48 stages', () => {
    expect(PORTED_ORDER.length).toBe(48);
    for (const id of PORTED_ORDER) expect(stageWorldHeight(id), id).toBe(HEIGHTS[id]);
    expect(stageWorldHeight('testpad')).toBe(0);
  });

  it('teamFileStage maps the 30 shipped file names to their stages; 26 stages have a ghost, 22 have none', () => {
    expect(Object.keys(TEAM_FILES).length).toBe(30);
    for (const [f, s] of Object.entries(TEAM_FILES)) expect(teamFileStage(f), f).toBe(s);
    const have = new Set(Object.values(TEAM_FILES));
    expect(have.size).toBe(26);
    expect(PORTED_ORDER.filter((s) => !have.has(s)).length).toBe(22);
    for (const s of have) expect(PORTED_ORDER).toContain(s);
    expect(teamFileStage('nonsense')).toBeNull();
  });
});

describe('ghost frames: conversions', () => {
  const tel = (): CarTelemetry => {
    const wheels = [0, 1, 2, 3].map(() => ({ visual: { spinAngle: 0.5, steerAngle: 0 } }));
    // a yaw of 30 degrees about +y in the (left-handed, y-up) sim frame: R(q_sim) rotates the column vector (0,0,1) to the heading
    const a = (30 * Math.PI) / 180;
    return {
      posSim: { x: 34.5, y: 410.2, z: 647.5 },
      quatSim: { w: Math.cos(a / 2), x: 0, y: Math.sin(a / 2), z: 0 },
      steerAngle: 0.2,
      wheels,
    } as unknown as CarTelemetry;
  };

  it('state -> THREE pose: world offset, handedness, the conjugate quaternion, steer and spin units / signs', () => {
    const s = new Float32Array(9);
    stateFromTelemetry(tel(), 424, s);
    expect(s[0]).toBeCloseTo(34.5 + WORLD_XZ, 3);
    expect(s[1]).toBeCloseTo(410.2 + 424, 3);
    expect(s[2]).toBeCloseTo(647.5 + WORLD_XZ, 3);
    expect(s[4]).toBeLessThan(0); // q_file = conj(q_sim)
    expect(s[7]).toBeCloseTo((0.2 * 180) / Math.PI, 4);
    expect(s[8]).toBeCloseTo((-0.5 * 180) / Math.PI, 4); // the file's spin runs negative while the car rolls forward
    const p = newGhostPose();
    expect(poseFromState(s, 424, p)).toBe(true);
    expect(p.pos.x).toBeCloseTo(34.5, 3);
    expect(p.pos.y).toBeCloseTo(410.2, 3);
    expect(p.pos.z).toBeCloseTo(-647.5, 3);
    expect(p.steerAngle).toBeCloseTo(0.2, 5);
    expect(p.spinAngle).toBeCloseTo(0.5, 5);
    // the THREE quaternion equals the telemetry's own render quaternion (w, -x, -y, z of the sim quaternion)
    const t = tel();
    expect(p.quat.w).toBeCloseTo(t.quatSim.w, 6);
    expect(p.quat.x).toBeCloseTo(-t.quatSim.x, 6);
    expect(p.quat.y).toBeCloseTo(-t.quatSim.y, 6);
    expect(p.quat.z).toBeCloseTo(t.quatSim.z, 6);
  });

  it('a non-unit exe quaternion is normalised; non-finite states are refused', () => {
    const p = newGhostPose();
    expect(poseFromState([0, 0, 0, 0, 0.5, 0, 0.5, 0, 0], 0, p)).toBe(true);
    expect(Math.hypot(p.quat.w, p.quat.x, p.quat.y, p.quat.z)).toBeCloseTo(1, 12);
    expect(poseFromState([0, 0, 0, 0, 0, 0, 0, 0, 0], 0, p)).toBe(false);
    expect(poseFromState([NaN, 0, 0, 0, 0, 0, 1, 0, 0], 0, p)).toBe(false);
  });

  it('wrapDeg and lerpPose (shorter arc, spin through +-180)', () => {
    expect(wrapDeg(190)).toBeCloseTo(-170, 9);
    expect(wrapDeg(-540)).toBeCloseTo(-180, 9);
    const a = newGhostPose();
    const b = newGhostPose();
    b.pos.x = 10;
    b.quat = { w: -1, x: 0, y: 0, z: 0 }; // the same orientation as identity, opposite sign
    a.spinAngle = 3.1;
    b.spinAngle = -3.1;
    const o = newGhostPose();
    lerpPose(a, b, 0.5, o);
    expect(o.pos.x).toBe(5);
    expect(Math.abs(o.quat.w)).toBeCloseTo(1, 9);
    expect(Math.abs(Math.abs(o.spinAngle) - Math.PI)).toBeLessThan(0.05);
  });
});

const haveTeam = exists(TEAM_DIR);
const stages = new Map<string, ReturnType<typeof buildStage>>();
const stageOf = (id: string) => stages.get(id) ?? (stages.set(id, buildStage(id, 1)), stages.get(id)!);

describe.skipIf(!haveTeam)('ghost frames: every shipped team ghost against its stage (needs .cache/original)', () => {
  const names = haveTeam ? listDir(TEAM_DIR) : [];
  // hillclimb-1c-f: the ghost starts 79 m behind the port's grid, before the start of the centre spline: its splits are
  // consistent with the gates only up to that constant, which the projection clamps at s = 0
  const NO_SPLIT_CHECK = new Set(['JoakimW_Hillclimb1Cf']);

  it('the 30 files map to stages and every one starts on the road, facing along it', () => {
    expect(names.length).toBe(30);
    let worstLat = 0;
    let worstDot = 1;
    for (const name of names) {
      const id = teamFileStage(name)!;
      expect(id, name).toBeTruthy();
      const g = parseGhost(readBytes(`${TEAM_DIR}/${name}`));
      const { stage } = stageOf(id);
      const p = new GhostPlayer(g);
      const out = new Float32Array(9);
      p.step(out);
      const pose = newGhostPose();
      expect(poseFromState(out, stageWorldHeight(id), pose)).toBe(true);
      const pr = stage.project(pose.pos);
      const q = pose.quat;
      const fx = -2 * (q.x * q.z + q.w * q.y); // THREE forward = local -z rotated
      const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      const tg = stage.tangentAt(pr.s);
      const dot = (fx * tg.x + fz * tg.z) / Math.hypot(fx, fz) / Math.hypot(tg.x, tg.z);
      worstDot = Math.min(worstDot, dot);
      if (name !== 'JoakimW_Hillclimb1Cf') worstLat = Math.max(worstLat, Math.abs(pr.lateral));
      expect(dot, `${name} heading along the road`).toBeGreaterThan(0.97);
    }
    // the closed circuits start on the grid beside the line (up to ~10 m off the centre line at rallycross-1)
    expect(worstLat).toBeLessThan(11);
    expect(worstDot).toBeGreaterThan(0.97);
  });

  it('point-to-point ghosts pass their split gates at their split times (|residual| < 1.2 m after the grid offset)', () => {
    let worst = 0;
    let worstAt = '';
    let n = 0;
    for (const name of names) {
      const id = teamFileStage(name)!;
      const { stage } = stageOf(id);
      if (stage.closed || NO_SPLIT_CHECK.has(name)) continue;
      const g = parseGhost(readBytes(`${TEAM_DIR}/${name}`));
      const H = stageWorldHeight(id);
      const gates = buildGates(stage);
      expect(gates.length, name).toBe(g.splits.length);
      const p = new GhostPlayer(g);
      const out = new Float32Array(9);
      const pose = newGhostPose();
      p.step(out);
      poseFromState(out, H, pose);
      const spawn = stage.project(pose.pos);
      const portSpawn = stage.project(stage.startPose.pos);
      const gridOffset = spawn.s - portSpawn.s; // the original's player slot vs the port's spawn (see docs/orig/ghosts.md)
      const ticks = g.splits.map((s) => Math.round(s * 120));
      p.rewind();
      let si = 0;
      for (let t = 0; si < ticks.length; t++) {
        if (!p.step(out)) break;
        if (t !== ticks[si]) continue;
        poseFromState(out, H, pose);
        const pj = stage.project(pose.pos, stage.startS + gates[si].dist + gridOffset); // local search around the expected s
        const residual = pj.s - stage.startS - gates[si].dist - gridOffset;
        if (Math.abs(residual) > worst) {
          worst = Math.abs(residual);
          worstAt = `${name} split ${si}`;
        }
        n++;
        si++;
      }
      // the last split is the finish = the ghost's own end, where its last recorded period is cut off (7/8 freeze)
      expect(si, `${name}: all splits before the finish reached`).toBeGreaterThanOrEqual(g.splits.length - 1);
    }
    expect(n).toBeGreaterThan(100);
    expect(worst, worstAt).toBeLessThan(1.2);
  });
});
