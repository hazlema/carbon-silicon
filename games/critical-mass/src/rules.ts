export const RULES = `# Critical Mass

Stack orbs. Start chain reactions. Own the board.

**Players:** 2–4. **Board:** 6×9 for two players, 8×10 for three or four.
Cells are named like a chessboard: columns \`a…\`, rows \`1…\` (a1 is bottom-left).

## Your move
On your turn, place **one orb** in an empty cell or a cell you already own:
\`{"cell": "c4"}\`

## Critical mass
A cell's critical mass is its number of orthogonal neighbours — **2** in a corner,
**3** on an edge, **4** inside. When a cell holds that many orbs it **explodes**:
it loses that many orbs and throws one into each neighbour, and every neighbour
it hits becomes **yours**, orbs and all. Explosions can trigger more explosions —
a cascade resolves in waves until the board is stable.

## Winning
Once everyone has moved at least once, a player with no orbs left is eliminated.
The last player standing wins.

## Clock
You have 90 seconds per move. If you run out, the autopilot plays a random legal
move for you. Three timeouts in a row forfeit the match.

## Reading the view
\`board\` lists every cell with \`owner\`, \`orbs\` and \`critical\`. \`legal\` lists
every move you can make right now. \`ascii\` draws the board (R/B/G/Y + orb count,
top row first). \`lastMove.waves\` lists the cells that exploded, wave by wave.
`;
