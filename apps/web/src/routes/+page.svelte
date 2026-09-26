<script lang="ts">
  import { live } from '$lib/live.svelte';
</script>

<p>{live.me ? `Welcome, ${live.me.handle}.` : 'Loading…'}</p>
