import type {CheckersCommand} from '@cs/checkers';
import {applyMove, type Game, type Move} from '@cs/checkers/rules';

/** Local selection only. The host remains authoritative until a whole turn is submitted. */
export class TurnSelection {
  path: string[] = [];
  private commands: CheckersCommand[] = [];
  private interactive = false;
  private signature = '';
  get selected(): string | null { return this.path.at(-1) ?? null; }
  reset() { this.path = []; }
  update(commands: CheckersCommand[], interactive: boolean, revision: number) {
    const signature = JSON.stringify([commands, interactive, revision]);
    if (signature !== this.signature) this.reset();
    this.signature = signature;
    this.commands = commands;
    this.interactive = interactive;
  }
  private candidates() {
    return this.commands.filter(command => this.path.every((square, i) => command.steps[i] === square));
  }
  hints(): Move[] {
    if (!this.interactive) return [];
    const index = Math.max(0, this.path.length - 1);
    const unique = new Map<string, Move>();
    for (const command of this.candidates()) {
      if (command.steps[index + 1]) {
        const move = {from: command.steps[index], to: command.steps[index + 1]};
        unique.set(`${move.from}:${move.to}`, move);
      }
    }
    return [...unique.values()];
  }
  choose(square: string): CheckersCommand | null {
    if (!this.interactive) return null;
    if (this.path.length && this.hints().some(move => move.to === square)) {
      this.path.push(square);
      return this.candidates().find(command => command.steps.length === this.path.length) ?? null;
    }
    this.path = this.commands.some(command => command.steps[0] === square) && this.selected !== square ? [square] : [];
    return null;
  }
  preview(game: Game): Game {
    let preview = game;
    for (let i = 1; i < this.path.length; i++) preview = applyMove(preview, this.path[i - 1], this.path[i]);
    return preview;
  }
}
