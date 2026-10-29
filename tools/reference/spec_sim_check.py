#!/usr/bin/env python3
"""Standalone numerical check of docs/MECHANICS_SPEC.md.

Implements the spec's section 2 equations literally (sim space = original frame: x right, y up, z fwd),
awd_wrc archetype, on an infinite plane (optionally tilted), with ray suspension, and runs the section 7
feel tests plus stability / low-speed jitter probes at DT = 1/120 and 2*DT.

Run:  python3 -I spec_sim_check.py [quick]
No external dependencies.  Chassis collision (2.9), flip assist, damage, input filter are not modelled
(flat-ground tests never touch them).
"""
import math, random, sys

# ----------------------------------------------------------------------------- constants from the spec
GRAVITY = 12.0
DEEP = {0, 9, 11, 12, 18, 19, 22}
TORQUE_CURVE = [
  0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,0.1953,
  0.1953,0.1953,0.1953,0.1953,0.2026,0.2054,0.2065,0.2063,0.2055,0.2046,0.2041,0.2047,0.2067,0.2109,0.2178,0.2279,
  0.2418,0.2599,0.2821,0.3079,0.3369,0.3687,0.4029,0.4390,0.4767,0.5156,0.5552,0.5952,0.6350,0.6766,0.7366,0.8039,
  0.8602,0.8912,0.9135,0.9318,0.9467,0.9584,0.9675,0.9745,0.9798,0.9838,0.9872,0.9904,0.9930,0.9954,0.9975,0.9992,
  1.0005,1.0016,1.0023,1.0027,1.0028,1.0026,1.0020,1.0011,0.9999,0.9985,0.9966,0.9946,0.9922,0.9896,0.9866,0.9836,
  0.9806,0.9776,0.9745,0.9714,0.9681,0.9647,0.9611,0.9573,0.9534,0.9491,0.9445,0.9396,0.9343,0.9287,0.9226,0.9161,
  0.9091,0.9016,0.8935,0.8848,0.8755,0.8656,0.8550,0.8438,0.8317,0.8187,0.8047,0.7898,0.7737,0.7564,0.7379,0.7180,
  0.6967,0.6738,0.6495,0.6235,0.5958,0.5663,0.5350,0.5017,0.4502,0.3759,0.2908,0.2073]
LOAD_TABLE = [
  [0.4033,0.3049,1.0262,1.0707],[0.4095,0.3094,1.0266,1.0719],[0.4158,0.3140,1.0270,1.0731],[0.4223,0.3188,1.0275,1.0744],
  [0.4291,0.3238,1.0280,1.0757],[0.4361,0.3289,1.0285,1.0771],[0.4433,0.3342,1.0290,1.0785],[0.4508,0.3397,1.0295,1.0799],
  [0.4586,0.3454,1.0300,1.0815],[0.4667,0.3513,1.0306,1.0831],[0.4752,0.3574,1.0312,1.0847],[0.4839,0.3638,1.0318,1.0865],
  [0.4930,0.3704,1.0324,1.0883],[0.5025,0.3773,1.0331,1.0902],[0.5124,0.3845,1.0338,1.0922],[0.5228,0.3920,1.0345,1.0943],
  [0.5336,0.3999,1.0353,1.0965],[0.5449,0.4081,1.0361,1.0988],[0.5568,0.4167,1.0370,1.1013],[0.5692,0.4257,1.0378,1.1039]]
# [BodyK, BodyKScale, MaxDepth, Epsilon, FrictionLevel, Bump, BumpFlag]
SURFACE_TABLE = {
  0: [0.85, 0.25, 0.02, 0.35, 0.0, 0.035, 1], 1: [0.9, 0.9, 0.0, 1.0, -1.0, 0.0, 0], 2: [0.92, 0.8, 0.005, 0.5, 0.0, 0.025, 0],
  3: [0.9, 0.9, 0.0, 1.0, 1.0, 0.0, 0], 7: [0.72, 0.5, 0.02, 0.3, 0.25, 0.005, 0], 12: [1.0, 0.25, 0.04, 0.4, 0.0, 0.02, 1],
  20: [0.7, 0.9, 0.0, 0.5, 2.0, 0.01, 0]}
# [BestStatic, DiffStatic, ScaleKinetic, BestRollK, DiffRollK] per tyre type 0..4
TYRE_TABLE = {
  0: [[0.808,-0.137,0.8,1.204,1.006],[1.203,-0.205,0.8,1.204,1.006],[1.502,-0.255,0.8,1.204,1.006],[1.35,-0.23,0.8,1.204,1.006],[1.449,-0.246,0.8,1.204,1.006]],
  1: [[2.151,-0.366,0.856,1.0,1.0],[2.025,-0.344,0.84,1.0,1.0],[1.9,-0.323,0.8,1.0,1.0],[1.7,-0.289,0.8,1.0,1.0],[1.6,-0.272,0.8,1.0,1.0]],
  2: [[1.55,-0.264,0.8,1.1,1.1],[1.71,-0.282,0.8,1.1,1.1],[1.775,-0.302,0.8,1.1,1.1],[1.35,-0.23,0.8,1.1,1.1],[1.305,-0.222,0.8,1.1,1.1]],
  3: [[2.151,-0.366,0.856,1.0,1.0],[2.025,-0.344,0.84,1.0,1.0],[1.9,-0.323,0.8,1.0,1.0],[1.7,-0.289,0.8,1.0,1.0],[1.6,-0.272,0.8,1.0,1.0]],
  7: [[0.35,-0.06,0.8,1.2,1.2],[0.45,-0.076,0.8,1.2,1.2],[0.45,-0.076,0.8,1.2,1.2],[1.35,-0.23,0.8,1.2,1.2],[1.45,-0.247,0.8,1.2,1.2]],
  12: [[1.55,-0.264,0.8,5.01,1.3]] * 5,
  20: [[0.5,-0.289,0.8,1.1,1.1],[0.75,-0.289,0.8,1.1,1.1],[1.0,-0.289,0.8,1.1,1.1],[1.6,-0.289,0.8,1.1,1.1],[1.7,-0.289,0.8,1.1,1.1]]}

def mu_static(surf, tt):
    bs, ds = TYRE_TABLE[surf][tt][0], TYRE_TABLE[surf][tt][1]
    return bs + ds * 0.7 * SURFACE_TABLE[surf][4]
def mu_kinetic(surf, tt):
    return mu_static(surf, tt) * TYRE_TABLE[surf][tt][2]

# ----------------------------------------------------------------------------- vector helpers
def add(a, b): return (a[0]+b[0], a[1]+b[1], a[2]+b[2])
def sub(a, b): return (a[0]-b[0], a[1]-b[1], a[2]-b[2])
def scale(a, k): return (a[0]*k, a[1]*k, a[2]*k)
def dot(a, b): return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]
def cross(a, b): return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
def vlen(a): return math.sqrt(dot(a, a))
def normalize(a):
    l = vlen(a); return (a[0]/l, a[1]/l, a[2]/l) if l > 0 else a
def clamp(x, a, b): return min(b, max(a, x))
def sgn(x): return 1 if x > 0 else (-1 if x < 0 else 0)
def toward_zero(v, d): return max(0.0, v - d) if v > 0 else min(0.0, v + d)

# ----------------------------------------------------------------------------- parameters (spec section 3, awd_wrc)
def awd_wrc_params():
    front = dict(springK=35000, dampK=5000, springLength=0.75, rollStiffness=14200, rollK=1.00596, wheelInertia=0.050027,
                 momentXDist=0.060145, momentZDist=0.080006, twStaSteer=2.2428, twKinSteer=1.7045, twStaMy=0.418,
                 staticSlipAngleFast=0.12, staticSlipAngleSlow=0.08, steerTweak=0.05, tireRelaxK=1.60723,
                 alignMomScale=0.126552, latPosK=5.00238, latNegK=0.053606, longPosK=5.39649, longNegK=0.176533)
    rear = dict(front, rollStiffness=15000, staticSlipAngleFast=0.06, staticSlipAngleSlow=0.10)
    return dict(
        mass=1230.0, inertia=(1.25, 1.45, 0.50), torqueScale=935.0, wheelDrive=2, turboSize=1.0, nGears=6,
        gearRatio=[-3.3, 3.35, 2.15, 1.55, 1.22, 0.97, 0.84],
        wheelFL=(-0.755, 0.53, 1.21), wheelRL=(-0.760, 0.53, -1.32),
        airKZY=1.25, airKZZ=2.0, wheelRadius=0.30, finalDrive=5.6, wheelScale=0.40, torqueScaleFactor=1.0,
        minRpm=1000.0, cutRpm=8250.0, maxRpm=8750.0, maxTorqueRpm=6500.0, maxTurboTorqueRpm=6750.0,
        minRpmGearChange=4000.0, turboIdle=0.1, turboWasteGate=100.0, turboSpinup=1.0, brakeTorque=4000.0,
        brakeBalance=1.25, brakeMinLimit=0.1, handBrakeTorque=3500.0, useAbs=True, absFactor=0.75,
        useAntiSpin=False, antiSpinFactor=8.0, timeChangeGear=0.10, timeChangeGearFR=0.15, downGearFactor=0.775,
        throttleMinLimit=0.1, useEngineBrakeConstant=True, engineBrakeConstant=4000.0, useSpinTorque=True,
        spinTorqueScaleValue=10.0, useSpinTorqueDamping=False, spinTorqueDampingValue=1.0,
        useBodyFrictionDamping=True, wheelContactFactor=0.003125, bodyContactFactor=0.05, useSideFriction=True,
        sideFrictionFactor=1.4, twMaxMom=5.7039, twMomLimStart=1.1242, twMomLimScale=1.5147, rollLevel=0,
        transmission='auto', useGearSpeedValues=False, hullBottomY=-0.33, bodyGroundShare=0.0,
        wheels=[front, front, rear, rear])

# ----------------------------------------------------------------------------- car
class Wheel:
    __slots__ = ('mount', 'otherAxleZ', 'front', 'wp', 'omega', 'driveT', 'brakeT', 'brakeCap', 'load', 'tanA',
                 'ext', 'dampV', 'kappa', 'Fsusp', 'mu', 'contact', 'surface', 'hitDist', 'normalW', 'contactW',
                 'steerOffX', 'steerOffZ', 'ny', 'mode', 'Fx', 'Fy', 'Fz')
    def __init__(s, mount, otherZ, front, wp):
        s.mount = mount; s.otherAxleZ = otherZ; s.front = front; s.wp = wp
        s.omega = 0.0; s.driveT = 0.0; s.brakeT = 0.0; s.brakeCap = 0.0; s.load = 0.0; s.tanA = 0.0
        s.ext = 1.0; s.dampV = 0.0; s.kappa = 0.0; s.Fsusp = 0.0; s.mu = 0.0; s.contact = False; s.surface = -1
        s.hitDist = 0.0; s.normalW = (0.0, 1.0, 0.0); s.contactW = (0.0, 0.0, 0.0); s.steerOffX = 0.0
        s.steerOffZ = 0.0; s.ny = 0.0; s.mode = 1; s.Fx = s.Fy = s.Fz = 0.0


class Car:
    def __init__(s, p, surface=1, tyre=0, ground_normal=(0.0, 1.0, 0.0), assist=None, seed=1):
        s.p = p; s.surface = surface; s.tyre = tyre; s.gn = normalize(ground_normal)
        s.assist = dict(bigBetaSymmetric=True, yawCapFloorZero=True, smoothYawFrictionSign=False)
        if assist: s.assist.update(assist)
        s.rng = random.Random(seed)
        m = p['mass']; s.mass = m; s.invMass = 1.0 / m
        s.I = tuple(c * m for c in p['inertia']); s.invI = tuple(1.0 / c for c in s.I)
        fl, rl = p['wheelFL'], p['wheelRL']; R = p['wheelRadius']
        mFL = (fl[0], fl[1] - R, fl[2]); mFR = (-fl[0], fl[1] - R, fl[2])
        mRL = (rl[0], rl[1] - R, rl[2]); mRR = (-rl[0], rl[1] - R, rl[2])
        wps = p['wheels']
        s.W = [Wheel(mFL, mRL[2], True, wps[0]), Wheel(mFR, mRR[2], True, wps[1]),
               Wheel(mRR, mFR[2], False, wps[2]), Wheel(mRL, mFL[2], False, wps[3])]
        s.frontShare2 = 2 * abs(s.W[3].mount[2]) / (s.W[0].mount[2] - s.W[3].mount[2])
        f = p['brakeBalance'] * 1.0
        for i, w in enumerate(s.W):
            w.brakeCap = p['brakeTorque'] * (f if i < 2 else 2 - f)
        # body
        s.pos = (0.0, 0.0, 0.0); s.vW = (0.0, 0.0, 0.0); s.q = (1.0, 0.0, 0.0, 0.0)
        s.L = (0.0, 0.0, 0.0); s.w = (0.0, 0.0, 0.0); s.Fext = (0.0, 0.0, 0.0); s.loadMoment = (0.0, 0.0, 0.0)
        s.airMul = 1.0; s.bodyOnGround = False
        s.rebuild_axes(); s.vL = (0.0, 0.0, 0.0)
        # car state
        s.speedKmh = 0.0; s.thr = 0.0; s.brk = 0.0; s.steer = [0.0, 0.0]; s.gear = 1; s.shiftDir = 0
        s.shiftTimer = 0.0; s.clutch = False; s.rpm = p['minRpm']; s.boost = p['turboIdle']
        s.ratio = [g * (1.0 if i <= 4 else 1.0) for i, g in enumerate(p['gearRatio'])]
        s.shiftSpeed = [0.0] * p['nGears']; s.build_shift_speeds()
        s.reverseAllowed = True; s.thrRamp = 0.0; s.flipTimer = 0.0; s.nContacts = 0; s.parked = False
        s.steerSensFast = True; s.stepParity = 0
        s.C = dict(steer=0.0, throttle=0.0, brake=0.0, handbrake=0.0, gearUp=False, gearDown=False)
        s.Facc_last = (0.0, 0.0, 0.0); s.Fworld_last = (0.0, 0.0, 0.0); s.beta = 0.0; s.time = 0.0
        s.capHit = False; s.rateCapHit = False

    # -------------------------------------------------------------- frames
    def rebuild_axes(s):
        w, x, y, z = s.q
        s.right = (1 - 2*(y*y + z*z), 2*(x*y + w*z), 2*(x*z - w*y))
        s.up = (2*(x*y - w*z), 1 - 2*(x*x + z*z), 2*(y*z + w*x))
        s.fwd = (2*(x*z + w*y), 2*(y*z - w*x), 1 - 2*(x*x + y*y))
    def to_local(s, v): return (dot(s.right, v), dot(s.up, v), dot(s.fwd, v))
    def to_world(s, l):
        r, u, f = s.right, s.up, s.fwd
        return (r[0]*l[0] + u[0]*l[1] + f[0]*l[2], r[1]*l[0] + u[1]*l[1] + f[1]*l[2], r[2]*l[0] + u[2]*l[1] + f[2]*l[2])

    def place_at_rest(s, height=0.4225, yaw=0.0):
        s.q = (math.cos(yaw/2), 0.0, math.sin(yaw/2), 0.0)
        s.rebuild_axes()
        s.pos = scale(s.gn, height)

    def build_shift_speeds(s):
        p = s.p
        rpmRef = p['maxTurboTorqueRpm'] if p['turboSize'] != 0 else p['maxTorqueRpm']
        circ = 2 * math.pi * p['wheelRadius']
        for i in range(p['nGears']):
            s.shiftSpeed[i] = ((rpmRef - 50) * (circ * 3.6) / (p['finalDrive'] * 60)) / s.ratio[i + 1]

    # -------------------------------------------------------------- A: inputs, gearbox, engine
    def inputs_and_steer(s):
        p, C = s.p, s.C
        s.speedKmh = abs(s.vL[2]) * 3.6
        if p['transmission'] == 'auto' and s.gear == 0:
            s.thr = C['brake']; s.brk = C['throttle']
        else:
            s.thr = C['throttle']; s.brk = C['brake']
        s.clutch = s.parked
        lock = p['wheelScale'] + ((40 - s.speedKmh) * 0.005 if s.speedKmh < 40 else 0)
        st = clamp(C['steer'], -1, 1)
        s.steer[0] = s.steer[1] = lock * st

    def gearbox(s, dt):
        p, C = s.p, s.C
        if s.shiftDir != 0:
            s.shiftTimer -= dt; s.clutch = True
            if s.shiftTimer >= 0: return
            s.gear += 1 if s.shiftDir == 1 else -1; s.shiftDir = 0
            return
        if p['transmission'] == 'auto':
            if s.clutch: return
            v = vlen(s.vW) * 3.6
            g = s.gear
            if g == 0:
                if s.brk > 0.3 and (s.speedKmh < 0.25 or s.vL[2] > 0):
                    s.shiftDir = 1; s.shiftTimer = p['timeChangeGearFR'] * 1.5
                return
            if v > s.shiftSpeed[g - 1] and g < p['nGears']:
                s.shiftDir = 1; s.shiftTimer = p['timeChangeGear'] * 1.5
            if s.thr <= p['throttleMinLimit']:
                if s.brk <= 0.3 or s.speedKmh >= 5:
                    th = s.shiftSpeed[g - 1] * p['downGearFactor']
                    if v < th and s.rpm < p['minRpmGearChange'] and \
                       ((g == 2 and v < 0.75 * th) or (g > 2 and v < 0.95 * th)):
                        s.shiftDir = 2; s.shiftTimer = min(s.shiftTimer, 0.0)
                else:
                    s.gear = 1
                    if s.reverseAllowed:
                        s.shiftDir = 2; s.shiftTimer = p['timeChangeGearFR'] * 1.5
            elif g > 1 and v < s.shiftSpeed[g - 2] * p['downGearFactor']:
                u = g - 1
                while u > 1 and v < s.shiftSpeed[u - 2] * p['downGearFactor']:
                    s.gear -= 1; u -= 1
                s.gear -= 1

    def torque_curve(s):
        r = abs(s.rpm)
        if r > 9500: return 0.0
        f = r * 0.0128; i = int(math.floor(f))
        if i >= 123: return TORQUE_CURVE[123]
        return TORQUE_CURVE[i] + (TORQUE_CURVE[i + 1] - TORQUE_CURVE[i]) * (f - i)

    def engine_torque(s):
        p = s.p
        t = 0.0 if s.rpm >= 10000 else s.torque_curve() * p['torqueScaleFactor']
        t *= p['torqueScale']
        if s.gear < 3 and s.rpm < 5500:
            f = (6000 - s.rpm) * 1e-4 * p['torqueScale']
            if f > 0: t += f
            if p['useSpinTorque'] and s.thr > 0.5 and s.gear in (0, 1):
                t += abs(s.thr) * p['spinTorqueScaleValue'] * f
        if p['turboSize'] != 0:
            t *= 1 + (0.75 / p['turboWasteGate']) * p['turboSize'] * s.boost
        if s.gear == 0: t = -t
        return t

    def update_rpm(s, wMean, thr, dt):
        p = s.p
        if not s.clutch:
            s.rpm = wMean * 9.549296 * s.ratio[s.gear] * p['finalDrive']
            if s.rpm > p['cutRpm']: s.rpm -= 2 * s.rpm * dt
        else:
            s.rpm = s.rpm - (2 - thr * 1.95) * s.rpm * dt * 0.75 + dt * 15000 * thr * 2.5 * s.torque_curve()
        if p['turboSize'] == 0:
            s.boost = -1; return
        if thr <= 0.5 or s.rpm <= p['turboSize'] * 1500 - 800:
            s.boost -= p['turboSize'] * max(0.0, (0.5 - thr) * 2) * s.boost / (p['turboSpinup'] * 40)
        else:
            s.boost += s.boost * thr / (p['turboSpinup'] * 40)
        s.boost = clamp(s.boost, p['turboIdle'], p['turboWasteGate'])

    def drivetrain(s, hb, dt):
        p, W = s.p, s.W
        rpmAtStepStart = s.rpm
        for w in W: w.driveT = 0.0; w.brakeT = 0.0
        shifting = s.shiftDir != 0 or s.clutch
        if shifting:
            if p['useEngineBrakeConstant'] and ((s.shiftDir == 1 and s.gear == 0) or (s.shiftDir == 2 and s.gear == 1)):
                for w in W: w.brakeT = p['engineBrakeConstant']
            wAll = sum(w.omega for w in W) * 0.25
            if s.shiftDir != 0:
                if p['turboSize'] != 0 and s.boost > 0.25 * p['turboWasteGate']: s.boost = 0.25 * p['turboWasteGate']
                s.update_rpm(wAll, 0.0, dt)
            else:
                s.update_rpm(wAll, s.thr, dt)
        else:
            f = (lambda o: min(o, 0.0)) if s.gear == 0 else (lambda o: max(o, 0.0))
            kF = kR = kC = 1.0; wMean = 0.0
            if p['wheelDrive'] == 0:
                a, b = f(W[0].omega), f(W[1].omega); wMean = (a + b) / 2
                if wMean != 0: kF = clamp(b / wMean, 0.5, 1.5)
            elif p['wheelDrive'] == 1:
                a, b = f(W[3].omega), f(W[2].omega); wMean = (a + b) / 2
                if wMean != 0: kR = clamp(b / wMean, 0.5, 1.5)
            else:
                a, b = f(W[0].omega), f(W[1].omega); fm = (a + b) / 2
                if fm != 0: kF = clamp(b / fm, 0.5, 1.5)
                c, d = f(W[3].omega), f(W[2].omega); rm = (c + d) / 2
                if rm != 0: kR = clamp(d / rm, 0.5, 1.5)
                wMean = (fm + rm) / 2
                if wMean != 0: kC = clamp(fm / wMean, 0.5, 1.5)
            s.update_rpm(wMean, s.thr, dt)
            if s.thr <= p['throttleMinLimit']:
                T = (s.thr - p['throttleMinLimit']) * ((5000 - 700 * s.gear) + s.rpm) * 0.75
                if abs(wMean) < 1: T *= abs(wMean)
                if s.gear == 0: T = -T
            else:
                T = s.engine_torque()
                if p['useAntiSpin'] and s.gear < 3 and any(abs(w.kappa) > 0.05 for w in W): T /= p['antiSpinFactor']
                T *= s.thr
            if p['wheelDrive'] == 0:
                W[0].driveT = 1.5*T*kF; W[1].driveT = 1.5*T*(2-kF); W[2].driveT = 0.5*T*kF; W[3].driveT = 0.5*T*(2-kF)
            elif p['wheelDrive'] == 1:
                W[0].driveT = 0.75*T*kR; W[1].driveT = 0.75*T*(2-kR); W[2].driveT = 1.25*T*(2-kR); W[3].driveT = 1.25*T*kR
            else:
                fs = 1.0
                W[0].driveT = (2-kC)*kF*fs*T; W[1].driveT = (2-kC)*(2-kF)*fs*T
                W[2].driveT = (2-kR)*kC*(2-fs)*T; W[3].driveT = kR*kC*(2-fs)*T
        # 2.3.5 hill-hold / stall / park
        if p['useEngineBrakeConstant']:
            EBC = p['engineBrakeConstant']
            if s.parked:
                for w in W: w.brakeT = EBC
            elif s.thr < p['throttleMinLimit'] or s.shiftDir != 0:
                if s.rpm <= p['minRpm']:
                    x = min(p['minRpm'] - s.rpm, p['minRpm']) / p['minRpm']
                    for w in W: w.brakeT = x * x * EBC * 0.2
            elif s.gear == 0:
                for w in W:
                    if w.omega > 0.3: w.brakeT = EBC
            else:
                for w in W:
                    if w.omega < -0.3: w.brakeT = EBC
        # idle and limiter
        if s.rpm < p['minRpm']:
            if s.thr >= p['throttleMinLimit']: s.rpm = p['minRpm']
            else: s.rpm = clamp(rpmAtStepStart, p['minRpm'] - 184, p['minRpm'] - 16) + s.rng.randint(-15, 16)
        if s.rpm > p['cutRpm']: s.rpm = p['cutRpm'] + 512 + s.rng.randint(-511, 512)
        # rolling resistance
        pool = 0.0
        for i, w in enumerate(W):
            c = 0.0
            if w.contact:
                row = TYRE_TABLE[w.surface][s.tyre]
                rr = row[3] + row[4] * p['rollLevel']
                t = (-w.load) / 2048 * rr
                c = 0.25 * t; pool += 0.75 * t
            driven = p['wheelDrive'] == 2 or (p['wheelDrive'] == 0 and i < 2) or (p['wheelDrive'] == 1 and i >= 2)
            if driven: c += w.wp['rollK']
            w.driveT -= w.omega * c
        for w in W: w.driveT -= w.omega * 0.25 * pool
        # service brakes, handbrake
        if s.brk > p['brakeMinLimit']:
            for w in W:
                if s.brk < 0.75: w.brakeT = 0.5 * s.brk * s.brk * w.brakeCap
                elif not p['useAbs'] or abs(w.kappa) < p['absFactor']: w.brakeT = s.brk * s.brk * w.brakeCap
                else: w.brakeT = 0.0
        if hb > p['brakeMinLimit']:
            for i, w in enumerate(W): w.brakeT = hb * p['handBrakeTorque'] * (0.3 if i < 2 else 1.3)

    def aero_gravity(s):
        p = s.p
        q = -p['airKZY'] * s.vL[2] * s.vL[2]
        vW, up = s.vW, s.up
        k = p['airKZZ']
        s.Fext = (q*up[0] - abs(vW[0])*vW[0]*k,
                  q*up[1] - GRAVITY*s.mass - abs(vW[1])*vW[1]*k,
                  q*up[2] - abs(vW[2])*vW[2]*k)

    # -------------------------------------------------------------- tyre force 2.6.1
    def tyre_force(s, wp, tanA, kappa, Fz, muFz, deep):
        p = s.p
        neg = kappa < 0; k = abs(kappa)
        sx = -k / (1 + k); sy = tanA / (1 + k)
        if Fz >= 9500: P = LOAD_TABLE[19]
        else:
            f = Fz * 0.002; j = int(math.floor(f)); t = f - j
            A, B = LOAD_TABLE[j], LOAD_TABLE[j + 1]
            P = [A[q] + (B[q] - A[q]) * t for q in range(4)]
        pa, pk, Dy, Dx = P
        cx = -pk / (pk + 1); cy = pa / (pk + 1)
        nx = sx / cx; ny = sy / cy
        sMag = math.hypot(sx, sy); rho = math.hypot(nx, ny)
        kEq = rho * pk / (pk + 1); kEq = kEq / (kEq + 1)
        aEq = math.atan(cy * rho if sy > 0 else -cy * rho)
        mult = p['sideFrictionFactor'] if (deep and p['useSideFriction']) else 1.0
        B_lat = max(1.0, (1.75 - Fz * 1e-4) * wp['latPosK'] + 5)
        B_lon = max(1.0, (1.75 - Fz * 1e-4) * wp['longPosK'] + 5)
        lat = (1 - math.exp(-B_lat * abs(aEq)) - abs(aEq) * wp['latNegK']) * Dy if Fz > 0 else 0.0
        lon = max(0.0, (1 - math.exp(-B_lon * kEq) - kEq * wp['longNegK']) * Dx) if Fz > 0 else 0.0
        Fy0 = mult * muFz * lat; Fx0 = muFz * lon
        rc = min(rho, 1.0)
        if sMag == 0: sMag = 1e-4
        if rho == 0: rho = 1e-4
        Fx = (-sx / sMag) * (Fx0 - (Fx0 - Fy0) * (ny / rho) ** 2 * rc)
        Fy = (sy / sMag) * (Fy0 - (Fy0 - Fx0) * (nx / rho) ** 2 * rc)
        if neg: Fx = -Fx
        Mz = 0.0 if Fz < 0 else -sgn(aEq) * aEq * aEq * Fz * 0.5 * wp['alignMomScale']
        if Fy0 != 0: Mz *= abs(Fy) / Fy0
        return Fx, Fy, Mz

    # -------------------------------------------------------------- B: main step
    def step_b(s, dt):
        p, W = s.p, s.W
        s.capHit = s.rateCapHit = False
        sf = 0.0 if s.speedKmh <= 25 else min(1.0, (s.speedKmh - 25) * 0.02)
        kappaThr = 0.075 * (1 + sf)
        s.pos = add(s.pos, scale(s.vW, dt))
        qw, qx, qy, qz = s.q; wx, wy, wz = s.w
        # q (x) (0, w): Hamilton product
        dq = (-qx*wx - qy*wy - qz*wz, qw*wx + qy*wz - qz*wy, qw*wy + qz*wx - qx*wz, qw*wz + qx*wy - qy*wx)
        h = 0.5 * dt
        q = (qw + dq[0]*h, qx + dq[1]*h, qy + dq[2]*h, qz + dq[3]*h)
        n = math.sqrt(sum(c*c for c in q)); s.q = tuple(c / n for c in q)
        s.rebuild_axes()
        s.vL = s.to_local(s.vW)
        beta = 0.0 if s.vL[2] == 0 else math.atan(-s.vL[0] / s.vL[2])
        s.beta = beta
        s.stepParity ^= 1
        # raycasts against plane dot(gn, x) = 0
        gn = s.gn; down = scale(s.up, -1)
        for w in W:
            start = add(s.pos, s.to_world(w.mount))
            den = dot(gn, down)
            hit = None
            if den < 0:
                t = -dot(gn, start) / den
                if 0 <= t <= w.wp['springLength']: hit = t
            if hit is None:
                w.contact = False; w.surface = -1; w.normalW = (0.0, 1.0, 0.0)
            else:
                w.contact = True; w.surface = s.surface; w.hitDist = hit; w.normalW = gn
        # suspension
        nC = 0
        for w in W:
            if not w.contact:
                w.dampV = 0.0; w.ext = 1.0; w.Fsusp = 0.0; continue
            nC += 1
            SL = w.wp['springLength']
            comp = SL - w.hitDist
            sink = SURFACE_TABLE[w.surface][2]  # bump pattern ignored (BumpFlag surfaces not used here)
            x = clamp(1 - (sink + comp) / SL, 0, 1)
            xPrev = x if w.ext == 1.0 else w.ext
            w.ext = x
            e = 1 - (xPrev + x) / 2
            k = 1.0
            dx = clamp((xPrev - x) * SL, -0.5, 0.5)
            vOld = w.dampV; vNew = (2 / dt) * (dx - dt * vOld) + vOld
            w.dampV = vNew
            Fd = min(60000.0, 0.5 * (vNew + vOld) * (1 + e) * k * w.wp['dampK'])
            Fs = k * w.wp['springK'] * SL * e * (1 + 0.5 * e)
            F = Fd + Fs
            vn = dot(s.vW, w.normalW)
            if vn > 2: F = min(F, max(0.0, 32000 - 5000 * vn))
            w.Fsusp = max(0.0, F)
        s.nContacts = nC
        # tyre loads
        Fup = dot(s.Fext, s.up)
        nb = 0.0
        Tx, Tz = s.loadMoment[0], s.loadMoment[2]
        SX = [-1, 1, 1, -1]; SZ = [1, 1, -1, -1]; sameSide = [3, 2, 1, 0]; sameAxle = [1, 0, 3, 2]
        if nC == 1:
            i = next(j for j, w in enumerate(W) if w.contact); d = s.to_world(W[i].mount)
            W[i].load = -(d[1] / vlen(d)) * Fup / (nb + 1)
        elif nC >= 2:
            base = Fup / (nb + 4)
            for i, w in enumerate(W):
                if not w.contact: continue
                share = base if nC == 2 else base * (s.frontShare2 if i < 2 else 2 - s.frontShare2)
                kx = 2 if nC == 2 else (2 if (nC == 3 and not W[sameSide[i]].contact) else 1)
                kz = 2 if nC == 2 else (2 if (nC == 3 and not W[sameAxle[i]].contact) else 1)
                w.load = share + SX[i]*kx*w.wp['momentXDist']*Tx + SZ[i]*kz*w.wp['momentZDist']*Tz
        # wheel loop
        Facc = [0.0, 0.0, 0.0]; Tacc = [0.0, 0.0, 0.0]; lm = [0.0, 0.0, 0.0]
        R = p['wheelRadius']
        for i in range(4):
            w = W[i]; wp = w.wp; inv = wp['wheelInertia']
            Fw = (0.0, 0.0, 0.0); Fx = Fy = Vx = Vy = head = FxWheel = 0.0
            if w.omega > 0: w.omega = max(0.0, w.omega - w.brakeT * inv * dt)
            elif w.omega < 0: w.omega = min(0.0, w.omega + w.brakeT * inv * dt)
            launch = 1.0
            if s.gear <= 1 and s.thr > 0.1:
                if p['wheelDrive'] == 2: launch = max(1.0, (25 - abs(w.omega)) * 0.2)
                else: launch = max(1.0, 4 - abs(w.omega)) if i < 2 else max(1.0, (20 - abs(w.omega)) * 0.2)
            w.omega += launch * w.driveT * inv * dt
            if abs(w.omega) < 3.14 and w.brakeT > 1000: w.omega = 0.0
            r = list(w.mount)
            w.Fx = w.Fy = w.Fz = 0.0
            if w.contact:
                r[1] = w.mount[1] - wp['springLength'] * w.ext
                if w.front:
                    kk = wp['steerTweak'] * (-1 if i == 1 else 1)
                    w.steerOffX = (1 - math.cos(s.steer[i])) * kk; w.steerOffZ = math.sin(s.steer[i]) * kk
                    r[0] += w.steerOffX; r[2] += w.steerOffZ
                r = tuple(r)
                v = add(s.vL, cross(s.w, r))
                Fz = max(0.0, -w.load)
                nL = s.to_local(w.normalW)
                Fw = scale(nL, w.Fsusp)
                ax, az = 1.0, 0.0
                if w.front and s.steer[i] != 0:
                    t = math.tan(s.steer[i]); c = 1.0 if t == 0 else 1.0 / t
                    dz = r[2] - w.otherAxleZ
                    X = (dz - w.steerOffZ) * c - r[0]
                    if X <= 0: ax, az = -X, dz
                    else: ax, az = X, -dz
                a = (ax, 0.0, az)
                d = normalize(sub(a, scale(nL, dot(a, nL))))
                fw = cross(d, nL)
                Vy = dot(v, d); Vx = dot(v, fw)
                w.ny = nL[1]
                if nL[1] < 0.9635: Fz *= max(0.25, nL[1] * nL[1])
                aVx = abs(Vx)
                if aVx > 3: w.tanA += wp['tireRelaxK'] * (-Vy - aVx * w.tanA) * dt
                elif aVx > 0.1: w.tanA = -Vy / aVx
                elif abs(Vy) > 0.01: w.tanA = -Vy * 10
                else: w.tanA = -1e-5 if Vy >= 0 else 1e-5
                alpha = math.atan(w.tanA)
                w.kappa = (R * w.omega - Vx) * 100 if aVx == 0 else (R * w.omega - Vx) / aVx
                mu = mu_static(w.surface, s.tyre) if w.mode == 1 else mu_kinetic(w.surface, s.tyre)
                if abs(beta) > 0.125: mu *= 1 + abs(beta) * s.thr * 0.2
                bb = abs(beta) if s.assist['bigBetaSymmetric'] else beta
                if bb > 0.75: mu *= 1 + (abs(beta) - 0.75) * 0.3
                w.mu = mu
                muFz = Fz * mu
                ssa = (wp['staticSlipAngleFast'] if s.steerSensFast else wp['staticSlipAngleSlow'])
                thrA = Fz / 2048 * ssa
                newMode = w.mode
                if w.mode == 1:
                    if (abs(w.omega) > 0.05 or abs(Vy) > 0.05) and (abs(alpha) > thrA or abs(w.kappa) > kappaThr):
                        newMode = 2
                else:
                    if (abs(alpha) < thrA or abs(Vy) < 0.1) and (abs(w.kappa) < kappaThr or aVx < 0.1):
                        newMode = 1
                Fx, Fy, Mz = s.tyre_force(wp, w.tanA, w.kappa, Fz, muFz, w.surface in DEEP)
                Iy = s.I[1]
                if w.mode == 1:
                    if s.assist['smoothYawFrictionSign']:
                        M = -wp['twStaMy'] * Iy * mu * clamp(s.L[1] / (0.05 * Iy), -1, 1)
                    else:
                        M = wp['twStaMy'] * Iy * mu * (-1 if s.L[1] >= 0 else 1)
                    if w.front:
                        m2 = wp['twStaSteer'] * Iy * mu * s.steer[i]
                        M += -m2 if s.vL[2] <= 0 else m2
                else:
                    M = Mz
                    if w.front:
                        m2 = (abs(beta) + 0.25) * Iy * wp['twKinSteer'] * mu * s.steer[i]
                        M += -m2 if s.vL[2] <= 0 else m2
                    if abs(w.omega) < 0.05 and abs(Vy) < 0.05: newMode = 1
                Tacc[1] += M * sf
                if abs(w.omega) < 0.1 and aVx < 0.1: Fx *= aVx * 10
                if abs(Vy) < 0.0625: Fy *= abs(Vy) * 16
                head = muFz - abs(Fy)
                FxWheel = Fx
                if (w.mode == 2 and (s.gear > 1 or p['wheelDrive'] == 2) and sf == 0 and abs(w.kappa) > 0.15 and
                        sgn(w.kappa) == sgn(w.omega) and w.omega != 0):
                    f1 = min(1.0, 0.15 / abs(w.kappa) + 0.25); g1 = max(0.0, 1.5 - mu)
                    Fx *= max(f1, g1)
                w.mode = newMode
                Fw = add(Fw, add(scale(fw, Fx), scale(d, Fy)))
                w.Fx, w.Fy, w.Fz = Fx, Fy, Fz
            else:
                w.ny = 0.0; r = tuple(r)
            extra = FxWheel * 0.5 * abs(beta) * sf if abs(w.omega) > 1 else 0.0
            if w.brakeT < 1000 or abs(w.omega) < 3.14:
                w.omega += -(extra + FxWheel) * R * inv * dt
            Facc[2] += extra
            if head != 0 and abs(Vy) > 0.0625:
                f2 = min(1.0, abs(beta) + 0.25)
                Facc[0] += (1 if Fy > 0 else -1) * f2 * min(head, 10000.0)
            Facc[0] += Fw[0]; Facc[1] += Fw[1]; Facc[2] += Fw[2]
            tq = cross(r, Fw); Tacc[0] += tq[0]; Tacc[1] += tq[1]; Tacc[2] += tq[2]
            lm[0] += -r[1] * Fw[0]; lm[2] += -r[1] * Fw[2]
            w.contactW = add(s.pos, s.to_world(r))
        s.loadMoment = tuple(lm)
        s.thrRamp = min(2.25, s.thrRamp + 2.25 * dt) if s.thr > 0 else 0.0
        # body friction damping
        if p['useBodyFrictionDamping'] and s.nContacts > 0:
            vmag = vlen(s.vL); vhat = scale(s.vL, 1 / vmag) if vmag > 0 else (0.0, 0.0, 0.0)
            sumDiff = 0.0; K = 0.0
            for w in W:
                if w.contact and w.surface in DEEP:
                    sumDiff += TYRE_TABLE[w.surface][s.tyre][4]; K += 0.5 * p['wheelContactFactor']
            if K:
                F = scale(vhat, (sumDiff / s.nContacts) * vmag * K * s.Fext[1])
                Facc[0] += F[0]; Facc[1] += F[1]; Facc[2] += F[2]
                tq = cross((0.0, p['hullBottomY'], 0.0), F); Tacc[0] += tq[0]; Tacc[1] += tq[1]; Tacc[2] += tq[2]
        # anti-roll
        xm = lambda i: W[i].mount[0]
        SL = W[0].wp['springLength']
        Tacc[2] += 0.5 * (W[0].wp['rollStiffness'] + W[1].wp['rollStiffness']) * \
            ((W[0].ext - W[1].ext) * SL * 2 * (W[0].ny + W[1].ny)) / (xm(1) - xm(0))
        Tacc[2] += 0.5 * (W[2].wp['rollStiffness'] + W[3].wp['rollStiffness']) * \
            ((W[3].ext - W[2].ext) * SL * 2 * (W[3].ny + W[2].ny)) / (xm(2) - xm(3))
        # yaw caps
        L = list(s.L)
        if s.nContacts >= 2:
            lim = ((2.75 - sf) - abs(beta)) * p['twMaxMom'] * s.I[1]
            if s.assist['yawCapFloorZero']: lim = max(0.0, lim)
            t0 = Tacc[1]
            Tacc[1] = min(Tacc[1], lim); Tacc[1] = max(Tacc[1], -lim)
            s.capHit = Tacc[1] != t0
            limL = s.I[1] * ((2 - sf) * p['twMomLimStart'] + abs(beta) * p['twMomLimScale'])
            l0 = L[1]; L[1] = clamp(L[1], -limL, limL); s.rateCapHit = L[1] != l0
        # air gravity
        if s.speedKmh <= 10: s.airMul = 1.0
        elif s.nContacts < 3: s.airMul = min(1.45, s.airMul * 1.065)
        elif abs(s.fwd[1]) <= 0.25: s.airMul = 1.0
        Fworld = add(s.to_world(tuple(Facc)), scale(s.Fext, s.airMul))
        s.Facc_last = tuple(Facc); s.Fworld_last = Fworld
        s.vW = add(s.vW, scale(Fworld, s.invMass * dt))
        s.w = (s.invI[0] * L[0], s.invI[1] * L[1], s.invI[2] * L[2])
        L = [L[0] + Tacc[0] * dt, L[1] + Tacc[1] * dt, L[2] + Tacc[2] * dt]
        if s.nContacts == 0:
            L = [toward_zero(L[j], s.I[j] * dt) for j in range(3)]
            s.vW = tuple(toward_zero(s.vW[j], 2 * dt) for j in range(3))
        s.L = tuple(L)
        pedals = s.thr != 0 or s.brk != 0
        hardSpring = any(w.Fsusp > 4500 for w in W)
        s.slept = False
        if dot(s.vW, s.vW) < 0.1 and dot(s.w, s.w) < 0.1 and s.nContacts >= 3 and not hardSpring and (not pedals or s.parked):
            s.vW = (0.0, 0.0, 0.0); s.L = (s.L[0], 0.0, s.L[2])
            for w in W: w.omega = 0.0
            s.slept = True

    def step(s, dt):
        s.inputs_and_steer()
        s.gearbox(dt)
        s.drivetrain(s.C['handbrake'], dt)
        s.aero_gravity()
        s.step_b(dt)
        s.time += dt

    # -------------------------------------------------------------- helpers for tests
    def heading(s): return math.atan2(s.fwd[0], s.fwd[2])
    def kmh_fwd(s): return abs(s.to_local(s.vW)[2]) * 3.6
    def kmh_world(s): return vlen(s.vW) * 3.6
    def a_lat_g(s): return dot(s.right, s.Fworld_last) / s.mass / 9.81
    def a_lat_g_horiz(s):   # lateral accel in the ground plane, no gravity component
        f = s.Fworld_last; g = s.gn
        fh = sub(f, scale(g, dot(f, g)))
        rh = normalize(sub(s.right, scale(g, dot(s.right, g))))
        return dot(rh, fh) / s.mass / 9.81
    def finite(s):
        vals = list(s.pos) + list(s.vW) + list(s.L) + [w.omega for w in s.W] + [s.rpm]
        return all(math.isfinite(v) for v in vals) and abs(s.pos[1]) < 1e4


# ----------------------------------------------------------------------------- scenario helpers
SURF = {'tarmac': (1, 0), 'gravel': (2, 2), 'snow': (7, 3), 'ice': (20, 4), 'snow_tt': (7, 0), 'ice_tt': (20, 0),
        'ice_gt': (20, 2), 'gravelDeep': (12, 2)}

def new_car(surf='tarmac', dt=1/120, assist=None, normal=(0.0, 1.0, 0.0), params=None):
    s, t = SURF[surf]
    c = Car(params or awd_wrc_params(), s, t, normal, assist)
    c.place_at_rest()
    c.C.update(handbrake=1.0)
    for _ in range(int(round(100 * (1/120) / dt))):   # 100 settle steps (same settle TIME at 2*dt)
        c.step(dt)
    c.C.update(handbrake=0.0)
    return c

def speed_hold(c, vT):
    v = abs(c.vL[2]) * 3.6
    c.C['throttle'] = clamp((vT - v) * 0.2 + 0.3, 0, 1) if v < vT else 0.0
    c.C['brake'] = 0.0; c.C['steer'] = 0.0

def reach_speed(c, vT, dt, tmax=40.0):
    t = 0.0; ok_since = None
    while t < tmax:
        speed_hold(c, vT); c.step(dt); t += dt
        if not c.finite(): return False
        v = abs(c.vL[2]) * 3.6
        if t >= 3 and abs(v - vT) < 0.5:
            return True
    return False

def run(c, dt, T, ctrl=None, rec=None):
    n = int(round(T / dt))
    for k in range(n):
        if ctrl: ctrl(c, k * dt)
        c.step(dt)
        if rec is not None: rec(c, (k + 1) * dt)
        if not c.finite(): return False
    return True

def wrap(a):
    while a > math.pi: a -= 2 * math.pi
    while a < -math.pi: a += 2 * math.pi
    return a


# ----------------------------------------------------------------------------- tests
def t1_accel(surf, dt, T=60.0):
    c = new_car(surf, dt)
    c.C.update(throttle=1.0, steer=0.0)
    marks = {60: None, 100: None, 160: None}; shifts = []; lastg = c.gear; t = 0.0
    n = int(round(T / dt)); vmax = 0
    for k in range(n):
        c.step(dt); t += dt
        v = abs(c.vL[2]) * 3.6; vmax = max(vmax, v)
        for m in marks:
            if marks[m] is None and v >= m: marks[m] = round(t, 2)
        if c.gear != lastg:
            shifts.append((lastg, c.gear, round(c.kmh_world(), 1))); lastg = c.gear
        if not c.finite(): return dict(err='non-finite at %.2f' % t)
    return dict(t60=marks[60], t100=marks[100], t160=marks[160], vtop=round(abs(c.vL[2]) * 3.6, 1),
                gear=c.gear, rpm=round(c.rpm), shifts=shifts[:8])

def t3_brake(surf, dt):
    c = new_car(surf, dt)
    if not reach_speed(c, 100, dt): return dict(err='no 100')
    p0 = c.pos; v0 = abs(c.vL[2]) * 3.6; t = 0.0
    c.C.update(throttle=0.0, brake=1.0, steer=0.0)
    while t < 30:
        c.step(dt); t += dt
        if abs(c.vL[2]) * 3.6 < 0.2 or not c.finite(): break
    return dict(v0=round(v0, 1), dist=round(vlen(sub(c.pos, p0)), 1), time=round(t, 2),
                gear=c.gear, ok=c.finite())

def t3b_coast(surf, dt):
    c = new_car(surf, dt)
    if not reach_speed(c, 100, dt): return dict(err='no 100')
    v0 = abs(c.vL[2]); g0 = c.gear
    c.C.update(throttle=0.0, brake=0.0, steer=0.0)
    run(c, dt, 1.0)
    return dict(gear=g0, rpm=round(c.rpm), decel=round((v0 - abs(c.vL[2])) / 1.0, 2))

def t4_lateral(surf, vT, dt, steers=(0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 0.6, 0.8, 1.0)):
    out = []
    for st in steers:
        c = new_car(surf, dt)
        if not reach_speed(c, vT, dt): out.append((st, None)); continue
        acc = []; acc2 = []; yr = []; bet = []
        def ctrl(c, t):
            c.C['steer'] = st
            c.C['throttle'] = clamp((vT - vlen(c.vW) * 3.6) * 0.15 + 0.35, 0, 1)
        def rec(c, t):
            if t > 4.0:
                acc.append(c.a_lat_g()); acc2.append(c.a_lat_g_horiz()); yr.append(c.w[1]); bet.append(c.beta)
        ok = run(c, dt, 6.0, ctrl, rec)
        if not ok: out.append((st, 'NaN')); continue
        m = sum(acc) / len(acc); m2 = sum(acc2) / len(acc2)
        out.append((st, round(m, 3), round(m2, 3), round(sum(yr) / len(yr), 3), round(math.degrees(sum(bet) / len(bet)), 1),
                    round(vlen(c.vW) * 3.6, 1)))
    best = max((o for o in out if isinstance(o[1], float)), key=lambda o: abs(o[1]), default=None)
    return dict(best=best, all=out)

def t5_handbrake(surf, dt, hb_time=0.5, steer=1.0, thr_after=1.0, use_hb=True, vT=60):
    c = new_car(surf, dt)
    if not reach_speed(c, vT, dt): return dict(err='no 60')
    h0 = c.heading(); res = {}
    def ctrl(c, t):
        c.C['steer'] = steer
        if t < hb_time:
            c.C['handbrake'] = 1.0 if use_hb else 0.0; c.C['throttle'] = 0.0
        else:
            c.C['handbrake'] = 0.0; c.C['throttle'] = thr_after
    total = 0.0; last = h0
    def rec(c, t):
        nonlocal total, last
        h = c.heading(); total += wrap(h - last); last = h
        for mark in (0.5, 1.0, 2.0):
            if abs(t - mark) < dt / 2: res[mark] = (round(math.degrees(total), 1), round(c.kmh_world(), 1))
    run(c, dt, 2.0, ctrl, rec)
    return res

def straight_jitter(surf, vT, dt, assist=None):
    c = new_car(surf, dt, assist)
    if not reach_speed(c, vT, dt): return dict(err='no speed')
    yr = []; vy = []
    def ctrl(c, t): speed_hold(c, vT)
    def rec(c, t): yr.append(c.w[1]); vy.append(c.vL[0])
    run(c, dt, 3.0, ctrl, rec)
    dif = [abs(yr[k+1] - yr[k]) for k in range(len(yr) - 1)]
    return dict(yawrate_pp=round(max(yr) - min(yr), 4), max_step_change=round(max(dif), 4),
                vlat_pp=round(max(vy) - min(vy), 4), mean_yawrate=round(sum(yr) / len(yr), 5))

def standstill(surf, dt, ctrl_vals, T=5.0, normal=(0.0, 1.0, 0.0)):
    c = new_car(surf, dt, normal=normal)
    p0 = c.pos; h0 = c.heading()
    vs = []; ws = []; sl = 0
    def ctrl(c, t): c.C.update(ctrl_vals)
    def rec(c, t):
        nonlocal sl
        vs.append(vlen(c.vW)); ws.append(abs(c.w[1])); sl += 1 if getattr(c, 'slept', False) else 0
    ok = run(c, dt, T, ctrl, rec)
    return dict(ok=ok, drift_m=round(vlen(sub(c.pos, p0)), 4), yaw_deg=round(math.degrees(wrap(c.heading() - h0)), 3),
                vmax_last2s=round(max(vs[-int(2/dt):]), 4), wymax_last2s=round(max(ws[-int(2/dt):]), 4),
                sleep_frac=round(sl / len(vs), 2), gear=c.gear,
                omegas=[round(w.omega, 2) for w in c.W])

def creep(surf, dt, v0_ms, steer, thr, T=4.0):
    """start rolling slowly, watch slip states / jitter"""
    c = new_car(surf, dt)
    c.vW = scale(c.fwd, v0_ms)
    for w in c.W: w.omega = v0_ms / c.p['wheelRadius']
    yr = []; ax = []; vz = []
    def ctrl(c, t): c.C.update(steer=steer, throttle=thr, brake=0.0)
    def rec(c, t): yr.append(c.w[1]); vz.append(c.vL[2]); ax.append(c.a_lat_g())
    ok = run(c, dt, T, ctrl, rec)
    tail = int(1.0 / dt)
    dyr = [abs(yr[k+1] - yr[k]) for k in range(len(yr) - tail, len(yr) - 1)]
    sign_flips = sum(1 for k in range(len(yr) - tail, len(yr) - 1) if (yr[k+1] - yr[k]) * (yr[k] - yr[k-1]) < 0)
    return dict(ok=ok, v_end=round(vlen(c.vW), 3), yawrate_end=round(yr[-1], 3),
                yaw_step_max=round(max(dyr), 4), yaw_dir_flips_last_s=sign_flips,
                alat_pp_last_s=round(max(ax[-tail:]) - min(ax[-tail:]), 3),
                modes=[w.mode for w in c.W], kappa=[round(w.kappa, 2) for w in c.W])

def stopping(surf, dt, v0=5.0, brake=1.0):
    """brake to a stop from low speed and keep holding: check jitter after stop"""
    c = new_car(surf, dt)
    c.vW = scale(c.fwd, v0 / 3.6)
    for w in c.W: w.omega = (v0 / 3.6) / c.p['wheelRadius']
    vs = []; gears = []; ws = []
    def ctrl(c, t): c.C.update(throttle=0.0, brake=brake, steer=0.0)
    def rec(c, t): vs.append(c.to_local(c.vW)[2]); gears.append(c.gear); ws.append(abs(c.w[1]))
    ok = run(c, dt, 4.0, ctrl, rec)
    return dict(ok=ok, v_end_kmh=round(vs[-1] * 3.6, 2), gear_end=gears[-1],
                v_pp_last_s=round(max(vs[-int(1/dt):]) - min(vs[-int(1/dt):]), 4))

def rollout_stop(surf, dt, v0_kmh=3.0):
    """no pedals, coast from walking pace: does it come to rest cleanly?"""
    c = new_car(surf, dt)
    c.vW = scale(c.fwd, v0_kmh / 3.6)
    for w in c.W: w.omega = (v0_kmh / 3.6) / c.p['wheelRadius']
    t_stop = None; t = 0.0
    while t < 5:
        c.C.update(throttle=0.0, brake=0.0, steer=0.0); c.step(dt); t += dt
        if t_stop is None and vlen(c.vW) == 0.0: t_stop = round(t, 2)
    return dict(t_stop=t_stop, v_end=round(vlen(c.vW), 4))


def hold_corner(c, vT, st):
    c.C['steer'] = st
    c.C['throttle'] = clamp((vT - vlen(c.vW) * 3.6) * 0.15 + 0.35, 0, 1)

def t6_recovery(dt):
    c = new_car('tarmac', dt)
    reach_speed(c, 80, dt)
    betas = []
    def ctrl(c, t):
        if t < 0.4: c.C.update(steer=1.0, handbrake=1.0, throttle=0.0)
        else: c.C.update(steer=0.0, handbrake=0.0, throttle=0.3)
    def rec(c, t): betas.append((t, abs(math.degrees(c.beta))))
    run(c, dt, 2.0, ctrl, rec)
    peak = max(betas, key=lambda x: x[1])
    after = next((t for t, b in betas if t > peak[0] and b < 5), None)
    return dict(peak_beta=round(peak[1], 1), t_peak=round(peak[0], 2), t_below5=after and round(after - 0.4, 2))

def t7_t8(surf, dt):
    c = new_car(surf, dt)
    reach_speed(c, 100 if surf == 'tarmac' else 80, dt)
    mb = 0.0
    def ctrl(c, t): c.C.update(steer=0.3, throttle=1.0)
    def rec(c, t):
        nonlocal mb; mb = max(mb, abs(math.degrees(c.beta)))
    run(c, dt, 3.0, ctrl, rec)
    return dict(max_beta=round(mb, 1))

def path_radius(c): return vlen(c.vW) / max(1e-6, abs(c.w[1]))

def t10_t11(dt, st, mode):
    c = new_car('gravel', dt)
    reach_speed(c, 80, dt)
    run(c, dt, 4.0, lambda c, t: hold_corner(c, 80, st))
    r0 = path_radius(c); b0 = abs(math.degrees(c.beta)); y0 = abs(c.w[1])
    mb = 0.0; my = 0.0
    def ctrl(c, t): c.C.update(steer=st, throttle=1.0 if mode == 'power' else 0.0)
    def rec(c, t):
        nonlocal mb, my; mb = max(mb, abs(math.degrees(c.beta))); my = max(my, abs(c.w[1]))
    run(c, dt, 1.0 if mode == 'power' else 1.5, ctrl, rec)
    return dict(r0=round(r0, 1), r1=round(path_radius(c), 1), dr_pct=round(100 * (path_radius(c) / r0 - 1)),
                beta0=round(b0, 1), beta_max=round(mb, 1), beta_end=round(abs(math.degrees(c.beta)), 1),
                yaw_ratio=round(my / y0, 2))

def t12_step(surf, dt):
    c = new_car(surf, dt)
    reach_speed(c, 80, dt)
    run(c, dt, 1.0, lambda c, t: c.C.update(steer=0.0, throttle=0.4))
    yr = []
    run(c, dt, 1.0, lambda c, t: c.C.update(steer=0.2, throttle=0.4), lambda c, t: yr.append((t, c.w[1])))
    y1 = yr[-1][1]
    t63 = next(t for t, y in yr if y >= 0.632 * y1)
    return dict(t63=round(t63, 3), yaw1s=round(y1, 3))

def t16_gear(dt):
    c = new_car('tarmac', dt)
    reach_speed(c, 140, dt, tmax=60)
    log = []; last = c.gear
    def ctrl(c, t): c.C.update(throttle=0.0, brake=0.0, steer=0.0)
    def rec(c, t):
        nonlocal last
        if c.gear != last: log.append((last, c.gear, round(c.kmh_world(), 1), round(c.rpm))); last = c.gear
    run(c, dt, 25.0, ctrl, rec)
    return log

def t18_deep(dt):
    c = new_car('gravelDeep', dt)
    reach_speed(c, 80, dt)
    v0 = abs(c.vL[2])
    run(c, dt, 1.0, lambda c, t: c.C.update(throttle=0.0, brake=0.0, steer=0.0))
    return dict(decel=round(v0 - abs(c.vL[2]), 2), gear=c.gear)


def main():
    quick = len(sys.argv) > 1 and sys.argv[1] == 'quick'
    if len(sys.argv) > 1 and sys.argv[1] == 'feel':
        for dt in (1/120, 1/60):
            print('---- dt 1/%d' % round(1/dt))
            print('T6  tarmac recovery', t6_recovery(dt))
            print('T7  tarmac power 100 steer .3', t7_t8('tarmac', dt))
            print('T8  gravel power 80 steer .3', t7_t8('gravel', dt))
            print('T10 awd gravel power steer .45', t10_t11(dt, 0.45, 'power'))
            print('T10 awd gravel power steer .60', t10_t11(dt, 0.60, 'power'))
            print('T11 awd gravel lift  steer .45', t10_t11(dt, 0.45, 'lift'))
            for s in ('tarmac', 'gravel', 'snow'): print('T12', s, t12_step(s, dt))
            print('T16 coast from 140', t16_gear(dt))
            print('T18 gravelDeep coast 80', t18_deep(dt))
        return
    DT = 1 / 120
    p = awd_wrc_params()
    c0 = new_car('tarmac', DT)
    print('== static check (awd_wrc, tarmac) after settle')
    print('  frontShare2 %.4f  loads F/R %.0f / %.0f N  ext %s  Fsusp %s  CG height %.3f m' % (
        c0.frontShare2, -c0.W[0].load, -c0.W[2].load, [round(w.ext, 3) for w in c0.W],
        [round(w.Fsusp) for w in c0.W], dot(c0.pos, c0.gn)))
    print('  shiftSpeeds', [round(x, 1) for x in c0.shiftSpeed])
    for dt, tag in ((DT, 'dt'), (2 * DT, '2dt')):
        print('\n==================== %s = 1/%d s ====================' % (tag, round(1 / dt)))
        for surf in (['tarmac'] if quick else ['tarmac', 'gravel', 'snow', 'snow_tt', 'gravelDeep']):
            print('T1/T2', surf, t1_accel(surf, dt, 40.0 if surf != 'tarmac' else 60.0))
        for surf in (['tarmac'] if quick else ['tarmac', 'gravel', 'snow', 'ice', 'snow_tt', 'ice_tt']):
            print('T3 ', surf, t3_brake(surf, dt))
        for surf in (['tarmac'] if quick else ['tarmac', 'gravel', 'snow', 'ice']):
            print('T3b', surf, t3b_coast(surf, dt))
        for surf in (['tarmac'] if quick else ['tarmac', 'gravel', 'snow', 'ice', 'ice_tt', 'snow_tt', 'ice_gt']):
            for vT in (60, 100):
                r = t4_lateral(surf, vT, dt)
                print('T4 ', surf, vT, 'best', r['best'])
                if surf in ('tarmac', 'gravel') and vT == 100:
                    print('      all (steer, a_lat g, a_lat_horiz g, yawrate, beta deg, kmh):', r['all'])
        print('T5  gravel hb', t5_handbrake('gravel', dt))
        print('T5  gravel no-hb', t5_handbrake('gravel', dt, use_hb=False, thr_after=0.0, hb_time=9))
        print('T5c gravel hb hold 1.5s', t5_handbrake('gravel', dt, hb_time=1.5))
        print('straight 100 tarmac (DEV-3 off)', straight_jitter('tarmac', 100, dt))
        print('straight 100 tarmac (DEV-3 on) ', straight_jitter('tarmac', 100, dt, dict(smoothYawFrictionSign=True)))
        print('standstill no input        ', standstill('tarmac', dt, dict(throttle=0, brake=0, handbrake=0, steer=0)))
        print('standstill brake held      ', standstill('tarmac', dt, dict(throttle=0, brake=1.0, handbrake=0, steer=0)))
        print('standstill brake 0.5 held  ', standstill('tarmac', dt, dict(throttle=0, brake=0.5, handbrake=0, steer=0)))
        print('standstill steer 1 only    ', standstill('tarmac', dt, dict(throttle=0, brake=0, handbrake=0, steer=1.0)))
        sl = (0.0, math.cos(math.atan(0.15)), math.sin(math.atan(0.15)))   # 15 % slope, nose uphill (+z rises)
        sl = normalize((0.0, 1.0, -0.15))
        print('slope 15%% no input         ', standstill('tarmac', dt, dict(throttle=0, brake=0, handbrake=0, steer=0), normal=sl))
        print('slope 15%% brake held       ', standstill('tarmac', dt, dict(throttle=0, brake=1.0, handbrake=0, steer=0), normal=sl))
        print('slope 15%% throttle 0.12    ', standstill('tarmac', dt, dict(throttle=0.12, brake=0, handbrake=0, steer=0), normal=sl))
        print('rollout from 3 km/h        ', rollout_stop('tarmac', dt))
        print('stop from 5 km/h brake 1.0 ', stopping('tarmac', dt, 5.0, 1.0))
        for v0, st, thr in ((0.5, 1.0, 0.0), (0.5, 1.0, 0.2), (1.0, 1.0, 0.15), (2.0, 1.0, 0.15), (0.3, 0.0, 0.0)):
            print('creep v0=%.1f m/s steer=%.1f thr=%.2f' % (v0, st, thr), creep('tarmac', dt, v0, st, thr))
            if not quick: print('   gravel', creep('gravel', dt, v0, st, thr))

if __name__ == '__main__':
    main()
