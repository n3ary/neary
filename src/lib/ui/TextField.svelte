<!-- Labeled native input. No headless lib needed — the native <input> already covers what we use. Outlined-style only. -->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from './cn';

  type Props = Omit<HTMLInputAttributes, 'class' | 'size'> & {
    label?: string;
    helperText?: string;
    error?: boolean;
    fullWidth?: boolean;
    class?: string;
  };

  let {
    label,
    helperText,
    error = false,
    fullWidth = false,
    class: className,
    id,
    value = $bindable<string | number | readonly string[] | null | undefined>(undefined),
    ...rest
  }: Props = $props();

  // Stable id for label↔input association without forcing the caller to pass one.
  const autoId = $props.id();
  const inputId = $derived(id ?? `tf-${autoId}`);
</script>

<div class={cn(fullWidth && 'w-full', className)}>
  {#if label}
    <label for={inputId} class="block text-sm font-medium mb-1 text-[color:var(--color-fg)]">
      {label}
    </label>
  {/if}
  <input
    id={inputId}
    {value}
    class={cn(
      'block w-full h-10 px-3 rounded-md border bg-[color:var(--color-surface)] text-[color:var(--color-fg)]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
      error
        ? 'border-[color:var(--color-danger)] focus-visible:ring-[color:var(--color-danger)]'
        : 'border-[color:var(--color-border)]',
    )}
    aria-invalid={error || undefined}
    {...rest}
  />
  {#if helperText}
    <p
      class={cn(
        'mt-1 text-xs',
        error ? 'text-[color:var(--color-danger)]' : 'text-[color:var(--color-fg-muted)]',
      )}
    >
      {helperText}
    </p>
  {/if}
</div>
