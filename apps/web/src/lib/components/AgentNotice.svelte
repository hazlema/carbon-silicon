<script lang="ts">
  import { live } from '$lib/live.svelte';
  import { agentNoticeText, type AgentNoticeEvent } from '$lib/owners';

  let { notice }: { notice: AgentNoticeEvent } = $props();
</script>

<div class="notice panel" role="status">
  <p>{agentNoticeText(notice)}</p>
  <button class="btn quiet" type="button" onclick={() => live.dismissAgentNotice(notice.cursor)}>Dismiss</button>
</div>

<style>
  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.7rem 1rem;
    box-shadow: 0 1rem 2.5rem rgb(0 0 0 / 0.45);
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
