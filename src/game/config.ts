/** 120 Hz physics sub-step and the largest frame time we will ever simulate. */
export const SUB_DT = 1 / 120;
export const MAX_FRAME_DT = 0.05;

/** Live-tunable values exposed through the F1 panel. */
export const Tuning = {
  runSpeed: 10,
  gravity: 26,
  jumpSpeed: 9.5,
  grappleK: 45,
  grappleDamping: 5,
  reelSpeed: 16,
  droneSpeed: 15,
  timeScale: 1,
};

export const TuningRanges: Record<keyof typeof Tuning, [min: number, max: number, step: number]> = {
  runSpeed: [5, 18, 0.5],
  gravity: [10, 45, 1],
  jumpSpeed: [5, 15, 0.5],
  grappleK: [10, 120, 1],
  grappleDamping: [0, 20, 0.5],
  reelSpeed: [4, 30, 0.5],
  droneSpeed: [5, 28, 0.5],
  timeScale: [0.1, 1.5, 0.05],
};

export const PLAYER = {
  radius: 0.45,
  eye: 0.75,
  groundAccel: 80,
  groundDecel: 55,
  airAccel: 22,
  airMaxSpeed: 12,
  airDrag: 0.06,
  coyote: 0.12,
  jumpBuffer: 0.12,
  slideDrag: 1.2,
  slideMinSpeed: 6,
  wallRunMinSpeed: 7,
  wallRunMaxTime: 2.6,
  wallJumpLock: 0.3,
  wallJumpOut: 7.5,
  wallJumpUp: 9,
  grappleRange: 55,
  surfaceRange: 42,
  grappleCooldown: 0.25,
  minRope: 3,
  launchBoost: 6,
  launchLift: 5,
} as const;

export const FOV = { min: 75, max: 105, fastSpeed: 36, slowSpeed: 8 } as const;
export const WALL_ROLL_DEG = 12;
