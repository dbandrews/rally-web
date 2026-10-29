/**
 * src/debug/testApi.ts — ARCHITECT-OWNED. Builders must not edit (contract: RallyTestApi in core/types.ts).
 *
 * Installs window.__rally, the headless test / agent API used by tools/smoke.mjs, tools/drive.mjs and
 * Playwright-driven playtests. Every getter returns a JSON-safe clone.
 *
 * Input precedence per substep (main.ts):
 *   setControls override  >  (race not controllable → parked controls)  >  autopilot  >  filter(raw)
 *   raw = setRawInput override if set, else the real devices (keyboard / gamepad).
 */
import { API_VERSION, neutralControls, neutralRawInput } from '../core/constants';
import type {
  CameraMode,
  CarTelemetry,
  Controls,
  FrameStats,
  GameTunables,
  LoadStageOptions,
  ProbeInfo,
  RaceState,
  RallyTestApi,
  RawInput,
  StageInfo,
  StageListEntry,
} from '../core/types';

/** What main.ts's App exposes to the test API (architect-internal). */
export interface TestApiHost {
  telemetry(): Readonly<CarTelemetry>;
  raceState(): Readonly<RaceState>;
  stageInfo(): StageInfo;
  listStages(): StageListEntry[];
  setRawOverride(raw: RawInput | null): void;
  setControlsOverride(c: Controls | null): void;
  setLoopPaused(paused: boolean): void;
  /** Run n substeps now (full per-substep pipeline) and render one frame. */
  stepNow(n: number): void;
  apiReset(): void;
  teleport(s: number, lateral: number): void;
  loadStage(id: string, opts: LoadStageOptions): Promise<void>;
  setParam(path: string, value: unknown): void;
  getTunables(): GameTunables;
  setAutopilot(on: boolean): void;
  setCamera(mode: number | CameraMode): void;
  startRaceNow(): void;
  frameStats(): FrameStats;
  probe(): ProbeInfo;
}

declare global {
  interface Window {
    __rally?: RallyTestApi;
  }
}

const clone = <T>(v: T): T => structuredClone(v);

export function installTestApi(host: TestApiHost): RallyTestApi {
  const api: RallyTestApi = {
    ready: false,
    version: API_VERSION,
    getTelemetry: () => clone(host.telemetry() as CarTelemetry),
    getRaceState: () => clone(host.raceState() as RaceState),
    getStageInfo: () => clone(host.stageInfo()),
    listStages: () => clone(host.listStages()),
    setRawInput(partial) {
      host.setRawOverride(partial ? { ...neutralRawInput(), ...partial } : null);
    },
    setControls(partial) {
      host.setControlsOverride(partial ? { ...neutralControls(), ...partial } : null);
    },
    pause(paused) {
      host.setLoopPaused(!!paused);
    },
    step(n) {
      host.stepNow(Math.max(0, Math.floor(n)));
      return clone(host.telemetry() as CarTelemetry);
    },
    reset() {
      host.apiReset();
    },
    teleport(s, lateral = 0) {
      host.teleport(s, lateral);
    },
    async loadStage(id, opts = {}) {
      await host.loadStage(id, opts);
      return clone(host.stageInfo());
    },
    setParam(path, value) {
      host.setParam(path, value);
    },
    getParams: () => clone(host.getTunables()),
    setAutopilot(on) {
      host.setAutopilot(!!on);
    },
    setCamera(mode) {
      host.setCamera(mode);
    },
    startRace() {
      host.startRaceNow();
    },
    getFrameStats: () => clone(host.frameStats()),
    probe: () => clone(host.probe()),
  };
  window.__rally = api;
  return api;
}
