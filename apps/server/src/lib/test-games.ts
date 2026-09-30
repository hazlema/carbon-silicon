import type { GameModule } from '@cs/game-api';
import { lightlineGame } from '@cs/lightline';

/** A machines-only game for tests of the MACHINES_ONLY doors, now that every shipped game admits humans. */
export const botline: GameModule<any> = { ...lightlineGame, meta: { ...lightlineGame.meta, id: 'botline', name: 'Botline', humans: false } };
