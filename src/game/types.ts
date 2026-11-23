export type ParentId = 'Grounded' | 'Airborne' | 'Grappling' | 'WallRunning';
export type LeafId = 'Idle' | 'Run' | 'Slide' | 'Jump' | 'Fall' | 'CoyoteTime' | 'Swing' | 'ReelIn' | 'LeftWall' | 'RightWall';

/** Stable numeric ids for the replay format. Append only. */
export const LEAF_IDS: readonly LeafId[] = ['Idle', 'Run', 'Slide', 'Jump', 'Fall', 'CoyoteTime', 'Swing', 'ReelIn', 'LeftWall', 'RightWall'];

/** Plain-data input snapshot. The simulation never touches the DOM. */
export interface InputState {
  moveX: number; // +right
  moveZ: number; // +forward
  yaw: number;
  pitch: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
  slideHeld: boolean;
  grapplePressed: boolean;
  grappleHeld: boolean;
  reelHeld: boolean;
}

export const emptyInput = (): InputState => ({
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jumpPressed: false,
  jumpHeld: false,
  slideHeld: false,
  grapplePressed: false,
  grappleHeld: false,
  reelHeld: false,
});

export type GameEvents = {
  JUMPED: { x: number; y: number; z: number };
  WALL_JUMPED: { x: number; y: number; z: number };
  LANDED: { impact: number };
  SLIDE_START: Record<string, never>;
  WALL_RUN_START: { side: -1 | 1 };
  GRAPPLE_FIRED: { hit: boolean };
  GRAPPLE_LATCHED: { x: number; y: number; z: number };
  GRAPPLE_RELEASED: { launched: boolean };
  BOOST_PAD: { x: number; y: number; z: number };
  CHECKPOINT: { index: number; timeMs: number; total: number };
  RUN_STARTED: Record<string, never>;
  RUN_FINISHED: { timeMs: number };
  EMP_CHARGE: { drone: number };
  EMP_PULSE: { drone: number };
  EMP_HIT: Record<string, never>;
  RESPAWN: { respawns: number };
};
