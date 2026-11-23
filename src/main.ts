import { Game } from './Game';

const canvas = document.getElementById('game');
const fx = document.getElementById('fx');
if (!(canvas instanceof HTMLCanvasElement) || !(fx instanceof HTMLCanvasElement)) throw new Error('Missing canvas elements');

const game = new Game(canvas, fx);
game.start();

// Keep hot-reload clean: tear down listeners, GPU resources and the RAF loop first.
if (import.meta.hot) import.meta.hot.dispose(() => game.dispose());

// Handy for poking at the sim from the devtools console.
(window as unknown as { game: Game }).game = game;
