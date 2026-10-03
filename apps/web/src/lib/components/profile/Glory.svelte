<script lang="ts">
  import type { GameInfo, ProfileGlory, ProfileRecord } from '@cs/shared/protocol';
  import { titleText } from '$lib/glory';
  import { ordinal } from '$lib/leaderboard';
  import { gameName } from '$lib/profile';

  let { glory, record, games }: { glory: ProfileGlory; record: ProfileRecord; games: GameInfo[] } = $props();
  const nameOf = (id: string) => games.find((g) => g.id === id)?.name ?? gameName(id);
</script>

<section class="glory panel" aria-labelledby="glory-title">
  <h2 id="glory-title">Glory</h2>
  {#if glory.season.length > 0}
    <h3>This season</h3>
    <ul class="season">
      {#each glory.season as s (s.gameId)}
        <li>
          <span class="game">{nameOf(s.gameId)}</span>
          <span class="rank">{ordinal(s.row.rank)}</span>
          <span class="num">Elo {s.row.elo}</span>
          <span class="num pts">{s.row.points} pts</span>
          <span class="num wdl">{s.row.wins}–{s.row.draws}–{s.row.losses}</span>
        </li>
      {/each}
    </ul>
  {/if}
  <h3>All time</h3>
  <p class="all">{glory.matchesPlayed} {glory.matchesPlayed === 1 ? 'match' : 'matches'} played · {record.wins} {record.wins === 1 ? 'win' : 'wins'} against the {record.versus}</p>
  {#if glory.titles.length > 0}
    <ul class="titles">
      {#each glory.titles as t (t.season + t.gameId)}
        <li>{titleText(t, nameOf(t.gameId))}</li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .glory {
    padding: 1.1rem 1.25rem;
  }
  h2,
  h3 {
    margin: 0 0 0.6rem;
    font-size: var(--step--1);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fog);
  }
  h3 {
    margin-top: 0.9rem;
    color: var(--dust);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.4rem;
  }
  .season li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto auto;
    gap: 0.9rem;
    align-items: baseline;
  }
  .rank {
    color: var(--chalk);
    font-weight: 700;
  }
  .num {
    font-family: var(--font-silicon);
    color: var(--fog);
  }
  .all {
    margin: 0;
  }
  .titles {
    margin-top: 0.75rem;
  }
  .titles li {
    color: var(--chalk);
  }
  @media (max-width: 640px) {
    .season li {
      grid-template-columns: minmax(0, 1fr) auto auto;
    }
    .season li .pts,
    .season li .wdl {
      display: none;
    }
  }
</style>
