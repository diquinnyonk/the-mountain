import './ui/styles.css';
import { Game } from './game';

const game = new Game(document.getElementById('scene') as HTMLCanvasElement);
(window as unknown as { game: Game }).game = game;
game.boot().catch((e) => {
  console.error(e);
  document.getElementById('loading-text')!.textContent = `Failed to start: ${e}`;
});
