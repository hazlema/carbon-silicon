<script lang="ts">
  import { MINUTE_PRESETS } from '$lib/mod';

  let {
    title,
    submitLabel,
    minutes: needsMinutes = false,
    maxMinutes = null,
    allowPermanent = false,
    onSubmit,
    onCancel,
  }: {
    title: string;
    submitLabel: string;
    /** Ask how long (mute and suspend). */
    minutes?: boolean;
    /** Longest allowed length; null means no ceiling. */
    maxMinutes?: number | null;
    allowPermanent?: boolean;
    onSubmit: (v: { reason: string; minutes?: number }) => Promise<void>;
    onCancel: () => void;
  } = $props();

  const presets = $derived(MINUTE_PRESETS.filter((p) => maxMinutes === null || p.minutes <= maxMinutes));
  let minutes = $state(60);
  let permanent = $state(false);
  let reason = $state('');
  let busy = $state(false);
  let error = $state('');
  let reasonInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    reasonInput?.focus();
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    busy = true;
    try {
      await onSubmit({ reason: reason.trim(), ...(needsMinutes && !permanent ? { minutes } : {}) });
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<form class="action" onsubmit={submit} aria-label={title}>
  <p class="title">{title}</p>
  {#if needsMinutes}
    <fieldset>
      <legend>How long</legend>
      {#each presets as p (p.minutes)}
        <label class="pill"><input type="radio" name="length" value={p.minutes} bind:group={minutes} disabled={permanent} /> {p.label}</label>
      {/each}
      {#if allowPermanent}
        <label class="pill"><input type="checkbox" bind:checked={permanent} /> Permanent</label>
      {/if}
    </fieldset>
  {/if}
  <label class="reason">
    Reason
    <input bind:this={reasonInput} bind:value={reason} maxlength="300" required placeholder="Kept in the log; a sanction shows it to them" />
  </label>
  <div class="row">
    <button class="btn primary" type="submit" disabled={busy || !reason.trim()}>{submitLabel}</button>
    <button class="btn quiet" type="button" onclick={onCancel}>Cancel</button>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</form>

<style>
  .action {
    display: grid;
    gap: 0.6rem;
    margin-top: 0.8rem;
    padding: 0.9rem;
    border: 1px solid var(--lattice);
    border-radius: var(--r-control);
    background: var(--ink-deep);
  }
  .title {
    margin: 0;
    font-weight: 600;
  }
  fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    width: 100%;
    margin-bottom: 0.3rem;
    color: var(--fog);
    font-size: var(--step--1);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--lattice);
    border-radius: 999px;
    font-size: var(--step--1);
  }
  .reason {
    display: grid;
    gap: 0.3rem;
    font-size: var(--step--1);
    color: var(--fog);
  }
  .row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
</style>
